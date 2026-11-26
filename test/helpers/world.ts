// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// A tiny world for the replay tests: one repository with a few issues on a fake Forgejo, and a fake OpenHands whose conversations end
// when the test says so. Only what the dispatcher reads for issue runs is modelled; anything else answers 404, as a forge would.
export const REPO = 'owner/hello';
const API = '/api/v1/repos/' + REPO;
const iso = (at) => new Date(at).toISOString();
const answer = (value, status = 200) => status >= 400 ? { ok: false, status, json: async () => ({}), text: async () => '' } : { ok: true, status, json: async () => value, text: async () => JSON.stringify(value) };

export function createWorld(issueCount, clock) {
  const world = {
    issues: {}, catalog: [], conversations: {}, started: [], writes: [], unknown: new Set(),
    send: null
  };
  for (let n = 1; n <= issueCount; n += 1) world.issues[n] = { number: n, state: 'open', labels: new Set(), comments: [] };
  const labelId = (name) => {
    let entry = world.catalog.find((label) => label.name === name);
    if (!entry) { entry = { id: world.catalog.length + 1, name }; world.catalog.push(entry); }
    return entry.id;
  };
  world.labelId = labelId;
  const view = (issue) => ({ number: issue.number, state: issue.state, title: 'Issue ' + issue.number, body: 'B',
    html_url: 'https://forge.example/' + REPO + '/issues/' + issue.number, labels: [...issue.labels].map((name) => ({ id: labelId(name), name })),
    user: { login: 'marcel' }, comments: issue.comments.length });

  world.send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    if (u.host !== 'forge.example') {
      if (request.method === 'POST' && u.pathname === '/api/conversations') {
        const id = 'conv-' + (world.started.length + 1);
        world.started.push({ id, body });
        world.conversations[id] = 'running';
        return answer({ id }, 201);
      }
      const id = u.pathname.split('/').filter(Boolean)[2];
      if (request.method === 'GET' && world.conversations[id]) return answer({ id, execution_status: world.conversations[id], metrics: null });
      if (world.conversations[id]) { world.writes.push(request.method + ' ' + u.pathname); return answer({}); }
      world.unknown.add(request.method + ' openhands ' + u.pathname);
      return answer({}, 404);
    }
    const path = u.pathname.replace(API, '');
    if (request.method !== 'GET') world.writes.push(request.method + ' ' + path + (body?.body ? ' ' + body.body : ''));
    const one = /^\/issues\/(\d+)$/.exec(path);
    if (one && request.method === 'GET') return world.issues[one[1]] ? answer(view(world.issues[one[1]])) : answer({}, 404);
    if (one && request.method === 'PATCH') {
      if (body?.state) world.issues[one[1]].state = body.state;
      return answer(view(world.issues[one[1]]));
    }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (comments) {
      const issue = world.issues[comments[1]];
      if (!issue) return answer({}, 404);
      if (request.method === 'POST') { issue.comments.push({ id: 1000 + issue.comments.length, created_at: iso(clock()), user: { login: 'forgehands' }, body: body.body }); return answer({}); }
      return answer(issue.comments);
    }
    const labels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (labels) {
      const issue = world.issues[labels[1]];
      if (!issue) return answer({}, 404);
      if (request.method === 'POST') for (const entry of body.labels) issue.labels.add(typeof entry === 'number' ? world.catalog.find((label) => label.id === entry).name : entry);
      return answer([...issue.labels].map((name) => ({ id: labelId(name), name })));
    }
    const removed = /^\/issues\/(\d+)\/labels\/(\d+)$/.exec(path);
    if (removed && request.method === 'DELETE') { world.issues[removed[1]]?.labels.delete(world.catalog.find((label) => label.id === Number(removed[2]))?.name); return answer({}); }
    if (path === '/labels') {
      if (request.method === 'POST') return answer(world.catalog.find((label) => label.id === labelId(body.name)));
      return answer(world.catalog);
    }
    if (/^\/issues\/(\d+)\/(dependencies|blocks)$/.test(path)) return answer([]);
    if (path === '/pulls' || path === '/issues') return answer(path === '/issues' ? Object.values(world.issues).filter((issue) => issue.state === 'open').map(view) : []);
    world.unknown.add(request.method + ' ' + path.replace(/\d+/g, 'N'));
    return answer({}, 404);
  };

  // The webhook event of an issue as normalizeEvent produces it.
  world.event = (type, number, extra = {}) => ({
    type, repository: { full_name: REPO, clone_url: 'https://forge.example/' + REPO + '.git', default_branch: 'main' },
    issue: { ...view(world.issues[number]), labels: [...world.issues[number].labels] }, sender: { login: 'marcel' }, ...extra
  });
  return world;
}
