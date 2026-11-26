// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// A tiny world for the replay tests: one repository on a fake Forgejo with a few issues, the agent pull requests of those issues (branch
// ai/issue-<n>, head commit, commit status, labels, comments), the default branch, and a fake OpenHands whose conversations end when the test
// says so. Forgejo's side is modelled as far as the dispatcher reads and writes it; anything else answers 404, as a forge would. The world also
// builds the webhooks Forgejo would send, so that they can go through the real app.
import { createHmac } from 'node:crypto';

export const REPO = 'owner/hello';
const API = '/api/v1/repos/' + REPO;
const iso = (at) => new Date(at).toISOString();
const answer = (value, status = 200) => status >= 400
  ? { ok: false, status, json: async () => ({ message: 'HTTP ' + status }), text: async () => 'HTTP ' + status }
  : { ok: true, status, json: async () => value, text: async () => JSON.stringify(value) };
const repository = { full_name: REPO, clone_url: 'https://forge.example/' + REPO + '.git', html_url: 'https://forge.example/' + REPO, default_branch: 'main' };

export function createWorld(issueCount, clock) {
  const world = {
    issues: {}, pulls: {}, catalog: [], conversations: {}, started: [], writes: [], unknown: new Set(),
    statuses: {}, commitTimes: {}, branches: { main: 'main0000' }, outbox: [], shas: 0, comments: 0,
    // What happened to the pull requests, in order: pushes, labels on and off, merges. The invariants read it.
    history: []
  };
  for (let n = 1; n <= issueCount; n += 1) world.issues[n] = { number: n, state: 'open', labels: new Set(), comments: [] };
  const labelId = (name) => {
    let entry = world.catalog.find((label) => label.name === name);
    if (!entry) { entry = { id: world.catalog.length + 1, name }; world.catalog.push(entry); }
    return entry.id;
  };
  const labelsOf = (set) => [...set].map((name) => ({ id: labelId(name), name }));
  // A new commit: its time is now, and it has no status until CI reports one.
  const commit = (prefix) => {
    world.shas += 1;
    const sha = (prefix + world.shas.toString(16).padStart(8, '0') + '0'.repeat(40)).slice(0, 40);
    world.commitTimes[sha] = iso(clock());
    return sha;
  };
  world.commit = commit;

  const issueView = (issue) => ({ number: issue.number, state: issue.state, title: 'Issue ' + issue.number, body: 'B',
    html_url: 'https://forge.example/' + REPO + '/issues/' + issue.number, labels: labelsOf(issue.labels), user: { login: 'marcel' }, comments: issue.comments.length });
  const pullView = (pr) => ({ number: pr.number, state: pr.state, merged: pr.merged, mergeable: pr.state === 'open', title: pr.title, body: 'Closes #' + pr.issue,
    html_url: 'https://forge.example/' + REPO + '/pulls/' + pr.number, user: { login: 'openhands' }, labels: labelsOf(pr.labels),
    head: { ref: pr.branch, sha: pr.head, repo: { full_name: REPO } }, base: { ref: 'main', sha: pr.base, repo: repository },
    created_at: pr.created_at, updated_at: pr.updated_at, merged_at: pr.merged_at ?? null, merge_commit_sha: pr.merge_sha ?? null, comments: pr.comments.length });
  // Forgejo numbers issues and pull requests in one sequence: the pull request of issue n is 100 + n (a later one of the same issue 200 + n, ...).
  const thread = (number) => world.issues[number] ?? world.pulls[number];
  world.pullOf = (issue) => Object.values(world.pulls).find((pr) => pr.issue === issue && pr.state === 'open');

  // The agent of issue n pushes: the open pull request of its branch gets a new head, or a new one is opened.
  world.push = (issue, files = ['src/issue-' + issue + '.ts']) => {
    const sha = commit('a');
    world.branches['ai/issue-' + issue] = sha;
    let pr = world.pullOf(issue);
    if (!pr) {
      let number = 100 + issue;
      while (world.pulls[number]) number += 100;
      pr = world.pulls[number] = { number, issue, branch: 'ai/issue-' + issue, state: 'open', merged: false, title: 'WIP: Fix #' + issue,
        labels: new Set(), comments: [], created_at: iso(clock()), base: world.branches.main };
    }
    pr.head = sha;
    pr.files = files;
    pr.updated_at = iso(clock());
    world.history.push({ at: clock(), pr: pr.number, what: 'push', sha });
    return pr;
  };

  world.send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    if (u.host !== 'forge.example') {
      if (request.method === 'POST' && u.pathname === '/api/conversations') {
        const id = 'conv-' + (world.started.length + 1);
        world.started.push({ id, body, at: clock() });
        world.conversations[id] = 'running';
        return answer({ id }, 201);
      }
      const id = u.pathname.split('/').filter(Boolean)[2];
      if (request.method === 'GET' && world.conversations[id] && u.pathname.endsWith('/' + id)) return answer({ id, execution_status: world.conversations[id], metrics: null, tags: {} });
      if (request.method === 'GET' && world.conversations[id] && u.pathname.includes('/events/count')) return answer(1);
      if (request.method === 'GET' && world.conversations[id] && u.pathname.includes('/events')) return answer({ items: [] });
      if (world.conversations[id]) { world.writes.push(request.method + ' ' + u.pathname); return answer({}); }
      world.unknown.add(request.method + ' openhands ' + u.pathname);
      return answer({}, 404);
    }
    const path = u.pathname.replace(API, '');
    const get = request.method === 'GET';
    if (!get) world.writes.push(request.method + ' ' + path + (body?.body ? ' ' + body.body.slice(0, 80) : ''));
    if (u.pathname === '/api/v1/user') return answer({ login: 'forgehands' });
    let m;
    if ((m = /^\/issues\/(\d+)$/.exec(path))) {
      const item = thread(m[1]);
      if (!item) return answer({}, 404);
      if (request.method === 'PATCH' && body?.state) item.state = body.state;
      return answer(world.issues[m[1]] ? issueView(item) : { ...pullView(item), pull_request: { merged: item.merged } });
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
      const item = thread(m[1]);
      if (!item) return answer({}, 404);
      if (request.method === 'POST') { world.comments += 1; item.comments.push({ id: 5000 + world.comments, created_at: iso(clock()), user: { login: 'forgehands' }, body: body.body }); return answer({}); }
      return answer(item.comments);
    }
    if ((m = /^\/issues\/(\d+)\/labels$/.exec(path))) {
      const item = thread(m[1]);
      if (!item) return answer({}, 404);
      if (request.method === 'POST') for (const entry of body.labels) item.labels.add(typeof entry === 'number' ? world.catalog.find((label) => label.id === entry).name : entry);
      return answer(labelsOf(item.labels));
    }
    if ((m = /^\/issues\/(\d+)\/labels\/(\d+)$/.exec(path)) && request.method === 'DELETE') {
      thread(m[1])?.labels.delete(world.catalog.find((label) => label.id === Number(m[2]))?.name);
      return answer({});
    }
    if (path === '/labels') {
      if (request.method === 'POST') return answer(world.catalog.find((label) => label.id === labelId(body.name)));
      return answer(world.catalog);
    }
    if (/^\/issues\/(\d+)\/(dependencies|blocks)$/.test(path)) return answer([]);
    if (path === '/issues') return answer(Object.values(world.issues).filter((issue) => issue.state === (u.searchParams.get('state') || 'open')).map(issueView));
    if (path === '/pulls') {
      const state = u.searchParams.get('state') || 'open';
      return answer(Object.values(world.pulls).filter((pr) => state === 'all' || pr.state === state).map(pullView));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(path))) {
      const pr = world.pulls[m[1]];
      if (!pr) return answer({}, 404);
      if (request.method === 'PATCH') { if (body?.title) pr.title = body.title; if (body?.state) pr.state = body.state; }
      return answer(pullView(pr));
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(path))) return world.pulls[m[1]] ? answer(Number(u.searchParams.get('page') || 1) > 1 ? [] : world.pulls[m[1]].files.map((filename) => ({ filename, status: 'modified' }))) : answer({}, 404);
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(path))) return answer([]);
    // A merge moves the default branch to a merge commit, and Forgejo sends the push of it.
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(path)) && request.method === 'POST') {
      const pr = world.pulls[m[1]];
      if (!pr || pr.state !== 'open') return answer({}, 405);
      const sha = commit('m');
      Object.assign(pr, { state: 'closed', merged: true, merged_at: iso(clock()), merge_sha: sha });
      world.history.push({ at: clock(), pr: pr.number, what: 'merge', sha: pr.head, labels: [...pr.labels] });
      const before = world.branches.main;
      world.branches.main = sha;
      world.outbox.push(world.mainPush(before, sha, pr));
      return answer({});
    }
    // Updating a branch rebases it on the default branch: a new head without a status.
    if ((m = /^\/pulls\/(\d+)\/update$/.exec(path)) && request.method === 'POST') {
      const pr = world.pulls[m[1]];
      if (!pr || pr.state !== 'open') return answer({}, 404);
      pr.head = commit('u'); pr.base = world.branches.main; pr.updated_at = iso(clock());
      world.branches[pr.branch] = pr.head;
      return answer({});
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/status$/.exec(path))) {
      const state = world.statuses[m[1]];
      return answer(state ? { state, total_count: 1, statuses: [{ context: 'ci', status: state }] } : { state: 'pending', total_count: 0, statuses: [] });
    }
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(path))) return world.commitTimes[m[1]] ? answer({ sha: m[1], created: world.commitTimes[m[1]], parents: [] }) : answer({}, 404);
    if ((m = /^\/branches\/(.+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]);
      return world.branches[name] ? answer({ name, commit: { id: world.branches[name] } }) : answer({}, 404);
    }
    // The repository has CI: a workflow in .forgejo/workflows, so a commit without a status is waiting for CI, not a commit of a repository without it.
    if (path === '/contents/.forgejo/workflows') return answer([{ type: 'file', name: 'ci.yaml', path: '.forgejo/workflows/ci.yaml' }]);
    if (path.startsWith('/contents/')) return answer({}, 404);
    if ((m = /^\/compare\/(.+)$/.exec(path))) return answer({ commits: [{ sha: world.branches.main }], files: [{ filename: 'README.md' }], total_commits: 1 });
    world.unknown.add(request.method + ' ' + path.replace(/\d+/g, 'N').replace(/[0-9a-f]{40}/g, 'SHA'));
    return answer({}, 404);
  };

  // The webhooks Forgejo sends, as [event, payload].
  const sender = { login: 'marcel' };
  const issuePayload = (issue) => ({ ...issueView(issue), labels: labelsOf(issue.labels) });
  world.labelHook = (number) => ['issues', { action: 'label_updated', repository, sender, issue: issuePayload(world.issues[number]) }];
  world.closeHook = (number) => ['issues', { action: 'closed', repository, sender, issue: issuePayload(world.issues[number]) }];
  world.commentHook = (number, comment) => ['issue_comment', { action: 'created', repository, sender, issue: issuePayload(world.issues[number]), comment }];
  world.pullLabelHook = (pr) => ['pull_request', { action: 'label_updated', repository, sender, number: pr.number, pull_request: pullView(pr) }];
  world.ciHook = (pr, outcome) => ['action_run_' + outcome, { action: outcome, prior_status: 'running', repository, sender,
    run: { id: world.shas, workflow_id: 'ci.yaml', commit_sha: pr.head, event: 'pull_request', status: outcome, html_url: 'https://forge.example/' + REPO + '/actions/runs/' + world.shas,
      repository, trigger_user: { login: 'openhands' },
      event_payload: JSON.stringify({ action: 'synchronized', number: pr.number, pull_request: { number: pr.number, state: pr.state, merged: pr.merged, title: pr.title, body: 'Closes #' + pr.issue, head: { ref: pr.branch, sha: pr.head } } }) } }];
  world.mainPush = (before, after, pr) => ['push', { ref: 'refs/heads/main', before, after, repository, sender,
    commits: [{ id: after, message: 'Merge pull request #' + pr.number + ' from ' + pr.branch + '\n\nCloses #' + pr.issue }], head_commit: { id: after } }];
  return world;
}

// The webhook endpoint of the real app, signed as Forgejo signs it. Delivery ids are the world's: they stay unique across a restart of ForgeHands.
export function poster(world, url, secret) {
  return async ([event, payload]) => {
    world.deliveries = (world.deliveries ?? 0) + 1;
    const deliveries = world.deliveries;
    const raw = JSON.stringify(payload);
    const response = await fetch(url, { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': event, 'x-forgejo-delivery': 'd' + deliveries,
      'x-forgejo-signature': createHmac('sha256', secret).update(raw).digest('hex') } });
    return { code: response.status, status: (await response.json().catch(() => ({}))).status };
  };
}
