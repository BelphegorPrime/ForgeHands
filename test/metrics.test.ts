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
import { Merger } from '../src/agent/merge.ts';
import { loadConfig } from '../src/config.ts';
import { metrics, known } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const PLANNER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'status-token-long-enough';
const repo = 'owner/hello';
const quiet = { error() {} };
let dir; let clock; let states; let failStarts; let forgejoStatus;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo + ',owner/quiet',
  LABEL_ROUTES: JSON.stringify({ 'ai:plan': { profile: PLANNER, tier: 'strong' }, 'ai:ready': { profile: WORKER, tier: 'free' } }),
  ERROR_RETRIES: '1',
  FORGEJO_URL: 'https://forge.example',
  FORGEJO_TOKEN: 'tok-secret-value',
  MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }),
  DATA_FILE: join(dir, 'deliveries.json'),
  // The status page is closed without STATUS_TOKEN; these tests read it, so it is opened unless a test sets a token.
  ...(extra.STATUS_TOKEN ? {} : { STATUS_PUBLIC: '1' }),
  ...extra
});
function fakeApi() {
  return async (url, request) => {
    const { pathname, hostname } = new URL(url);
    if (hostname === 'forge.example') return { ok: forgejoStatus === 200, status: forgejoStatus, json: async () => ({ labels: [{ name: 'ai:approved' }, { name: 'ai:blocked' }], state: 'open', merged: false, head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' } }) };
    if (request.method === 'POST') return failStarts ? { ok: false, status: 503 } : { ok: true, status: 201, json: async () => ({ id: 'conv-' + pathname.length + clock }) };
    const id = pathname.split('/').pop();
    return { ok: true, status: 200, json: async () => ({ execution_status: states[id] || 'running' }) };
  };
}
async function build(extra) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeApi(), quiet, () => clock);
  return { config, jobs, dispatcher };
}
const event = (label, number = 1) => ({
  type: 'issues.labeled', label, repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'x', labels: [label] }, sender: { login: 'marcel' }
});
// The value of one series of an exposition text, or undefined.
const sample = (text, series) => { const line = text.split('\n').find((entry) => entry.startsWith(series + ' ')); return line === undefined ? undefined : Number(line.slice(series.length + 1)); };
async function serve(extra) {
  const built = await build(extra);
  const server = createApp(built.config, new DeliveryStore(built.config.dataFile), undefined, quiet, built.dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { ...built, base, scrape: async (headers) => (await fetch(base + '/metrics', { headers })).text(), close: () => new Promise((resolve) => server.close(resolve)) };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-metrics-')); clock = 1_000_000; states = {}; failStarts = false; forgejoStatus = 200; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('the text format has HELP and TYPE for every metric, escapes label values and keeps label order stable', () => {
  metrics.inc('forgehands_blocks_total', { reason: 'a "quoted" \\ back\nline' });
  metrics.inc('forgehands_blocks_total', { reason: 'a "quoted" \\ back\nline' });
  metrics.inc('forgehands_error_retries_total');
  const text = metrics.render([{ name: 'forgehands_queued_jobs', labels: { repository: 'o/r' }, value: 3 }]);
  assert.ok(text.endsWith('\n'));
  for (const line of text.split('\n').filter((entry) => entry.startsWith('# TYPE '))) {
    const name = line.split(' ')[2];
    assert.ok(text.includes('# HELP ' + name + ' '), name + ' has no HELP');
    assert.ok(text.indexOf('# HELP ' + name) < text.indexOf(line));
  }
  assert.match(text, /^# TYPE forgehands_blocks_total counter$/m);
  assert.match(text, /^# TYPE forgehands_queued_jobs gauge$/m);
  assert.match(text, /^# TYPE forgehands_run_duration_seconds histogram$/m);
  assert.equal(sample(text, 'forgehands_blocks_total{reason="a \\"quoted\\" \\\\ back\\nline"}'), 2);
  assert.equal(sample(text, 'forgehands_error_retries_total'), 1);
  assert.equal(sample(text, 'forgehands_branch_updates_total'), 0); // an unlabelled counter shows 0 from the start
  assert.equal(sample(text, 'forgehands_queued_jobs{repository="o/r"}'), 3);
  assert.doesNotMatch(text, /^forgehands_merges_total/m); // labelled counters have no line until they count
  assert.doesNotMatch(text, /\n\n/);
});

test('the histogram has cumulative buckets, a sum and a count per kind', () => {
  metrics.observe({ kind: 'issue' }, 45);
  metrics.observe({ kind: 'issue' }, 700);
  metrics.observe({ kind: 'ci_success' }, 10);
  const text = metrics.render();
  const name = 'forgehands_run_duration_seconds';
  assert.equal(sample(text, name + '_bucket{kind="issue",le="30"}'), 0);
  assert.equal(sample(text, name + '_bucket{kind="issue",le="60"}'), 1);
  assert.equal(sample(text, name + '_bucket{kind="issue",le="1200"}'), 2);
  assert.equal(sample(text, name + '_bucket{kind="issue",le="+Inf"}'), 2);
  assert.equal(sample(text, name + '_sum{kind="issue"}'), 745);
  assert.equal(sample(text, name + '_count{kind="issue"}'), 2);
  assert.equal(sample(text, name + '_bucket{kind="ci_success",le="30"}'), 1);
});

test('dry-run writes are counted', async () => {
  const { DryLog } = await import('../src/dry.ts');
  new DryLog(quiet).record('owner/hello', 'POST', '/issues/1/comments', { body: 'x' });
  assert.equal(sample(metrics.render(), 'forgehands_dry_run_writes_total'), 1);
  assert.equal(sample(metrics.render(), 'forgehands_reminders_total'), 0);
  assert.equal(sample(metrics.render(), 'forgehands_escalated_rounds_total'), 0);
});

test('unknown label values collapse to other', () => {
  assert.equal(known('issues', ['issues', 'push']), 'issues');
  assert.equal(known('<script>', ['issues', 'push']), 'other');
  assert.equal(known(undefined, ['issues']), 'other');
});

test('/metrics follows STATUS_TOKEN like the status page', async () => {
  const open = await serve();
  try {
    const text = await open.scrape();
    assert.match(text, /# TYPE forgehands_jobs gauge/);
    const response = await fetch(open.base + '/metrics');
    assert.match(response.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
  } finally { await open.close(); }
  const closed = await serve({ STATUS_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(closed.base + '/metrics')).status, 401);
    assert.equal((await fetch(closed.base + '/metrics', { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(closed.base + '/metrics', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 200);
    assert.equal((await fetch(closed.base + '/metrics', { headers: { authorization: 'Basic ' + Buffer.from('prometheus:' + TOKEN).toString('base64') } })).status, 200);
    assert.doesNotMatch(await closed.scrape(), /forgehands_jobs/);
  } finally { await closed.close(); }
});

test('gauges come from the ledger: jobs by status and kind, waiting, queued per repository, tier cooldown', async () => {
  const { dispatcher, jobs, scrape, close } = await serve({ MAX_CONCURRENT: '1' });
  try {
    await dispatcher.enqueue(event('ai:ready', 1));
    await dispatcher.enqueue(event('ai:plan', 2));
    await dispatcher.tick(); // MAX_CONCURRENT 1: one runs, one stays queued
    jobs.add({ key: repo + '#3:ai:ready', label: 'ai:ready', status: 'waiting', created: clock, event: event('ai:ready', 3) });
    dispatcher.cooldowns.set('strong', Date.now() + 60000);
    const text = await scrape();
    assert.equal(sample(text, 'forgehands_jobs{kind="issue",status="running"}'), 1);
    assert.equal(sample(text, 'forgehands_jobs{kind="issue",status="queued"}'), 1);
    assert.equal(sample(text, 'forgehands_jobs{kind="issue",status="waiting"}'), 1);
    assert.equal(sample(text, 'forgehands_jobs{kind="issue",status="done"}'), 0);
    assert.equal(sample(text, 'forgehands_jobs{kind="conflict",status="failed"}'), 0);
    assert.equal(sample(text, 'forgehands_jobs_waiting'), 1);
    assert.equal(sample(text, 'forgehands_queued_jobs{repository="owner/hello"}'), 1);
    assert.equal(sample(text, 'forgehands_queued_jobs{repository="owner/quiet"}'), 0);
    assert.equal(sample(text, 'forgehands_tier_cooldown_active{tier="strong"}'), 1);
    assert.equal(sample(text, 'forgehands_tier_cooldown_active{tier="free"}'), 0);
    assert.doesNotMatch(text, /weekly|budget/i);
    assert.doesNotMatch(text, /issue="|#\d/); // no issue numbers in labels
  } finally { await close(); }
});

test('webhook deliveries count by event and result', async () => {
  const { config, scrape, base, close } = await serve({ ALLOWED_SENDERS: 'marcel' });
  const post = async (login, delivery, signed = true, event = 'issues') => {
    const raw = JSON.stringify({ action: 'labeled', label: { name: 'ai:plan' }, sender: { login }, repository: { full_name: repo }, issue: { number: 9, labels: [{ name: 'ai:plan' }] } });
    return (await fetch(base + '/webhooks/forgejo', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-forgejo-event': event, 'x-gitea-delivery': delivery,
      'x-forgejo-signature': signed ? createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') : 'bad' } })).status;
  };
  try {
    assert.equal(await post('mallory', 'd1'), 202);
    assert.equal(await post('marcel', 'd2'), 202);
    assert.equal(await post('marcel', 'd2'), 200);
    assert.equal(await post('marcel', 'd3', false), 401);
    assert.equal(await post('marcel', 'd4', false, 'made-up-event-' + 'x'.repeat(40)), 401);
    const text = await scrape();
    const series = (event, result) => 'forgehands_webhook_deliveries_total{event="' + event + '",result="' + result + '"}';
    assert.equal(sample(text, series('issues', 'ignored')), 1);
    assert.equal(sample(text, series('issues', 'accepted')), 1);
    assert.equal(sample(text, series('issues', 'duplicate')), 1);
    assert.equal(sample(text, series('issues', 'rejected_signature')), 1);
    assert.equal(sample(text, series('other', 'rejected_signature')), 1);
    assert.doesNotMatch(text, /made-up-event/);
  } finally { await close(); }
});

test('runs: started and finished by kind and end state, duration, error retries, OpenHands API errors', async () => {
  const { dispatcher, jobs } = await build();
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  let text = metrics.render();
  assert.equal(sample(text, 'forgehands_runs_started_total{kind="issue"}'), 1);
  clock += 90000;
  const [first] = jobs.list();
  states[first.conversation_id] = 'error'; // ERROR_RETRIES 1: started once more, not finished
  await dispatcher.tick();
  text = metrics.render();
  assert.equal(sample(text, 'forgehands_error_retries_total'), 1);
  assert.equal(sample(text, 'forgehands_runs_finished_total{kind="issue",state="error"}'), undefined);
  clock += 120000;
  await dispatcher.tick(); // the retry starts after its pause
  const second = jobs.list()[0];
  assert.equal(second.status, 'running');
  states[second.conversation_id] = 'finished';
  clock += 100000;
  await dispatcher.tick();
  text = metrics.render();
  assert.equal(sample(text, 'forgehands_runs_started_total{kind="issue"}'), 2);
  assert.equal(sample(text, 'forgehands_runs_finished_total{kind="issue",state="finished"}'), 1);
  assert.equal(sample(text, 'forgehands_run_duration_seconds_count{kind="issue"}'), 1);
  assert.equal(sample(text, 'forgehands_run_duration_seconds_sum{kind="issue"}'), 100);
  failStarts = true;
  await dispatcher.enqueue(event('ai:ready', 2));
  await dispatcher.tick();
  assert.equal(sample(metrics.render(), 'forgehands_openhands_api_errors_total{class="5xx"}'), 1);
});

test('Forgejo API errors count by class', async () => {
  const { dispatcher } = await build();
  forgejoStatus = 503;
  await assert.rejects(dispatcher.forgejoCall(event('ai:ready'), 'GET', '/issues/1'));
  forgejoStatus = 403;
  await assert.rejects(dispatcher.forgejoCall(event('ai:ready'), 'GET', '/issues/1'));
  const text = metrics.render();
  assert.equal(sample(text, 'forgehands_forgejo_api_errors_total{class="5xx"}'), 1);
  assert.equal(sample(text, 'forgehands_forgejo_api_errors_total{class="4xx"}'), 1);
});

test('merge refusals count by reason', async () => {
  const config = loadConfig(env({ APPROVAL_GRACE_SECONDS: '0' }));
  const merger = new Merger(config, fakeApi(), quiet);
  // The fake pull request carries ai:approved and ai:blocked: refused because it is blocked.
  assert.equal(await merger.handle({ repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 } }), 'blocked');
  assert.equal(sample(metrics.render(), 'forgehands_merge_refusals_total{reason="blocked"}'), 1);
  assert.equal(sample(metrics.render(), 'forgehands_merges_total{repository="owner/hello"}'), undefined);
});

test('branch updates and conflicts are counted', async () => {
  const { dispatcher } = await build();
  let conflict = false;
  dispatcher.merger.call = async () => { throw new Error('no review'); };
  dispatcher.forgejoCall = async (_event, method, path) => {
    if (method === 'POST' && path.startsWith('/pulls/34/update')) { if (conflict) throw new Error('POST ' + path + ' -> HTTP 409'); return {}; }
    if (path.startsWith('/compare/')) return { total_commits: 1, files: [{ filename: 'a.ts' }] };
    if (path.startsWith('/pulls/34/files')) return [{ filename: 'a.ts' }];
    if (path.startsWith('/commits/')) return { state: 'success', total_count: 1 };
    return {};
  };
  const push = { type: 'push.default', repository: { full_name: repo, default_branch: 'main' }, after: 'tip00000', sender: { login: 'x' } };
  const pr = { number: 34, title: 't', state: 'open', merged: false, merge_base: 'old00000', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [] };
  await dispatcher.refreshPull(push, pr, 'tip00000');
  assert.equal(sample(metrics.render(), 'forgehands_branch_updates_total'), 1);
  conflict = true;
  dispatcher.lastUpdate.clear();
  await dispatcher.refreshPull(push, pr, 'tip00000');
  assert.equal(sample(metrics.render(), 'forgehands_branch_conflicts_total'), 1);
  assert.equal(sample(metrics.render(), 'forgehands_branch_updates_total'), 1);
});

test('a merge counts per repository and a block per reason', async () => {
  const { dispatcher } = await build();
  dispatcher.merger.call = async (_repository, method, path) => {
    if (method === 'GET' && path === '/pulls/34') return { state: 'open', merged: false, mergeable: true, title: 't', head: { ref: 'ai/issue-26', sha: 'cafe0000cafe' }, labels: [{ name: 'ai:approved' }] };
    if (method === 'GET' && path.startsWith('/commits/')) return { state: 'success', total_count: 1 };
    if (method === 'GET' && path.startsWith('/git/commits/')) return { created: '2026-11-15T10:00:00Z' };
    if (method === 'GET' && path.startsWith('/issues/34/comments')) return [{ created_at: '2026-11-15T11:00:00Z', body: 'Verdict: OK ' + 'x'.repeat(400) }];
    if (method === 'GET' && path.startsWith('/pulls/34/files')) return [{ filename: 'a.ts' }];
    return {};
  };
  const merged = await dispatcher.merger.handle({ repository: { full_name: repo }, pull_request: { number: 34, head_ref: 'ai/issue-26' }, issue: { number: 26 } });
  assert.equal(merged, 'merged');
  assert.equal(sample(metrics.render(), 'forgehands_merges_total{repository="owner/hello"}'), 1);
  await dispatcher.markForHuman({ repository: { full_name: repo }, issue: { number: 26 }, pull_request: { number: 34 } }, 'x', 'rounds_used_up');
  assert.equal(sample(metrics.render(), 'forgehands_blocks_total{reason="rounds_used_up"}'), 1);
});
