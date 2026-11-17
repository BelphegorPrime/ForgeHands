// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { agentApi, createForge, createTransport } from '../src/forge/index.ts';
import { GitlabForge } from '../src/forge/gitlab.ts';

const repo = 'group/sub/hello';
const allowed = new Set([repo]);
const WORKER = '22222222-2222-4222-8222-222222222222';
const env = (extra = {}) => ({
  FORGE: 'gitlab', FORGE_WEBHOOK_SECRET: 'gitlab-secret-long-enough', FORGE_URL: 'https://gitlab.example/', FORGE_TOKEN: 'glpat-secret',
  OPENHANDS_API_URL: 'http://openhands:8000/', OPENHANDS_API_KEY: 'k'.repeat(24), ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }), ...extra
});
const project = { id: 7, path_with_namespace: repo, web_url: 'https://gitlab.example/group/sub/hello', git_http_url: 'https://gitlab.example/group/sub/hello.git', default_branch: 'main' };
const user = { username: 'marcel' };

// Fixture payloads, shaped after docs.gitlab.com/user/project/integrations/webhook_events.
const issueHook = (action, extra = {}) => ({
  object_kind: 'issue', event_type: 'issue', user, project,
  object_attributes: { id: 1, iid: 12, title: 'Add x', description: 'Do x', state: 'opened', action, type: 'Issue', url: 'https://gitlab.example/group/sub/hello/-/issues/12' },
  labels: [{ id: 1, title: 'ai:ready' }, { id: 2, title: 'bug' }], ...extra
});
const mrHook = (extra = {}, attrs = {}) => ({
  object_kind: 'merge_request', event_type: 'merge_request', user, project,
  object_attributes: { iid: 4, action: 'update', state: 'opened', title: 'Add x', description: 'Closes #12', source_branch: 'ai/issue-12', target_branch: 'main', draft: false, url: 'https://gitlab.example/group/sub/hello/-/merge_requests/4', ...attrs },
  labels: [{ title: 'ai:approved' }], changes: { labels: { previous: [], current: [{ title: 'ai:approved' }] } }, ...extra
});
const pipelineHook = (status, extra = {}, mr = {}) => ({
  object_kind: 'pipeline', user, project,
  object_attributes: { id: 31, iid: 3, name: 'Build', ref: 'ai/issue-12', sha: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2', source: 'merge_request_event', status, url: 'https://gitlab.example/group/sub/hello/-/pipelines/31' },
  merge_request: { id: 99, iid: 4, title: 'Add x', source_branch: 'ai/issue-12', source_project_id: 7, target_project_id: 7, target_branch: 'main', state: 'opened', url: 'https://gitlab.example/group/sub/hello/-/merge_requests/4', ...mr },
  ...extra
});
const pushHook = (extra = {}) => ({ object_kind: 'push', ref: 'refs/heads/main', after: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7', user_username: 'marcel', project, ...extra });

const forge = createForge({ forge: 'gitlab' }, async () => null);
const norm = (event, payload, options = {}, labels = ['ai:ready']) => forge.normalizeEvent(event, payload, allowed, labels, options);

test('FORGE=gitlab is accepted and picks the GitLab implementation, webhook path and agent paths', () => {
  const config = loadConfig(env());
  assert.equal(config.forge, 'gitlab');
  assert.equal(createForge(config, async () => null).webhookPath, '/webhooks/gitlab');
  assert.equal(createForge(config, async () => null).kind, 'gitlab');
  assert.throws(() => loadConfig(env({ FORGE: 'github' })), /FORGE must be forgejo, gitea or gitlab/);
});

test('the GitLab webhook token is compared in constant time on hashes, and a missing, empty or wrong one is refused', () => {
  const secret = 'gitlab-secret-long-enough';
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-gitlab-token': secret }), true);
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-gitlab-token': secret + 'x' }), false);
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-gitlab-token': 'short' }), false);
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-gitlab-token': '' }), false);
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), {}), false);
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-gitlab-token': [secret] }), false);
  // A Forgejo style signature header means nothing here.
  assert.equal(forge.verifyWebhook(secret, Buffer.from('{}'), { 'x-forgejo-signature': 'a'.repeat(64) }), false);
});

test('the GitLab event name is X-Gitlab-Event and the delivery id is the idempotency key, else a hash', () => {
  assert.equal(forge.eventName({ 'x-gitlab-event': 'Pipeline Hook' }), 'Pipeline Hook');
  assert.equal(forge.deliveryId({ 'idempotency-key': 'abc-123' }, Buffer.from('x'), 'Push Hook'), 'abc-123');
  assert.equal(forge.deliveryId({ 'webhook-id': 'msg_1' }, Buffer.from('x'), 'Push Hook'), 'msg_1');
  assert.match(forge.deliveryId({ 'idempotency-key': 'bad key!' }, Buffer.from('x'), 'Push Hook'), /^[0-9a-f]{64}$/);
  assert.equal(forge.deliveryId({}, Buffer.from('x'), 'Push Hook'), forge.deliveryId({}, Buffer.from('x'), 'Push Hook'));
});

test('an Issue Hook with a trigger label opens a run, one without does not, and other projects are ignored', () => {
  const event = norm('Issue Hook', issueHook('open'));
  assert.equal(event.type, 'issues.opened');
  assert.equal(event.source, 'gitlab');
  assert.equal(event.label, 'ai:ready');
  assert.deepEqual(event.repository, { full_name: repo, clone_url: project.git_http_url, html_url: project.web_url, default_branch: 'main' });
  assert.deepEqual(event.issue, { number: 12, title: 'Add x', body: 'Do x', html_url: 'https://gitlab.example/group/sub/hello/-/issues/12', comments: 0, labels: ['ai:ready', 'bug'] });
  assert.equal(event.sender.login, 'marcel');
  assert.equal(norm('Issue Hook', issueHook('open', { labels: [{ title: 'bug' }] })), null);
  assert.equal(norm('Issue Hook', issueHook('open', { project: { ...project, path_with_namespace: 'other/repo' } })), null);
  assert.equal(norm('Issue Hook', issueHook('open', { object_attributes: { ...issueHook('open').object_attributes, type: 'Task' } })), null);
  assert.equal(norm('Issue Hook', issueHook('reopen')), null);
});

test('an Issue Hook update that adds a trigger label is a label event (direct) or the added label (webhook mode); a title edit is nothing', () => {
  const change = { changes: { labels: { previous: [{ title: 'ai:escalate' }], current: [{ title: 'ai:escalate' }, { title: 'ai:ready' }] } } };
  const direct = norm('Issue Hook', issueHook('update', change), { labelEvents: true }, ['ai:escalate', 'ai:ready']);
  assert.equal(direct.type, 'issues.labeled');
  assert.equal(direct.label_event, true);
  assert.equal(direct.label, 'ai:escalate', 'the first present trigger; the dispatcher compares with the labels it saw');
  const plain = norm('Issue Hook', issueHook('update', change), {}, ['ai:escalate', 'ai:ready']);
  assert.equal(plain.label, 'ai:ready');
  assert.equal(plain.label_event, undefined);
  assert.equal(norm('Issue Hook', issueHook('update', { changes: { title: { previous: 'a', current: 'b' } } }), { labelEvents: true }), null);
  assert.equal(norm('Issue Hook', issueHook('update', { changes: { labels: { previous: [{ title: 'ai:ready' }], current: [{ title: 'ai:ready' }] } } })), null);
});

test('an Issue Hook close becomes issues.closed', () => {
  const event = norm('Issue Hook', issueHook('close'));
  assert.equal(event.type, 'issues.closed');
  assert.equal(event.issue.number, 12);
  assert.equal(norm('Issue Hook', issueHook('close', { project: { ...project, path_with_namespace: 'x/y' } })), null);
});

test('a Merge Request Hook with a new approval or round label on an agent merge request is a pull request event', () => {
  const approved = norm('Merge Request Hook', mrHook(), { approved: 'ai:approved' });
  assert.equal(approved.type, 'pull_request.approved');
  assert.equal(approved.label, 'ai:approved');
  assert.equal(approved.label_event, true);
  assert.deepEqual(approved.pull_request, { number: 4, head_ref: 'ai/issue-12', html_url: 'https://gitlab.example/group/sub/hello/-/merge_requests/4' });
  assert.equal(approved.issue.number, 12);
  const round = norm('Merge Request Hook', mrHook({ labels: [{ title: 'ai:changes' }], changes: { labels: { previous: [], current: [{ title: 'ai:changes' }] } } }), { prLabels: ['ai:changes'] });
  assert.equal(round.type, 'pull_request.labeled');
  assert.equal(round.label, 'ai:changes');
});

test('a Merge Request Hook is ignored for another branch, a closed merge request, an approval that was already there, or no label change', () => {
  const options = { approved: 'ai:approved' };
  assert.equal(norm('Merge Request Hook', mrHook({}, { source_branch: 'feature/x' }), options), null);
  assert.equal(norm('Merge Request Hook', mrHook({}, { state: 'merged' }), options), null);
  assert.equal(norm('Merge Request Hook', mrHook({}, { action: 'open' }), options), null);
  assert.equal(norm('Merge Request Hook', mrHook({ changes: { labels: { previous: [{ title: 'ai:approved' }], current: [{ title: 'ai:approved' }] } } }), options), null);
  assert.equal(norm('Merge Request Hook', mrHook({ changes: { title: { previous: 'a', current: 'b' } } }), options), null);
  assert.equal(norm('Merge Request Hook', mrHook(), {}), null);
});

test('a failed or successful Pipeline Hook of a merge request becomes ci.failure or ci.success with the pipeline as the run', () => {
  const ci = { failure: 'ai:fix', success: 'ai:review' };
  const failed = norm('Pipeline Hook', pipelineHook('failed'), { ci });
  assert.equal(failed.type, 'ci.failure');
  assert.equal(failed.label, 'ai:fix');
  assert.deepEqual(failed.ci, { run_id: 31, workflow: 'Build', commit_sha: 'bcbb5ec396a2c0f828686f14fac9b80b780504f2', status: 'failure', html_url: 'https://gitlab.example/group/sub/hello/-/pipelines/31' });
  assert.deepEqual(failed.pull_request, { number: 4, head_ref: 'ai/issue-12', html_url: 'https://gitlab.example/group/sub/hello/-/merge_requests/4' });
  assert.equal(failed.issue.number, 12);
  const passed = norm('Pipeline Hook', pipelineHook('success'), { ci });
  assert.equal(passed.type, 'ci.success');
  assert.equal(passed.ci.status, 'success');
});

test('a Pipeline Hook that is not an outcome, has no merge request, is not handled or is for a fork starts nothing', () => {
  const ci = { failure: 'ai:fix', success: 'ai:review' };
  for (const status of ['canceled', 'skipped', 'running', 'pending', 'manual', 'created']) assert.equal(norm('Pipeline Hook', pipelineHook(status), { ci }), null, status);
  assert.equal(norm('Pipeline Hook', pipelineHook('failed', { merge_request: null }), { ci }), null);
  assert.equal(norm('Pipeline Hook', pipelineHook('failed'), { ci: { success: 'ai:review' } }), null);
  assert.equal(norm('Pipeline Hook', pipelineHook('failed', {}, { state: 'merged' }), { ci }), null);
  assert.equal(norm('Pipeline Hook', pipelineHook('failed', {}, { source_branch: 'feature/x' }), { ci }), null);
});

test('a dependency bot merge request is recognised from its pipeline (the pipeline user), a fork of the bot is not', () => {
  const ci = { failure: 'ai:fix', success: 'ai:review' };
  const bots = { authors: new Set(['renovate']), prefixes: ['renovate/'], fixRounds: 0 };
  const hook = (extra, mr) => pipelineHook('success', { user: { username: 'renovate' }, ...extra }, { source_branch: 'renovate/lodash', ...mr });
  const event = norm('Pipeline Hook', hook(), { ci, bots });
  assert.equal(event.bot, true);
  assert.equal(event.issue.number, 4);
  assert.equal(norm('Pipeline Hook', hook({}, { source_project_id: 8 }), { ci, bots }), null);
  assert.equal(norm('Pipeline Hook', { ...hook(), object_attributes: { ...hook().object_attributes, status: 'failed' } }, { ci, bots }), null, 'a red bot commit needs BOT_FIX_ROUNDS');
});

test('a Push Hook to the default branch is a push event; other branches, deletions and unwanted pushes are not', () => {
  const event = norm('Push Hook', pushHook(), { pushes: true });
  assert.equal(event.type, 'push.default');
  assert.equal(event.after, 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7');
  assert.equal(event.sender.login, 'marcel');
  assert.equal(norm('Push Hook', pushHook(), {}), null);
  assert.equal(norm('Push Hook', pushHook({ ref: 'refs/heads/feature' }), { pushes: true }), null);
  assert.equal(norm('Push Hook', pushHook({ after: '0'.repeat(40) }), { pushes: true }), null);
  assert.equal(norm('Note Hook', pushHook(), { pushes: true }), null);
});

// A recording transport: answers from a table keyed by "METHOD path".
function recorder(answers = {}) {
  const calls = [];
  const call = async (repository, method, path, body) => {
    calls.push([method, path, body]);
    const answer = answers[method + ' ' + path];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer === undefined ? { id: 1 } : answer;
  };
  return { calls, call };
}
const mr = { iid: 4, title: 'Draft: Add x', description: 'text', state: 'opened', sha: 'abc', source_branch: 'ai/issue-12', target_branch: 'main', source_project_id: 7, target_project_id: 7, author: { username: 'renovate' }, labels: ['ai:approved'], web_url: 'u', updated_at: '2026-01-01T00:00:00Z', has_conflicts: false, diff_refs: { base_sha: 'b0', head_sha: 'abc', start_sha: 's0' } };

test('a merge request is read as a pull request: iid as number, state, labels by name, merge base, conflict', async () => {
  const { call } = recorder({ 'GET /merge_requests/4': mr });
  const pull = await new GitlabForge(call).getPull(repo, 4);
  assert.equal(pull.number, 4);
  assert.equal(pull.state, 'open');
  assert.equal(pull.merged, false);
  assert.equal(pull.mergeable, undefined);
  assert.equal(pull.merge_base, 'b0');
  assert.equal(pull.head.sha, 'abc');
  assert.equal(pull.head.repo.full_name, repo);
  assert.equal(pull.user.login, 'renovate');
  assert.deepEqual(pull.labels, [{ id: 'ai:approved', name: 'ai:approved' }]);
  const conflicting = new GitlabForge(recorder({ 'GET /merge_requests/4': { ...mr, has_conflicts: true, state: 'merged' } }).call);
  const read = await conflicting.getPull(repo, 4);
  assert.equal(read.mergeable, false);
  assert.equal(read.merged, true);
  assert.equal(read.state, 'closed');
  const fork = await new GitlabForge(recorder({ 'GET /merge_requests/4': { ...mr, source_project_id: 9 } }).call).getPull(repo, 4);
  assert.equal(fork.head.repo.full_name, 'fork:9');
});

test('the draft marker is Draft:, [Draft] or (Draft), not WIP:', () => {
  const gitlab = new GitlabForge(async () => null);
  for (const title of ['Draft: x', '[Draft] x', '(draft) x']) { assert.equal(gitlab.isWip(title), true, title); assert.equal(gitlab.stripWip(title), 'x'); }
  assert.equal(gitlab.isWip('WIP: x'), false);
  assert.equal(gitlab.isWip('Drafting x'), false);
});

test('listing merge requests maps the states, and closed includes merged, newest first', async () => {
  const { calls, call } = recorder({
    'GET /merge_requests?state=closed&order_by=updated_at&sort=desc&per_page=20': [{ ...mr, iid: 1, state: 'closed', updated_at: '2026-01-01T00:00:00Z' }],
    'GET /merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=20': [{ ...mr, iid: 2, state: 'merged', updated_at: '2026-02-01T00:00:00Z' }]
  });
  const pulls = await new GitlabForge(call).listPulls(repo, { state: 'closed', sort: 'recentupdate', limit: 20 });
  assert.deepEqual(pulls.map((pull) => [pull.number, pull.merged]), [[2, true], [1, false]]);
  assert.equal(calls.length, 2);
  const open = recorder({});
  await new GitlabForge(open.call).listPulls(repo, { state: 'open', limit: 50 });
  assert.equal(open.calls[0][1], '/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50');
});

test('files of a merge request come from /diffs (renames with both names) and a compare from /repository/compare', async () => {
  const diffs = [{ old_path: 'a.ts', new_path: 'a.ts' }, { old_path: 'old.ts', new_path: 'new.ts', renamed_file: true }];
  const { calls, call } = recorder({ 'GET /merge_requests/4/diffs?per_page=100&page=2': diffs, 'GET /repository/compare?from=b0&to=tip': { commits: [{}, {}], diffs } });
  const gitlab = new GitlabForge(call);
  assert.deepEqual(await gitlab.pullFiles(repo, 4, 500, 2), [{ filename: 'a.ts' }, { filename: 'new.ts', previous_filename: 'old.ts' }]);
  assert.deepEqual(await gitlab.compare(repo, 'b0', 'tip'), { total_commits: 2, files: [{ filename: 'a.ts' }, { filename: 'new.ts', previous_filename: 'old.ts' }] });
  assert.equal(calls.length, 2);
});

test('merging is bound to the head sha, asks for squash only for the squash method and removes the branch', async () => {
  const { calls, call } = recorder();
  const gitlab = new GitlabForge(call);
  await gitlab.mergePull(repo, 4, { method: 'squash', headSha: 'abc', deleteBranch: true });
  await gitlab.mergePull(repo, 4, { method: 'merge', headSha: 'abc', deleteBranch: false });
  assert.deepEqual(calls[0], ['PUT', '/merge_requests/4/merge', { sha: 'abc', squash: true, should_remove_source_branch: true }]);
  assert.deepEqual(calls[1][2], { sha: 'abc', squash: false, should_remove_source_branch: false });
  await gitlab.setPullTitle(repo, 4, 'Add x');
  assert.deepEqual(calls[2], ['PUT', '/merge_requests/4', { title: 'Add x' }]);
  const refused = new GitlabForge(async () => { throw new Error('PUT /merge_requests/4/merge -> HTTP 409'); });
  await assert.rejects(refused.mergePull(repo, 4, { method: 'merge', headSha: 'abc', deleteBranch: true }), /HTTP 409/);
});

test('the asynchronous rebase is polled until it ends: merge_error means conflict, none means updated, a stuck one throws', async () => {
  const run = async (states, options = {}) => {
    const queue = [...states];
    const { calls, call } = recorder({ 'PUT /merge_requests/4/rebase': { rebase_in_progress: true }, 'GET /merge_requests/4?include_rebase_in_progress=true': () => queue.shift() });
    const waits = [];
    const gitlab = new GitlabForge(call, { sleep: async (ms) => { waits.push(ms); }, pollMs: 5, maxPolls: 3, ...options });
    return { gitlab, calls, waits };
  };
  let { gitlab, waits, calls } = await run([{ rebase_in_progress: true }, { rebase_in_progress: false, merge_error: null }]);
  assert.equal(await gitlab.updateBranch(repo, 4), 'updated');
  assert.deepEqual(waits, [5, 5]);
  assert.equal(calls[0][0] + ' ' + calls[0][1], 'PUT /merge_requests/4/rebase');
  ({ gitlab } = await run([{ rebase_in_progress: false, merge_error: 'Rebase failed. Please rebase locally' }]));
  assert.equal(await gitlab.updateBranch(repo, 4), 'conflict');
  ({ gitlab } = await run([{ rebase_in_progress: true }, { rebase_in_progress: true }, { rebase_in_progress: true }]));
  await assert.rejects(gitlab.updateBranch(repo, 4), /still in progress/);
  const forbidden = new GitlabForge(async () => { throw new Error('PUT /merge_requests/4/rebase -> HTTP 403'); });
  await assert.rejects(forbidden.updateBranch(repo, 4), /HTTP 403/);
});

test('the pipelines of a commit become one status: red wins, running holds, newest rerun counts, cancelled and skipped are silent', async () => {
  const status = async (list) => new GitlabForge(recorder({ 'GET /pipelines?sha=abc&order_by=id&sort=desc&per_page=100': list }).call).commitStatus(repo, 'abc');
  const p = (id, st, source = 'merge_request_event', ref = 'r') => ({ id, status: st, source, ref });
  assert.deepEqual(await status([p(2, 'success')]), { state: 'success', total_count: 1 });
  assert.deepEqual(await status([p(3, 'success'), p(2, 'failed')]), { state: 'success', total_count: 1 });
  assert.deepEqual(await status([p(3, 'success'), p(2, 'failed', 'push')]), { state: 'failure', total_count: 2 });
  assert.deepEqual(await status([p(3, 'running'), p(2, 'success', 'push')]), { state: 'pending', total_count: 2 });
  assert.deepEqual(await status([p(3, 'manual')]), { state: 'pending', total_count: 1 });
  assert.deepEqual(await status([p(3, 'canceled'), p(2, 'skipped', 'push')]), { state: 'pending', total_count: 0 });
  assert.deepEqual(await status([]), { state: 'pending', total_count: 0 });
});

test('commit time and branch tip come from the repository endpoints', async () => {
  const gitlab = new GitlabForge(recorder({ 'GET /repository/commits/abc': { created_at: '2026-01-01T00:00:00Z' }, 'GET /repository/branches/ai%2Fissue-12': { commit: { id: 'tip' } } }).call);
  assert.equal(await gitlab.commitTime(repo, 'abc'), '2026-01-01T00:00:00Z');
  assert.equal(await gitlab.branchTip(repo, 'ai/issue-12'), 'tip');
});

test('issues and their links: blocks and is_blocked_by, only issues of this project, and no Premium means no dependencies', async () => {
  const links = [
    { iid: 3, project_id: 7, state: 'opened', title: 'A', link_type: 'is_blocked_by' },
    { iid: 9, project_id: 99, state: 'opened', title: 'other project', link_type: 'is_blocked_by' },
    { iid: 5, project_id: 7, state: 'closed', title: 'B', link_type: 'blocks' },
    { iid: 6, project_id: 7, state: 'opened', title: 'C', link_type: 'relates_to' }
  ];
  const { calls, call } = recorder({ 'GET /issues/12/links': links, 'GET ': { id: 7 } });
  const gitlab = new GitlabForge(call);
  assert.deepEqual((await gitlab.dependencies(repo, 12)).map((issue) => [issue.number, issue.state]), [[3, 'open']]);
  assert.deepEqual((await gitlab.blocks(repo, 12)).map((issue) => [issue.number, issue.state]), [[5, 'closed']]);
  assert.equal(calls.filter(([, path]) => path === '').length, 1, 'the project id is looked up once');
  for (const code of [402, 403, 404]) assert.deepEqual(await new GitlabForge(async () => { throw new Error('GET /issues/12/links -> HTTP ' + code); }).dependencies(repo, 12), []);
  await assert.rejects(new GitlabForge(async () => { throw new Error('GET /issues/12/links -> HTTP 500'); }).dependencies(repo, 12), /HTTP 500/);
  assert.deepEqual(await new GitlabForge(recorder({ 'GET /issues/12/links': [] }).call).blocks(repo, 12), []);
  const issue = await new GitlabForge(recorder({ 'GET /issues/12': { iid: 12, state: 'opened', title: 'T', labels: ['ai:ready'], web_url: 'w', user_notes_count: 2 } }).call).getIssue(repo, 12);
  assert.deepEqual([issue.number, issue.state, issue.comments, issue.labels[0].name], [12, 'open', 2, 'ai:ready']);
});

test('closing an issue and the notes of an issue or a merge request go to different resources', async () => {
  const notes = [{ created_at: 'a', body: 'one', author: { username: 'bot' }, system: false }, { created_at: 'b', body: 'added label', author: { username: 'bot' }, system: true }];
  const { calls, call } = recorder({ 'GET /merge_requests/4/notes?sort=asc&order_by=created_at&per_page=100': notes });
  const gitlab = new GitlabForge(call);
  await gitlab.closeIssue(repo, 12);
  assert.deepEqual(calls[0], ['PUT', '/issues/12', { state_event: 'close' }]);
  assert.deepEqual(await gitlab.listComments(repo, 4, 200), [{ created_at: 'a', body: 'one', user: { login: 'bot' } }]);
  await gitlab.addComment(repo, 4, 'hi');
  await gitlab.addComment(repo, 12, 'hi', 'issue');
  assert.deepEqual(calls.slice(2).map(([method, path]) => method + ' ' + path), ['POST /merge_requests/4/notes', 'POST /issues/12/notes']);
});

test('labels are handled by name: found or created, added and removed with add_labels and remove_labels; ai:x with one colon is no scoped label', async () => {
  const { calls, call } = recorder({ 'GET /labels?per_page=100&search=ai%3Aapproved': [{ name: 'ai:approved' }], 'GET /labels?per_page=100&search=ai%3Ablocked': [], 'GET /merge_requests/4': mr, 'GET /issues/12': { labels: ['ai:ready'] } });
  const gitlab = new GitlabForge(call);
  assert.deepEqual(await gitlab.findOrCreateLabel(repo, 'ai:approved', '#cccccc'), { id: 'ai:approved', name: 'ai:approved' });
  assert.deepEqual(await gitlab.findOrCreateLabel(repo, 'ai:blocked', 'b60205'), { id: 'ai:blocked', name: 'ai:blocked' });
  assert.deepEqual(calls.at(-1), ['POST', '/labels', { name: 'ai:blocked', color: '#b60205' }]);
  assert.deepEqual(await gitlab.labelsOf(repo, 4), [{ id: 'ai:approved', name: 'ai:approved' }]);
  assert.deepEqual(await gitlab.labelsOf(repo, 12, 'issue'), [{ id: 'ai:ready', name: 'ai:ready' }]);
  await gitlab.addLabels(repo, 4, [{ id: 'ai:blocked', name: 'ai:blocked' }]);
  await gitlab.removeLabel(repo, 12, { id: 'ai:ready', name: 'ai:ready' }, 'issue');
  assert.deepEqual(calls.slice(-2), [['PUT', '/merge_requests/4', { add_labels: 'ai:blocked' }], ['PUT', '/issues/12', { remove_labels: 'ai:ready' }]]);
});

const SHA = 'a'.repeat(40);
const reviewEnv = () => env({
  VERDICT_SOURCE: 'review', AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,REVIEWER_TOKEN', REVIEWER_TOKEN: 'glpat-reviewer',
  LABEL_ROUTES: JSON.stringify({ 'ai:review': { profile: WORKER, tier: 'strong', on: 'ci_success', forgejo_token_secret: 'REVIEWER_TOKEN' } })
});
const NEW_SHA = 'b'.repeat(40);
const review = (id, user, text, sha, at) => ({ id, type: null, system: false, author: { id: id * 10, username: user }, body: text + '\n\nCommit: ' + sha, created_at: at });

test('reviews are read as native reviews: the verdict note names the commit, an OK counts only with the approval of its author, the newest per reviewer wins', async () => {
  const notes = [
    review(1, 'rev', '## Verdict: OK\nevidence', SHA, '2026-01-01T00:00:00Z'),
    review(2, 'other', '## Verdict: OK\nevidence', SHA, '2026-01-01T00:01:00Z'),
    review(3, 'rev', '## Verdict: NOT OK\nbroken', SHA, '2026-01-01T00:02:00Z'),
    { id: 4, system: true, author: { username: 'rev' }, body: '## Verdict: OK\n\nCommit: ' + SHA, created_at: 'x' },
    { id: 5, author: { username: 'rev' }, body: 'just chatting', created_at: 'y' },
    { id: 6, author: { username: 'rev' }, body: '## Verdict: OK without a commit', created_at: 'z' }
  ];
  const { call } = recorder({ 'GET /merge_requests/4/approvals': { approved_by: [{ user: { id: 5, username: 'rev' } }] }, 'GET /merge_requests/4/notes?sort=asc&order_by=created_at&per_page=100': notes });
  const reviews = await new GitlabForge(call).listReviews(repo, 4);
  // `other` said OK without approving: no review. `rev` approved and said OK, then said NOT OK: both are reviews, the Merger takes the newest.
  assert.deepEqual(reviews.map((r) => [r.id, r.user.login, r.state, r.commit_id]), [[1, 'rev', 'APPROVED', SHA], [3, 'rev', 'REQUEST_CHANGES', SHA]]);
  assert.ok(reviews[0].body.length > 10);
  assert.equal(reviews[0].submitted_at, '2026-01-01T00:00:00Z');
});

test('the Merger in review mode accepts a GitLab approval of the head commit and refuses one of an older commit', async () => {
  const { Merger } = await import('../src/forge/merge.ts');
  const make = (head) => {
    const notes = [review(1, 'rev', '## Verdict: OK\n' + 'evidence '.repeat(100), SHA, '2026-01-01T00:00:00Z')];
    const send = async (url) => ({ ok: true, status: 200, json: async () => url.includes('/approvals') ? { approved_by: [{ user: { username: 'rev' } }] } : notes });
    return new Merger(loadConfig(reviewEnv()), send, { error() {} }).reviewOf(repo, 4, head);
  };
  assert.deepEqual(await make(SHA), { ok: true });
  assert.equal((await make(NEW_SHA)).ok, false);
});

test('a GitLab review is submitted as a note that names the commit and, for approve, an approval pinned to it; request changes is the note alone', async () => {
  const { calls, call } = recorder();
  const gitlab = new GitlabForge(call);
  await gitlab.submitReview(repo, 4, 'approve', '## Verdict: OK\nlooks good', SHA);
  await gitlab.submitReview(repo, 4, 'request_changes', '## Verdict: NOT OK\nfix it', SHA);
  await gitlab.submitReview(repo, 4, 'approve', '', SHA);
  assert.deepEqual(calls.map(([method, path, body]) => method + ' ' + path + ' ' + JSON.stringify(body)), [
    'POST /merge_requests/4/notes ' + JSON.stringify({ body: '## Verdict: OK\nlooks good\n\nCommit: ' + SHA }), 'POST /merge_requests/4/approve {"sha":"' + SHA + '"}',
    'POST /merge_requests/4/notes ' + JSON.stringify({ body: '## Verdict: NOT OK\nfix it\n\nCommit: ' + SHA }),
    'POST /merge_requests/4/notes ' + JSON.stringify({ body: '\n\nCommit: ' + SHA }), 'POST /merge_requests/4/approve {"sha":"' + SHA + '"}'].slice(0, 5));
  const inline = recorder({ 'GET /merge_requests/4/notes?sort=asc&order_by=created_at&per_page=100': [{ id: 1, author: { id: 5 }, body: 'x' }, { id: 2, type: 'DiffNote', author: { id: 5, username: 'rev' }, body: 'nit', created_at: 'x' }, { id: 3, type: 'DiffNote', author: { id: 6 }, body: 'no' }] });
  assert.deepEqual(await new GitlabForge(inline.call).listReviewComments(repo, 4, 1), [{ created_at: 'x', body: 'nit', user: { login: 'rev' } }]);
});

test('a GitLab approval or withdrawn approval of an agent merge request triggers a look at the reviews; the payload is not believed', () => {
  const hook = (action, attrs = {}) => mrHook({ changes: {}, labels: [] }, { action, ...attrs });
  const approved = norm('Merge Request Hook', hook('approval'));
  assert.equal(approved.type, 'pull_request.review_approved');
  assert.equal(approved.pull_request.number, 4);
  assert.equal(approved.issue.number, 12);
  assert.equal(approved.sender.login, 'marcel');
  assert.equal(norm('Merge Request Hook', hook('unapproval')).type, 'pull_request.review_rejected');
  assert.equal(norm('Merge Request Hook', hook('approved')), null, 'the all-rules-met event comes with the last approval');
  assert.equal(norm('Merge Request Hook', hook('approval', { source_branch: 'feature/x' })), null);
  assert.equal(norm('Merge Request Hook', hook('approval', { state: 'merged' })), null);
});

test('the review prompt of a GitLab agent posts a note naming the commit and approves with the sha', () => {
  const config = loadConfig(reviewEnv());
  const event = { type: 'ci.success', label: 'ai:review', repository: { full_name: repo, clone_url: 'https://gitlab.example/group/sub/hello.git', default_branch: 'main' },
    issue: { number: 12, title: 'T', body: 'B', html_url: 'x', labels: [] }, pull_request: { number: 4, head_ref: 'ai/issue-12', html_url: 'y' }, ci: { commit_sha: SHA, workflow: 'Build', status: 'success' }, sender: { login: 'marcel' } };
  const prompt = buildPrompt(event, config);
  assert.ok(prompt.includes('/merge_requests/4/notes'));
  assert.ok(prompt.includes('/merge_requests/4/approve'));
  assert.ok(prompt.includes('Commit: ' + SHA));
  assert.ok(!prompt.includes('"commit_id"'));
});

test('the transport sends the PRIVATE-TOKEN to the encoded project path, counts nothing on success and throws with the status', async () => {
  const config = loadConfig(env());
  const sent = [];
  const send = async (url, init) => { sent.push([url, init.method, init.headers]); return { ok: true, status: 200, json: async () => [] }; };
  const gitlab = createForge(config, createTransport(config, send));
  await gitlab.listComments(repo, 4, 10);
  assert.equal(sent[0][0], 'https://gitlab.example/api/v4/projects/group%2Fsub%2Fhello/merge_requests/4/notes?sort=asc&order_by=created_at&per_page=10');
  assert.equal(sent[0][2]['private-token'], 'glpat-secret');
  assert.equal(sent[0][2].authorization, undefined);
  const failing = createForge(config, createTransport(config, async () => ({ ok: false, status: 404, json: async () => null })));
  await assert.rejects(failing.getPull(repo, 4), /GET \/merge_requests\/4 -> HTTP 404/);
});

test('the dry run stops a GitLab write below the interface', async () => {
  const config = loadConfig(env({ DRY_RUN: '1' }));
  const sent = [];
  const writes = [];
  const gitlab = createForge(config, createTransport(config, async (url) => { sent.push(url); return { ok: true, status: 200, json: async () => [] }; }, { record: (...args) => writes.push(args) }));
  await gitlab.addComment(repo, 4, 'hello');
  await gitlab.mergePull(repo, 4, { method: 'merge', headSha: 'abc', deleteBranch: true });
  assert.equal(await gitlab.updateBranch(repo, 4), 'updated');
  await gitlab.listComments(repo, 4, 10);
  assert.equal(writes.length, 3);
  assert.equal(sent.length, 1, 'only the read went out');
});

test('the agent gets GitLab paths: merge requests, notes, labels by name, PUT for labels and closing, and the token header', () => {
  const config = loadConfig(env());
  const api = agentApi(config, repo);
  assert.equal(api.pull(4), '$FORGEJO_URL/api/v4/projects/group%2Fsub%2Fhello/merge_requests/4');
  assert.equal(api.pullComments(4), '$FORGEJO_URL/api/v4/projects/group%2Fsub%2Fhello/merge_requests/4/notes');
  assert.equal(api.issueComments(12), '$FORGEJO_URL/api/v4/projects/group%2Fsub%2Fhello/issues/12/notes');
  assert.equal(api.pullLabel(4, 'ai:changes'), '$FORGEJO_URL/api/v4/projects/group%2Fsub%2Fhello/merge_requests/4?remove_labels=ai:changes');
  const event = { type: 'pull_request.labeled', label: 'ai:changes', repository: { full_name: repo, clone_url: 'https://gitlab.example/group/sub/hello.git', default_branch: 'main' },
    issue: { number: 12, title: 'T', body: 'B', html_url: 'x', labels: [] }, pull_request: { number: 4, head_ref: 'ai/issue-12', html_url: 'y' }, sender: { login: 'marcel' } };
  const prompt = buildPrompt(event, loadConfig(env({ LABEL_ROUTES: JSON.stringify({ 'ai:changes': { profile: WORKER, tier: 'free', on: 'pull_request' } }) })));
  assert.ok(prompt.includes('GitLab pull request #4'));
  assert.ok(prompt.includes('PRIVATE-TOKEN'));
  assert.ok(prompt.includes('PUT ' + api.pullLabel(4, '<id>')));
  assert.ok(!prompt.includes('DELETE'));
});
