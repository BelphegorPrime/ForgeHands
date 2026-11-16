// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { Merger } from '../src/forgejo/merge.ts';
import { buildStatus, renderStatus } from '../src/server/status.ts';
import { loadConfig } from '../src/config.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const live = 'owner/live';
const dryRepo = 'owner/dry';
const quiet = { error() {} };
const API = '/api/v1/repos/' + dryRepo;
let dir; let clock;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: live + ',' + dryRepo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
  MERGE_POLICY: JSON.stringify({ [dryRepo]: { deny: [] }, [live]: { deny: [] } }),
  FORGEJO_TOKEN: 'tok', FORGEJO_URL: 'https://forge.example',
  APPROVAL_GRACE_SECONDS: '0', ERROR_RETRIES: '0',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// One double for Forgejo and OpenHands: every call is recorded, and `strict` makes a write throw (the proof that none is sent).
function double({ strict }) {
  const calls = [];
  const verdict = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.ts line 12, check exit 0. '.repeat(8);
  const reads = {
    ['GET ' + API + '/pulls/34']: { state: 'open', merged: false, mergeable: true, title: 'Fix', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] },
    ['GET ' + API + '/commits/cafe0000cafe/status']: { state: 'success', total_count: 2 },
    ['GET ' + API + '/pulls/34/files']: [{ filename: 'README.md' }],
    ['GET ' + API + '/git/commits/cafe0000cafe']: { created: '2026-11-15T10:00:00Z' },
    ['GET ' + API + '/issues/34/comments']: [{ created_at: '2026-11-15T11:00:00Z', body: verdict }]
  };
  const send = async (url, request) => {
    const u = new URL(url);
    calls.push({ method: request.method, path: u.pathname, body: request.body });
    if (request.method !== 'GET' && strict) throw new Error('WRITE REACHED THE CLIENT: ' + request.method + ' ' + u.pathname);
    if (request.method !== 'GET') return { ok: true, status: 201, json: async () => ({ id: 'conv-1' }) };
    if (u.hostname === 'openhands') return { ok: true, status: 200, json: async () => ({}) };
    const value = reads['GET ' + u.pathname];
    if (value === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, send, writes: () => calls.filter((call) => call.method !== 'GET') };
}
const approved = (repository) => ({ repository: { full_name: repository }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 } });
const issue = (repository, number = 1) => ({
  type: 'issues.labeled', label: 'ai:ready',
  repository: { full_name: repository, clone_url: 'https://forge.example/' + repository + '.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: null, labels: ['ai:ready'] }, sender: { login: 'marcel' }
});

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-dry-')); clock = 1_000_000; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('DRY_RUN and DRY_RUN_REPOS are validated', () => {
  assert.equal(loadConfig(env()).dryRun, false);
  assert.equal(loadConfig(env({ DRY_RUN: '0' })).dryRun, false);
  assert.equal(loadConfig(env({ DRY_RUN: '1' })).dryRun, true);
  assert.deepEqual([...loadConfig(env({ DRY_RUN: '1', DRY_RUN_REPOS: 'Owner/Dry' })).dryRunRepos], [dryRepo]);
  assert.throws(() => loadConfig(env({ DRY_RUN: 'yes' })), /DRY_RUN must be 1 or 0/);
  assert.throws(() => loadConfig(env({ DRY_RUN_REPOS: dryRepo })), /needs DRY_RUN=1/);
  assert.throws(() => loadConfig(env({ DRY_RUN: '1', DRY_RUN_REPOS: 'other/repo' })), /not in ALLOWED_REPOS/);
});

test('dry merge: the decision is the live one, and no write reaches the client', async () => {
  const liveRun = double({ strict: false });
  const liveOutcome = await new Merger(loadConfig(env()), liveRun.send, quiet).handle(approved(dryRepo));
  assert.equal(liveOutcome, 'merged');
  assert.ok(liveRun.writes().length >= 2);

  const dry = double({ strict: true });
  const merger = new Merger(loadConfig(env({ DRY_RUN: '1' })), dry.send, quiet);
  assert.equal(await merger.handle(approved(dryRepo)), liveOutcome);
  assert.deepEqual(dry.writes(), []);
  assert.ok(dry.calls.length > 0, 'reads stay real');
  assert.deepEqual(merger.dry.writes.map((write) => write.method + ' ' + write.path), liveRun.writes().map((call) => call.method + ' ' + call.path.replace(API, '')));
});

test('dry run: a job is judged and scheduled, ends as dry with its prompt, and nothing is written anywhere', async () => {
  const dry = double({ strict: true });
  const config = loadConfig(env({ DRY_RUN: '1' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const dispatcher = new Dispatcher(config, jobs, dry.send, quiet, () => clock);
  assert.equal((await dispatcher.enqueue(issue(dryRepo))).status, 'queued');
  await dispatcher.tick();
  const [job] = jobs.list();
  assert.equal(job.status, 'dry');
  assert.match(job.dry_prompt, /UNTRUSTED_ISSUE_TEXT/);
  assert.equal(job.conversation_id, undefined);
  assert.deepEqual(dry.writes(), []);
  assert.deepEqual(jobs.list(true), [], 'a dry job is not active: no slot, no block');
  const status = buildStatus(config, jobs, clock, dispatcher.dry);
  assert.equal(status.limits.running, 0);
  assert.match(status.issues[0].state, /would start \(dry run\)/);
  assert.equal(status.dry_run.repositories, 'all');
  assert.match(renderStatus(status), /DRY RUN/);
});

test('dry run: a failure report and an archive write nothing', async () => {
  const dry = double({ strict: true });
  const config = loadConfig(env({ DRY_RUN: '1', ARCHIVE_AFTER_DAYS: '1' }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const dispatcher = new Dispatcher(config, jobs, dry.send, quiet, () => clock);
  const job = jobs.add({ key: dryRepo + '#1:ai:ready', label: 'ai:ready', event: issue(dryRepo), status: 'failed', created: 1, started: 1, finished: 1, conversation_id: 'c1' });
  await dispatcher.reportFailure(job, 'error');
  assert.equal(await dispatcher.archiveOld(clock + 10 * 86400000), false);
  assert.equal(job.archived, undefined);
  assert.deepEqual(dry.writes(), []);
  assert.equal(dispatcher.dry.writes.length, 1);
  // The lowest layer holds even for a call that names no repository.
  const response = await dispatcher.api('POST', '/api/conversations', { secrets: { X: 'y' } });
  assert.equal(response.status, 200);
  assert.deepEqual(dry.writes(), []);
  assert.doesNotMatch(JSON.stringify(dispatcher.dry.writes), /"X"/);
});

test('DRY_RUN_REPOS: the listed repository is dry, the other runs live', async () => {
  const both = double({ strict: false });
  const config = loadConfig(env({ DRY_RUN: '1', DRY_RUN_REPOS: dryRepo }));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  const dispatcher = new Dispatcher(config, jobs, both.send, quiet, () => clock);
  await dispatcher.enqueue(issue(dryRepo, 1));
  await dispatcher.enqueue(issue(live, 2));
  await dispatcher.tick();
  const byRepo = Object.fromEntries(jobs.list().map((job) => [job.event.repository.full_name, job]));
  assert.equal(byRepo[dryRepo].status, 'dry');
  assert.equal(byRepo[live].status, 'running');
  assert.deepEqual(both.writes().map((call) => call.method + ' ' + call.path), ['POST /api/conversations']);
  assert.deepEqual(buildStatus(config, jobs, clock, dispatcher.dry).dry_run.repositories, [dryRepo]);
});

test('dry run in webhook mode: the forward is logged, not sent', async () => {
  const config = loadConfig({
    FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough', OPENHANDS_WEBHOOK_SECRET: 'openhands-test-secret-long-enough',
    OPENHANDS_WEBHOOK_URL: 'http://127.0.0.1:9999/v1/events', ALLOWED_REPOS: live, DRY_RUN: '1', DATA_FILE: join(dir, 'deliveries.json')
  });
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const logged = [];
  const server = createApp(config, store, async () => { throw new Error('WRITE REACHED THE CLIENT'); }, { error: (...args) => logged.push(args.join(' ')) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify({ action: 'labeled', label: { name: 'ai:ready' }, repository: { full_name: live }, issue: { number: 3, title: 't', body: 'b', labels: [{ name: 'ai:ready' }] }, sender: { login: 'x' } }));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'issues', 'x-gitea-delivery': 'd1', 'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') }, body: raw });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'dry_run');
    assert.match(logged.join('\n'), /DRY RUN, not sent: POST OpenHands webhook/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
