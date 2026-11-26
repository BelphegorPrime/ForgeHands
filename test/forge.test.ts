// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { agentApi, createForge, createTransport } from '../src/forge/index.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const quiet = { error() {} };
let dir;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forge-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
  FORGE_URL: 'https://forge.example/',
  FORGE_TOKEN: 'tok-secret-value',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});
const event = (number) => ({
  type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'x', labels: ['ai:ready'] }, sender: { login: 'marcel' }
});

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-forge-')); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('FORGE defaults to forgejo, and an unsupported forge is refused with a clear message', () => {
  assert.equal(loadConfig(env()).forge, 'forgejo');
  assert.equal(loadConfig(env({ FORGE: 'Forgejo' })).forge, 'forgejo');
  assert.equal(loadConfig(env({ FORGE: 'gitea' })).forge, 'gitea');
  assert.throws(() => loadConfig(env({ FORGE: 'github' })), /FORGE must be forgejo, gitea or gitlab, not github/);
});

test('FORGE_URL, FORGE_TOKEN and FORGE_WEBHOOK_SECRET are the neutral names of the FORGEJO_* settings', () => {
  const neutral = loadConfig(env());
  assert.equal(neutral.forgejoSecret, 'forge-test-secret-long-enough');
  assert.deepEqual(neutral.forgejo, { url: 'https://forge.example', token: 'tok-secret-value' });
  const legacy = loadConfig(env({ FORGE_WEBHOOK_SECRET: undefined, FORGE_URL: undefined, FORGE_TOKEN: undefined,
    FORGEJO_WEBHOOK_SECRET: 'legacy-secret-long-enough', FORGEJO_URL: 'https://old.example', FORGEJO_TOKEN: 'old-token' }));
  assert.equal(legacy.forgejoSecret, 'legacy-secret-long-enough');
  assert.deepEqual(legacy.forgejo, { url: 'https://old.example', token: 'old-token' });
  // The same value under both names is fine.
  assert.equal(loadConfig(env({ FORGEJO_URL: 'https://forge.example/' })).forgejo.url, 'https://forge.example');
});

test('a neutral name and its FORGEJO_* alias with different values are an error, and the validation names the setting', () => {
  assert.throws(() => loadConfig(env({ FORGEJO_URL: 'https://other.example' })), /FORGE_URL and FORGEJO_URL are both set, with different values/);
  assert.throws(() => loadConfig(env({ FORGEJO_TOKEN: 'another' })), /FORGE_TOKEN and FORGEJO_TOKEN/);
  assert.throws(() => loadConfig(env({ FORGEJO_WEBHOOK_SECRET: 'another-secret-long-enough' })), /FORGE_WEBHOOK_SECRET and FORGEJO_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig(env({ FORGE_URL: 'ftp://x' })), /FORGE_URL/);
  assert.throws(() => loadConfig(env({ FORGE_WEBHOOK_SECRET: 'short' })), /at least 16/);
});

test('MERGE_POLICY and REMIND_AFTER_DAYS accept the neutral names', () => {
  assert.doesNotThrow(() => loadConfig(env({ MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['.forgejo/**'] } }) })));
  assert.throws(() => loadConfig(env({ FORGE_URL: undefined, FORGE_TOKEN: undefined, MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['x'] } }) })), /MERGE_POLICY needs/);
});

test('AGENT_SECRETS hands the neutral names to the agent under the names its prompt uses', () => {
  const config = loadConfig(env({ AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL' }));
  assert.deepEqual(config.agentSecrets, { FORGEJO_TOKEN: 'tok-secret-value', FORGEJO_URL: 'https://forge.example/' });
  const legacy = loadConfig(env({ FORGE_URL: undefined, FORGE_TOKEN: undefined, FORGEJO_URL: 'https://old.example', FORGEJO_TOKEN: 'old', AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL' }));
  assert.deepEqual(legacy.agentSecrets, { FORGEJO_TOKEN: 'old', FORGEJO_URL: 'https://old.example' });
  assert.throws(() => loadConfig(env({ FORGE_TOKEN: undefined, AGENT_SECRETS: 'FORGE_TOKEN' })), /AGENT_SECRETS names FORGE_TOKEN, but it is not set/);
});

test('the paths an agent calls come from the forge', () => {
  const api = agentApi({ forge: 'forgejo' }, repo);
  assert.equal(api.pullReviews(7), '$FORGEJO_URL/api/v1/repos/owner/hello/pulls/7/reviews');
  assert.equal(api.issueLabel(7, '<id>'), '$FORGEJO_URL/api/v1/repos/owner/hello/issues/7/labels/<id>');
  const prompt = buildPrompt(event(5), loadConfig(env()));
  assert.ok(prompt.includes(api.issueComments(5)));
  assert.ok(prompt.includes('the FORGEJO_TOKEN and FORGEJO_URL secrets'));
});

test('the Forgejo implementation turns operations into Forgejo API calls', async () => {
  const calls = [];
  const forge = createForge({ forge: 'forgejo' }, async (repository, method, path, body) => { calls.push([repository, method, path, body]); return method === 'GET' && path === '/labels?limit=100' ? [{ id: 3, name: 'ai:x' }] : { id: 9 }; });
  await forge.listPulls(repo, { state: 'open', limit: 50 });
  await forge.pullFiles(repo, 4, 50, 2);
  assert.equal(await forge.updateBranch(repo, 4), 'updated');
  await forge.mergePull(repo, 4, { method: 'squash', headSha: 'abc', deleteBranch: true });
  await forge.submitReview(repo, 4, 'request_changes', 'no', 'abc');
  await forge.listReviews(repo, 4);
  assert.deepEqual(await forge.findOrCreateLabel(repo, 'ai:x', '#fff'), { id: 3, name: 'ai:x' });
  assert.deepEqual(calls.map(([, method, path]) => method + ' ' + path), ['GET /pulls?state=open&limit=50', 'GET /pulls/4/files?limit=50&page=2', 'POST /pulls/4/update?style=rebase',
    'POST /pulls/4/merge', 'POST /pulls/4/reviews', 'GET /pulls/4/reviews', 'GET /labels?limit=100']);
  assert.deepEqual(calls[3][3], { Do: 'squash', head_commit_id: 'abc', delete_branch_after_merge: true });
  assert.deepEqual(calls[4][3], { event: 'REQUEST_CHANGES', body: 'no', commit_id: 'abc' });
  assert.equal(forge.isWip('WIP: x'), true);
  assert.equal(forge.stripWip('[WIP] x'), 'x');
  const conflicting = createForge({ forge: 'forgejo' }, async () => { throw new Error('POST /pulls/4/update?style=rebase -> HTTP 409'); });
  assert.equal(await conflicting.updateBranch(repo, 4), 'conflict');
  const broken = createForge({ forge: 'forgejo' }, async () => { throw new Error('POST /x -> HTTP 500'); });
  await assert.rejects(broken.updateBranch(repo, 4), /HTTP 500/);
});

test('the dry run stops a forge write below the interface: the transport logs it and sends nothing', async () => {
  const config = loadConfig(env({ DRY_RUN: '1' }));
  const sent = [];
  const writes = [];
  const dry = { record: (...args) => writes.push(args) };
  const forge = createForge(config, createTransport(config, async (url) => { sent.push(url); return { ok: true, status: 200, json: async () => [] }; }, dry));
  await forge.addComment(repo, 3, 'hello');
  await forge.listComments(repo, 3, 100);
  assert.equal(writes.length, 1);
  assert.equal(sent.length, 1, 'only the read went out');
});

// A forge that is not Forgejo: the dispatcher and the merger must work against the interface alone.
function fakeForge(state) {
  const calls = [];
  const forge = new Proxy({ kind: 'forgejo', calls }, {
    get: (target, name) => {
      if (name in target) return target[name];
      if (name === 'isWip') return (title) => /^draft:/i.test(title);
      if (name === 'stripWip') return (title) => title.replace(/^draft:\s*/i, '');
      return async (...args) => {
        calls.push(String(name) + '(' + args.slice(1).map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(', ') + ')');
        if (!(name in state)) throw new Error('unexpected forge call: ' + String(name));
        return typeof state[name] === 'function' ? state[name](...args) : state[name];
      };
    }
  });
  return forge;
}

test('a fake forge drives the dispatcher: dependencies hold a job back, a closed issue releases it', async () => {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const blocker = { number: 11, state: 'open' };
  const forge = fakeForge({ dependencies: () => (blocker.state === 'open' ? [blocker] : []), blocks: [{ number: 12, state: 'open', labels: [] }] });
  const send = async () => { throw new Error('nothing may go over HTTP: the forge is the fake'); };
  const dispatcher = new Dispatcher(config, jobs, send, quiet);
  dispatcher.forge = forge;
  dispatcher.api = async () => ({ ok: true, status: 200, json: async () => ({ id: 'c1' }) });
  assert.deepEqual(await dispatcher.enqueue(event(12)), { status: 'waiting' });
  assert.equal(jobs.list(true)[0].status, 'waiting');
  assert.deepEqual(jobs.list(true)[0].waiting_for, [11]);
  blocker.state = 'closed';
  assert.equal(await dispatcher.onClosed({ ...event(11), type: 'issues.closed' }), 'started #12');
  assert.equal(jobs.list(true)[0].status, 'queued');
  // The start is a pass of the dispatcher, which runs in the background after onClosed: wait for it.
  await dispatcher.tick();
  // The last read is the look the dispatcher takes before it starts a worker (dependencies added after queueing).
  assert.deepEqual(forge.calls, ['dependencies(12)', 'blocks(11)', 'dependencies(12)', 'dependencies(12)']);
});

test('a fake forge drives the merger: review comment, status, files and merge go through the interface', async () => {
  const config = loadConfig(env({ MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['.forgejo/**'] } }), APPROVAL_GRACE_SECONDS: '0' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, async () => { throw new Error('no HTTP'); }, quiet);
  const forge = fakeForge({
    getPull: { number: 34, state: 'open', merged: false, mergeable: true, title: 'Draft: Fix it', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ id: 1, name: 'ai:approved' }] },
    commitTime: '2026-11-15T10:00:00Z',
    listComments: [{ created_at: '2026-11-15T11:00:00Z', body: 'Verdict: OK ' + 'x'.repeat(400) }],
    commitStatus: { state: 'success', total_count: 1 },
    pullFiles: (repository, number, limit, page) => (page === 1 ? [{ filename: 'src/a.ts' }] : []),
    setPullTitle: undefined, mergePull: undefined, addComment: undefined, closeIssue: undefined
  });
  dispatcher.merger.forge = forge;
  const outcome = await dispatcher.approve({ ...event(26), type: 'pull_request.approved', pull_request: { number: 34, head_ref: 'ai/issue-26' } });
  assert.equal(outcome, 'merged');
  assert.ok(forge.calls.includes('setPullTitle(34, Fix it)'), 'the work in progress marker is the forge\'s: Draft: here');
  assert.ok(forge.calls.includes('mergePull(34, {"method":"merge","headSha":"cafe0000cafe","deleteBranch":true})'));
  assert.ok(forge.calls.includes('closeIssue(26)'));
});

test('deprecated settings still work and say once at start that they go in 1.0.0, with what to do instead', () => {
  const lines = [];
  const logger = { error: (...args) => lines.push(args.join(' ')) };
  const legacy = loadConfig(env({ FORGE_URL: undefined, FORGE_TOKEN: undefined, FORGEJO_URL: 'https://old.example', FORGEJO_TOKEN: 'old', AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL', HANDBACK_HANDLING: '0', HUMAN_REVIEW_ROUNDS: '0' }), logger);
  assert.equal(legacy.forgejo.url, 'https://old.example', 'the alias still works');
  assert.equal(legacy.handbackHandling, false, 'and so does the switch');
  assert.ok(lines.some((line) => /^warning: FORGEJO_URL is deprecated and will be removed in 1\.0\.0: set FORGE_URL instead/.test(line)));
  assert.ok(lines.some((line) => /^warning: FORGEJO_TOKEN is deprecated .*\(in AGENT_SECRETS too/.test(line)));
  assert.ok(lines.some((line) => /^warning: HANDBACK_HANDLING is deprecated/.test(line)));
  assert.ok(lines.some((line) => /^warning: HUMAN_REVIEW_ROUNDS is deprecated/.test(line)));
  const quiet = [];
  loadConfig(env(), { error: (...args) => quiet.push(args.join(' ')) });
  assert.deepEqual(quiet.filter((line) => /deprecated/.test(line)), [], 'the neutral names warn about nothing');
});
