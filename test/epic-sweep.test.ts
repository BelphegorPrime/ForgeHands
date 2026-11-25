// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The epic sweep (REVIEW_SWEEP_MINUTES, src/agent/epic-sweep.ts): an open epic whose sub-issues are all closed and that had no epic review since
// the last close gets its epic_done review, once per default-branch head. Also: the closed event of any sender (HUMAN_LOGIN included) and the
// epic that carries another label (ai:changes) start it, and /status shows such an epic as "epic review pending".
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';
import { createApp } from '../src/server/app.ts';
import { buildStatus } from '../src/server/status.ts';
import { buildFactory } from '../src/server/factory.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { normalizeEvent } from '../src/webhook/events.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const WORKER = '22222222-2222-4222-8222-222222222222';
const API = '/api/v1/repos/owner/hello';
const repo = 'owner/hello';
const KEY = 'owner/hello#10';
const REVIEW_KEY = KEY + ':epic:done';
const quiet = { error() {} };
const HEAD = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const NEW_HEAD = 'ffff1111bbbb2222cccc3333dddd4444eeee5555';
const HOUR = 3600000;

let dir; let clock; let calls; let world; let routes; let logs;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 80 },
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ci:success': { profile: REVIEWER, tier: 'free', on: 'ci_success' },
    'epic:done': { profile: REVIEWER, tier: 'strong', max_iterations: 40, on: 'epic_done' }
  }),
  MAX_CONCURRENT_PER_TIER: '2',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

function fakeApi() {
  return async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ method: request.method, path });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + calls.length }) };
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
}

// The forge: a route answers by method and path (the query is not part of the key); a route that is missing is a 404.
function fakeForgejo() {
  const forgeCalls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    forgeCalls.push({ method: request.method, path: u.pathname, body });
    const route = routes[request.method + ' ' + u.pathname];
    if (route === undefined) return { ok: false, status: 404 };
    const value = typeof route === 'function' ? route(u, body) : route;
    if (value && value.__status) return { ok: false, status: value.__status };
    return { ok: true, status: 200, json: async () => value };
  };
  return { forgeCalls, send, writes: () => forgeCalls.filter((call) => call.method !== 'GET') };
}

async function build(extra = {}, notifier) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo();
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const logger = { error: (...args) => logs.push(args.join(' ')) };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock, notifier);
  return { config, jobs, forgejo, dispatcher };
}

// The epic as the forge has it: open, labelled ai:plan, one sub-issue (11) closed an hour ago, default branch main at HEAD.
function setWorld(extra = {}) {
  world = {
    issue: { number: 10, state: 'open', title: 'Epic', body: 'Make X work', labels: [{ id: 1, name: 'ai:plan' }], html_url: 'https://forge.example/owner/hello/issues/10', comments: 0 },
    sha: HEAD,
    sub: [{ number: 11, state: 'closed', title: 'Part one', labels: [], closed_at: new Date(clock - HOUR).toISOString() }],
    listed: [],
    ...extra
  };
  routes = {
    ['GET ' + API + '/issues/10']: () => world.issue,
    ['GET ' + API + '/issues/10/dependencies']: () => world.sub,
    ['GET ' + API + '/issues/11/blocks']: () => [world.issue],
    ['GET ' + API + '/branches/main']: () => ({ commit: { id: world.sha } }),
    ['GET ' + API + '/pulls']: () => [],
    ['GET ' + API + '/issues']: () => world.listed,
    ['GET ' + API + '/issues/10/labels']: () => world.issue.labels,
    ['GET ' + API + '/issues/10/comments']: () => []
  };
}

const ticketEvent = (number, sender = 'marcel') => ({
  type: 'issues.labeled', source: 'forgejo', action: 'labeled', label: 'ai:plan',
  repository: { full_name: repo, default_branch: 'main' }, issue: { number, title: 'Epic', body: '', labels: ['ai:plan'] }, sender: { login: sender }
});

// A run of the ledger as the dispatcher writes it (a planner run that is done, or an epic review that ran and ended).
function run(t, key, label, status, finished, extra = {}) {
  return t.jobs.add({ key, label, status, created: finished - HOUR, started: finished - HOUR, finished, event: ticketEvent(10), ...extra });
}
const reviews = (t) => t.jobs.list().filter((job) => job.key === REVIEW_KEY);
const pass = (t) => t.dispatcher.sweep.pass();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-epic-sweep-'));
  clock = 1_000_000_000; calls = []; logs = [];
  setWorld();
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('all sub-issues closed and no epic review: the sweep starts it once, and not again on the same head', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  const before = metrics.read('forgehands_epic_sweep_starts_total').reduce((sum, entry) => sum + entry.value, 0);
  await pass(t);
  assert.equal(reviews(t).length, 1);
  assert.equal(reviews(t)[0].status, 'queued');
  assert.equal(reviews(t)[0].event.type, 'epic.done');
  assert.equal(reviews(t)[0].event.action, 'dependencies_closed');
  assert.equal(t.jobs.epicSweeps.get(KEY).sha, HEAD);
  assert.equal(metrics.read('forgehands_epic_sweep_starts_total').reduce((sum, entry) => sum + entry.value, 0) - before, 1);
  // Queued: the next pass starts nothing.
  await pass(t);
  assert.equal(reviews(t).length, 1);
  // The review failed on this head: the head is not tried again (the record keeps it).
  Object.assign(reviews(t)[0], { status: 'failed', finished: clock });
  await pass(t);
  assert.equal(reviews(t).length, 1);
  // A new head of the default branch: the review is started once more.
  world.sha = NEW_HEAD;
  await pass(t);
  assert.equal(reviews(t).length, 2);
  assert.equal(t.jobs.epicSweeps.get(KEY).sha, NEW_HEAD);
});

test('the review already ran on the same head after the last close: nothing starts', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  run(t, REVIEW_KEY, 'epic:done', 'done', clock - HOUR / 2, { event: { ...ticketEvent(10), type: 'epic.done' } });
  await pass(t);
  assert.equal(reviews(t).length, 1);
  assert.equal(t.jobs.epicSweeps.get(KEY).sha, null);
  // The status: the epic has nothing pending.
  const status = buildStatus(t.config, t.jobs, clock);
  assert.equal(status.issues.find((issue) => issue.issue === KEY).state, 'epic review done, waiting for the next event');
});

test('a review that ran before the last sub-issue closed does not count: the sweep starts it', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 3 * HOUR);
  run(t, REVIEW_KEY, 'epic:done', 'done', clock - 2 * HOUR, { event: { ...ticketEvent(10), type: 'epic.done' } });
  await pass(t);
  assert.equal(reviews(t).length, 2);
});

test('one sub-issue still open: nothing starts, and the epic is recorded as waiting', async () => {
  const t = await build();
  world.sub = [...world.sub, { number: 12, state: 'open', title: 'Part two', labels: [], closed_at: null }];
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  await pass(t);
  assert.equal(reviews(t).length, 0);
  assert.deepEqual(t.jobs.epicSweeps.get(KEY).open, [12]);
  const status = buildStatus(t.config, t.jobs, clock);
  assert.equal(status.issues.find((issue) => issue.issue === KEY).state, 'worker done, waiting for the next event');
});

test('an epic that carries ai:changes after an earlier review is started by the sweep', async () => {
  const t = await build();
  world.issue.labels = [{ id: 3, name: 'ai:changes' }];
  run(t, REVIEW_KEY, 'epic:done', 'done', clock - 2 * HOUR, { event: { ...ticketEvent(10), type: 'epic.done' } });
  await pass(t);
  assert.equal(reviews(t).length, 2);
  assert.equal(reviews(t)[1].status, 'queued');
});

test('an epic that carries ai:changes starts when its last sub-issue closes (the closed event, not the sweep)', async () => {
  const t = await build();
  world.issue.labels = [{ id: 3, name: 'ai:changes' }];
  run(t, REVIEW_KEY, 'epic:done', 'done', clock - 2 * HOUR, { event: { ...ticketEvent(10), type: 'epic.done' } });
  const outcome = await t.dispatcher.onClosed(closedEvent(11, 'marcel'));
  assert.match(outcome, /epic #10 review/);
  assert.equal(reviews(t).filter((job) => job.status === 'queued').length, 1);
});

test('a closed event of HUMAN_LOGIN runs the check: the epic review starts', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  const outcome = await t.dispatcher.onClosed(closedEvent(11, 'marcel'));
  assert.match(outcome, /epic #10 review/);
  assert.equal(reviews(t).length, 1);
  assert.equal(reviews(t)[0].event.sender.login, 'marcel');
});

test('a closed event that the server accepts from any sender starts the review (ALLOWED_SENDERS does not list the closer)', async () => {
  const t = await build({ ALLOWED_SENDERS: 'someone-else' });
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  const store = new DeliveryStore(t.config.dataFile);
  const server = createApp(t.config, store, undefined, quiet, t.dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const raw = JSON.stringify({ action: 'closed', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 11, title: 'Part one', labels: [] }, sender: { login: 'marcel' } });
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': 'issues', 'x-gitea-delivery': 'close-1',
      'x-forgejo-signature': createHmac('sha256', t.config.forgejoSecret).update(raw).digest('hex') } });
    assert.match((await response.json()).status, /epic #10 review/);
    assert.equal(reviews(t).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('one sub-issue closed and another still open: the close starts nothing', async () => {
  const t = await build();
  world.sub = [...world.sub, { number: 12, state: 'open', title: 'Part two', labels: [], closed_at: null }];
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  const outcome = await t.dispatcher.onClosed(closedEvent(11, 'marcel'));
  assert.equal(outcome, 'nothing_ready');
  assert.equal(reviews(t).length, 0);
});

test('an epic with BLOCKED_LABEL is a human\'s call: the sweep does not start it', async () => {
  const t = await build();
  world.issue.labels = [{ id: 1, name: 'ai:plan' }, { id: 2, name: 'ai:blocked' }];
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  await pass(t);
  assert.equal(reviews(t).length, 0);
});

test('an epic the ledger never saw is found through the open issues with its label (a lost webhook)', async () => {
  const t = await build();
  // Another ticket of the repository gives the default branch; the epic itself has no run in the ledger.
  run(t, 'owner/hello#3:ai:ready', 'ai:ready', 'done', clock - 2 * HOUR, { event: { ...ticketEvent(3), label: 'ai:ready' } });
  world.listed = [world.issue];
  await pass(t);
  assert.equal(reviews(t).length, 1);
  assert.equal(reviews(t)[0].status, 'queued');
});

test('a closed epic is dropped from the sweep\'s records', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  await pass(t);
  assert.ok(t.jobs.epicSweeps.has(KEY));
  world.issue.state = 'closed';
  await pass(t);
  assert.equal(t.jobs.epicSweeps.has(KEY), false);
});

test('a waiting ticket behind a pending epic review says so, and the epic shows "epic review pending" with its link', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  // The sweep cannot start the review here: the epic is blocked (a human's call), so it stays pending.
  world.issue.labels = [{ id: 1, name: 'ai:plan' }, { id: 2, name: 'ai:blocked' }];
  await pass(t);
  // Ticket 12 waits for the epic.
  t.jobs.add({ key: 'owner/hello#12:ai:ready', label: 'ai:ready', status: 'waiting', created: clock, waiting_for: [10], event: { ...ticketEvent(12), label: 'ai:ready' } });
  const status = buildStatus(t.config, t.jobs, clock);
  const epic = status.issues.find((issue) => issue.issue === KEY);
  assert.equal(epic.state, 'epic review pending');
  assert.equal(status.issues.find((issue) => issue.issue === 'owner/hello#12').state, 'waiting behind epic review pending #10');
  assert.match(status.issues.find((issue) => issue.issue === 'owner/hello#12').state_links['10'], /issues\/10$/);
  assert.equal(status.factory.epic_reviews.count, 1);
  assert.equal(status.factory.epic_reviews.list[0].issue, KEY);
  assert.match(status.factory.epic_reviews.list[0].issue_url, /issues\/10$/);
  assert.equal(status.factory.epic_reviews.list[0].sub_issues, 1);
  // The factory list is built the same way from the ledger (the page and /status.json read one value).
  assert.equal(buildFactory(t.config, t.jobs, status.issues, new Set(), null).epic_reviews.count, 1);
});

test('the epic sweep records survive a restart (the ledger keeps them)', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  await pass(t);
  await t.jobs.persist(clock);
  const again = new JobStore(join(dir, 'jobs.json'));
  await again.load();
  assert.equal(again.epicSweeps.get(KEY).sha, HEAD);
  assert.equal(again.epicSweeps.get(KEY).deps, 1);
});

const closedEvent = (number, sender) => normalizeEvent('issues', { action: 'closed', repository: { full_name: repo, default_branch: 'main' }, issue: { number, title: 'Part one', labels: [] }, sender: { login: sender } }, new Set([repo]), ['ai:ready'], {});

test('a closed epic costs no read once the ledger marks it closed, and an open one is still read', async () => {
  const t = await build();
  run(t, KEY + ':ai:plan', 'ai:plan', 'done', clock - 2 * HOUR);
  world.issue.state = 'closed';
  await pass(t);
  assert.equal(t.jobs.list().filter((job) => job.key.startsWith(KEY + ':')).every((job) => job.archived_view), true, 'the ledger marks the closed epic');
  const reads = () => t.forgejo.forgeCalls.filter((call) => call.method === 'GET' && call.path === API + '/issues/10').length;
  const before = reads();
  await pass(t);
  assert.equal(reads(), before, 'no read of the closed epic in the next pass');
  // A reopened epic that carries its label is found again through the listing.
  world.issue.state = 'open';
  world.listed = [world.issue];
  await pass(t);
  assert.equal(reviews(t).length, 1);
});

test('the listing of an epic label keeps only open issues that carry that label (Forgejo answers every issue for an unknown label)', async () => {
  const t = await build();
  run(t, 'owner/hello#3:ai:ready', 'ai:ready', 'done', clock - 2 * HOUR, { event: { ...ticketEvent(3), label: 'ai:ready' } });
  const issue = (number, state, labels, extra = {}) => ({ number, state, title: 'Other', body: '', labels: labels.map((name) => ({ name })), html_url: null, ...extra });
  // Decoys the listing returns for any label: another label, a pull request, a closed issue.
  const decoys = [issue(13, 'open', ['ai:changes']), issue(14, 'open', ['ai:plan'], { pull_request: {} }), issue(15, 'closed', ['ai:plan'])];
  for (const decoy of decoys) routes['GET ' + API + '/issues/' + decoy.number] = () => decoy;
  world.listed = [...decoys, world.issue];
  await pass(t);
  const read = (number) => t.forgejo.forgeCalls.some((call) => call.method === 'GET' && call.path === API + '/issues/' + number);
  assert.equal(read(13) || read(14) || read(15), false, 'the decoys are never read as epics');
  assert.equal(read(10), true, 'the real epic is read');
  assert.equal(reviews(t).length, 1);
});
