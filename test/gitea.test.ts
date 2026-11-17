// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { agentApi, createForge } from '../src/forge/index.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const quiet = { error() {} };
const SECRET = 'gitea-test-secret-long-enough';
let dir;

const env = (extra = {}) => ({
  FORGE: 'gitea',
  FORGE_WEBHOOK_SECRET: SECRET,
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: WORKER, tier: 'free', on: 'pull_request' },
    'ci:failure': { profile: WORKER, tier: 'free', on: 'ci_failure' },
    'ci:success': { profile: WORKER, tier: 'free', on: 'ci_success' }
  }),
  FORGE_URL: 'https://gitea.example/',
  FORGE_TOKEN: 'tok-secret-value',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-gitea-')); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

// ---- fixtures: what each forge sends, shaped after the payload structs of Gitea (modules/structs) and captured Forgejo deliveries
const repository = { id: 7, full_name: repo, clone_url: 'https://gitea.example/owner/hello.git', html_url: 'https://gitea.example/owner/hello', default_branch: 'main' };
const sender = { login: 'marcel' };
const CI = { failure: 'ci:failure', success: 'ci:success' };
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

const giteaRun = (conclusion, { event = 'pull_request', ref = 'ai/issue-26', headRepo = 7, action = 'completed', number = 34 } = {}) => ({
  action,
  workflow: { name: 'ci', path: '.gitea/workflows/ci.yaml' },
  workflow_run: { id: 9, html_url: 'https://gitea.example/owner/hello/actions/runs/1', display_title: 'Fix it', path: 'ci.yaml@refs/pull/34/merge', event,
    run_attempt: 1, head_sha: SHA, head_branch: ref, status: 'completed', conclusion, trigger_actor: { login: 'marcel' },
    pull_requests: [{ id: 1, number, url: 'https://gitea.example/api/v1/repos/owner/hello/pulls/' + number, head: { ref, sha: SHA, repo: { id: headRepo, name: 'hello' } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 7, name: 'hello' } } }] },
  repository, sender
});
const forgejoRun = (status) => ({
  action: status, prior_status: 'running',
  run: { id: 9, workflow_id: 'ci.yaml', commit_sha: SHA, event: 'pull_request', status, html_url: 'https://gitea.example/owner/hello/actions/runs/1',
    repository, trigger_user: { login: 'marcel' },
    event_payload: JSON.stringify({ action: 'opened', number: 34, pull_request: { number: 34, state: 'open', merged: false, title: 'Fix it', body: 'Closes #26', head: { ref: 'ai/issue-26' } } }) }
});
const issueLabel = { action: 'label_updated', issue: { number: 26, title: 'T', body: 'B', html_url: 'x', labels: [{ id: 1, name: 'ai:ready' }] }, repository, sender };
const prLabel = { action: 'label_updated', number: 34, pull_request: { number: 34, state: 'open', merged: false, title: 'Fix it', body: 'b', html_url: 'u', head: { ref: 'ai/issue-26' }, labels: [{ name: 'ai:changes' }] }, repository, sender };
const closed = { action: 'closed', issue: { number: 26, title: 'T', html_url: 'x' }, repository, sender };
const push = { ref: 'refs/heads/main', after: SHA, repository, sender };

const normalize = async (kind, event, payload, extra = {}) => {
  const forge = createForge({ forge: kind }, async () => null);
  return forge.normalizeEvent(event, payload, new Set([repo]), ['ai:ready'], { labelEvents: true, prLabels: ['ai:changes'], ci: CI, pushes: true, ...extra });
};

test('FORGE=gitea is accepted and an unknown forge names the choices', () => {
  assert.equal(loadConfig(env()).forge, 'gitea');
  assert.equal(loadConfig(env({ FORGE: 'Gitea' })).forge, 'gitea');
  assert.throws(() => loadConfig(env({ FORGE: 'github' })), /FORGE must be forgejo, gitea or gitlab, not github/);
});

test('Gitea CI: a failed workflow_run becomes the same ci.failure event as a Forgejo action_run_failure', async () => {
  const gitea = await normalize('gitea', 'workflow_run', giteaRun('failure'));
  const forgejo = await normalize('forgejo', 'action_run_failure', forgejoRun('failure'));
  assert.equal(gitea.source, 'gitea');
  assert.equal(forgejo.source, 'forgejo');
  assert.equal(gitea.type, 'ci.failure');
  for (const key of ['type', 'action', 'label', 'repository', 'sender']) assert.deepEqual(gitea[key], forgejo[key], key);
  assert.equal(gitea.issue.number, 26);
  assert.deepEqual(gitea.pull_request, { number: 34, head_ref: 'ai/issue-26', html_url: 'https://gitea.example/owner/hello/pulls/34' });
  assert.deepEqual(gitea.ci, { run_id: 9, workflow: 'ci.yaml', commit_sha: SHA, status: 'failure', html_url: 'https://gitea.example/owner/hello/actions/runs/1' });
  assert.equal(forgejo.ci.commit_sha, SHA);
});

test('Gitea CI: a green workflow_run becomes ci.success, a push run of the pull request counts, and everything else is ignored', async () => {
  const ok = await normalize('gitea', 'workflow_run', giteaRun('success'));
  assert.equal(ok.type, 'ci.success');
  assert.equal(ok.label, 'ci:success');
  assert.equal((await normalize('gitea', 'workflow_run', giteaRun('failure', { event: 'push' }))).type, 'ci.failure');
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('cancelled')), null, 'cancelled is neither outcome');
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('skipped')), null);
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('failure', { action: 'in_progress' })), null, 'only a completed run');
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('failure', { event: 'schedule' })), null);
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('failure', { ref: 'feature/x' })), null, 'not an agent branch');
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('failure', { headRepo: 99 })), null, 'a fork branch named ai/issue-26 is not the agent');
  assert.equal(await normalize('gitea', 'workflow_run', giteaRun('failure'), { ci: { success: 'ci:success' } }), null, 'no route for failures');
  assert.equal(await normalize('gitea', 'workflow_run', { ...giteaRun('failure'), repository: { ...repository, full_name: 'other/repo' } }), null);
  assert.equal(await normalize('gitea', 'workflow_run', { ...giteaRun('failure'), workflow_run: { ...giteaRun('failure').workflow_run, head_sha: 'not a sha' } }), null);
  // Forgejo's event names are not Gitea's: on a Gitea forge they mean nothing.
  assert.equal(await normalize('gitea', 'action_run_failure', forgejoRun('failure')), null);
});

test('Gitea issue, pull request label, closed and push payloads normalize like Forgejo ones, tagged as Gitea', async () => {
  for (const [event, payload, type] of [['issues', issueLabel, 'issues.labeled'], ['pull_request', prLabel, 'pull_request.labeled'], ['issues', closed, 'issues.closed'], ['push', push, 'push.default']]) {
    const gitea = await normalize('gitea', event, payload);
    const forgejo = await normalize('forgejo', event, payload);
    assert.equal(gitea.type, type, event);
    assert.equal(gitea.source, 'gitea');
    assert.deepEqual({ ...gitea, source: 'forgejo' }, forgejo, event);
  }
  // Gitea never sends `labeled`, only label_updated; an unlabelled issue stays ignored.
  assert.equal(await normalize('gitea', 'issues', { ...issueLabel, issue: { ...issueLabel.issue, labels: [] } }), null);
});

test('the Gitea webhook: X-Gitea-Event and X-Gitea-Signature on /webhooks/gitea, nothing of Forgejo\'s headers', async () => {
  const config = loadConfig(env());
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const send = async () => ({ ok: true, status: 200, json: async () => ({ id: 'c1' }) });
  const dispatcher = new Dispatcher(config, jobs, send, quiet);
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (path, headers, body) => fetch('http://127.0.0.1:' + server.address().port + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  try {
    const raw = Buffer.from(JSON.stringify(issueLabel));
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    const ok = await post('/webhooks/gitea', { 'x-gitea-event': 'issues', 'x-gitea-delivery': 'g-1', 'x-gitea-signature': signature }, raw);
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).status, 'queued');
    assert.equal(jobs.list(true)[0].event.source, 'gitea');
    assert.equal((await post('/webhooks/gitea', { 'x-gitea-event': 'issues', 'x-gitea-signature': 'f'.repeat(64) }, raw)).status, 401);
    assert.equal((await post('/webhooks/gitea', { 'x-gitea-event': 'issues', 'x-forgejo-signature': signature }, raw)).status, 401, 'Forgejo\'s header is no signature here');
    assert.equal((await post('/webhooks/forgejo', { 'x-forgejo-event': 'issues', 'x-forgejo-signature': signature }, raw)).status, 404);
    const run = Buffer.from(JSON.stringify(giteaRun('failure')));
    const delivered = await post('/webhooks/gitea', { 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': 'g-2', 'x-gitea-signature': createHmac('sha256', SECRET).update(run).digest('hex') }, run);
    assert.equal(delivered.status, 202);
    // The issue's own run is still active, so the outcome waits ('deferred'); either way the job is in the ledger.
    assert.ok(['queued', 'deferred'].includes((await delivered.json()).status));
    assert.ok(jobs.list(true).some((job) => job.key.startsWith('owner/hello#26:ci:failure:abcdef01')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the Gitea implementation makes the same API calls as Forgejo, with the merge body Gitea expects', async () => {
  const calls = [];
  const forge = createForge({ forge: 'gitea' }, async (repository, method, path, body) => { calls.push([method, path, body]); return method === 'GET' && path === '/labels?limit=100' ? [] : { id: 5 }; });
  assert.equal(forge.kind, 'gitea');
  assert.equal(forge.webhookPath, '/webhooks/gitea');
  await forge.getPull(repo, 4);
  await forge.pullFiles(repo, 4, 50, 2);
  await forge.compare(repo, 'aaa', 'bbb');
  await forge.commitStatus(repo, 'abc');
  await forge.updateBranch(repo, 4);
  await forge.mergePull(repo, 4, { method: 'rebase-merge', headSha: 'abc', deleteBranch: false });
  await forge.dependencies(repo, 9);
  await forge.blocks(repo, 9);
  await forge.submitReview(repo, 4, 'approve', 'ok');
  assert.deepEqual(calls.map(([method, path]) => method + ' ' + path), ['GET /pulls/4', 'GET /pulls/4/files?limit=50&page=2', 'GET /compare/aaa...bbb', 'GET /commits/abc/status',
    'POST /pulls/4/update?style=rebase', 'POST /pulls/4/merge', 'GET /issues/9/dependencies', 'GET /issues/9/blocks', 'POST /pulls/4/reviews']);
  assert.deepEqual(calls[5][2], { Do: 'rebase-merge', head_commit_id: 'abc', delete_branch_after_merge: false });
  assert.deepEqual(calls[8][2], { event: 'APPROVED', body: 'ok' });
  const conflicting = createForge({ forge: 'gitea' }, async () => { throw new Error('POST /pulls/4/update?style=rebase -> HTTP 409'); });
  assert.equal(await conflicting.updateBranch(repo, 4), 'conflict');
  const forbidden = createForge({ forge: 'gitea' }, async () => { throw new Error('POST /pulls/4/update?style=rebase -> HTTP 403'); });
  await assert.rejects(forbidden.updateBranch(repo, 4), /HTTP 403/);
});

test('Gitea marks work in progress with WIP: or [WIP] in any case, as Forgejo does', () => {
  const forge = createForge({ forge: 'gitea' }, async () => null);
  for (const title of ['WIP: x', 'wip: x', '[WIP] x', '[wip]x']) assert.equal(forge.isWip(title), true, title);
  assert.equal(forge.isWip('Draft: x'), false);
  assert.equal(forge.isWip('Swipe: x'), false);
  assert.equal(forge.stripWip('WIP: Fix it'), 'Fix it');
  assert.equal(forge.stripWip('[WIP] Fix it'), 'Fix it');
});

test('prompts name Gitea, its workflow directory and the same API paths', () => {
  const api = agentApi({ forge: 'gitea' }, repo);
  assert.equal(api.name, 'Gitea');
  assert.equal(api.pullReviews(7), '$FORGEJO_URL/api/v1/repos/owner/hello/pulls/7/reviews');
  const failed = { ...normalizeSync(), };
  const prompt = buildPrompt(failed, loadConfig(env({ AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL' })));
  assert.ok(prompt.startsWith('Gitea '), prompt.slice(0, 40));
  assert.ok(prompt.includes('.gitea/workflows or .github/workflows'));
  assert.ok(!prompt.includes('Forgejo '), 'no Forgejo wording in a Gitea prompt');
  const forgejoPrompt = buildPrompt({ ...failed, source: 'forgejo' }, loadConfig(env({ FORGE: 'forgejo', AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL' })));
  assert.ok(forgejoPrompt.includes('.forgejo/workflows or .github/workflows'));
});

function normalizeSync() {
  const forge = createForge({ forge: 'gitea' }, async () => null);
  return forge.normalizeEvent('workflow_run', giteaRun('failure'), new Set([repo]), [], { ci: CI });
}

test('the hand-over comment names the forge it runs on', async () => {
  for (const [kind, name] of [['gitea', 'Gitea'], ['forgejo', 'Forgejo']]) {
    const config = loadConfig(env({ FORGE: kind, MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }) }));
    const jobs = new JobStore(join(dir, 'jobs-' + kind + '.json'));
    await jobs.load();
    const dispatcher = new Dispatcher(config, jobs, async () => ({ ok: true, status: 200, json: async () => ({}) }), quiet);
    dispatcher.merger.forge = createForge(config, async () => []);
    const policy = config.mergePolicy.get(repo);
    const text = await dispatcher.merger.handOverText(repo, 3, SHA, policy, ['compose.yaml'], true);
    assert.ok(text.includes(name + ' reports a conflict'), text);
  }
});

test('a run of a pull request that closed meanwhile is stale, since Gitea\'s run event does not say whether it is open', async () => {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, async () => ({ ok: true, status: 200, json: async () => ({}) }), quiet);
  const event = normalizeSync();
  const stale = async (pull) => { dispatcher.forge = { getPull: async () => pull }; return dispatcher.isStale(event); };
  assert.equal(await stale({ state: 'open', merged: false, head: { sha: SHA } }), false);
  assert.equal(await stale({ state: 'closed', merged: false, head: { sha: SHA } }), true);
  assert.equal(await stale({ state: 'closed', merged: true, head: { sha: SHA } }), true);
  assert.equal(await stale({ state: 'open', head: { sha: 'f'.repeat(40) } }), true);
});
