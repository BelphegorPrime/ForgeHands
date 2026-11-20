// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Tickets and pull requests deleted in the forge: a 404 of the ticket's own read drops its waiting and queued jobs (status `deleted`, once, one log
// line); a 404 of the dependencies alone does not; running jobs are left alone; the ledger sync reads waiting and queued tickets as well.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';
import { buildStatus } from '../src/server/status.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const ROUTES = { 'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 } };
let dir; let clock; let logs; let n = 0;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// The forge: tickets are open unless listed in `gone`; their dependencies are `deps[n]` unless `depsMissing` has n (a 404 of the list alone);
// pull requests are open unless in `pullsGone`.
function forge() {
  const world = { gone: new Set(), depsMissing: new Set(), pullsGone: new Set(), deps: {}, writes: [] };
  const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
  world.send = async (url, request) => {
    const path = new URL(url).pathname.replace(API, '');
    if (request.method !== 'GET') { world.writes.push(request.method + ' ' + path); return reply(201, { id: 77 }); }
    let m = /^\/issues\/(\d+)$/.exec(path);
    if (m) return world.gone.has(Number(m[1])) ? reply(404, {}) : reply(200, { number: Number(m[1]), state: 'open', labels: [] });
    m = /^\/issues\/(\d+)\/dependencies$/.exec(path);
    if (m) return world.depsMissing.has(Number(m[1])) ? reply(404, {}) : reply(200, world.deps[Number(m[1])] || []);
    m = /^\/pulls\/(\d+)$/.exec(path);
    if (m) return world.pullsGone.has(Number(m[1])) ? reply(404, {}) : reply(200, { number: Number(m[1]), state: 'open', merged: false, head: { ref: 'ai/issue-20', sha: 'c0ffee' }, labels: [] });
    return reply(200, []);
  };
  return world;
}

function openhands() {
  const world = { started: 0 };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') { world.started += 1; return reply(201, { id: 'conv-' + world.started }); }
    if (request.method === 'GET' && /^\/api\/conversations\/[^/]+$/.test(path)) return reply(200, { execution_status: 'running', stats: { usage_to_metrics: {} } });
    return reply(200, {});
  };
  return world;
}

async function setup(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const fg = forge();
  const oh = openhands();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? fg.send(url, request) : oh.send(url, request);
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher, fg, oh };
}

const eventOf = (label, number, extra = {}) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: null, labels: [label] },
  sender: { login: 'marcel' }, label, ...extra
});
const addJob = (t, number, status, patch = {}) => t.jobs.add({ key: repo + '#' + number + ':ai:ready', label: 'ai:ready', event: eventOf('ai:ready', number),
  status, created: clock, attempts: 0, ...patch });
const deletedLines = () => logs.filter((line) => line.includes('deleted in the forge'));
const droppedCount = () => metrics.counters.get('forgehands_deleted_tickets_total') || 0;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-deleted-')); clock = 1_000_000; logs = []; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a waiting job of a deleted ticket is dropped at once, once, with one log line and a counter', async () => {
  const t = await setup();
  t.fg.gone.add(20); t.fg.depsMissing.add(20);
  const job = addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.reminder.startForgotten();
  assert.equal(job.status, 'deleted');
  assert.equal(job.result, 'deleted');
  assert.equal(job.waiting_for, undefined);
  assert.equal(deletedLines().length, 1);
  assert.equal(deletedLines()[0], repo + '#20: deleted in the forge, its waiting jobs are dropped');
  assert.equal(droppedCount(), 1);
  // Nothing waits any more: the next look neither reads nor logs it again.
  await t.dispatcher.reminder.startForgotten();
  await t.dispatcher.tick();
  assert.equal(deletedLines().length, 1);
  assert.equal(droppedCount(), 1);
  assert.equal(t.oh.started, 0, 'nothing starts for it');
  assert.equal(t.jobs.list(true).length, 0);
});

test('a queued job of a deleted ticket never starts: the dependency read answers 404 and the ticket is gone', async () => {
  const t = await setup();
  t.fg.gone.add(20); t.fg.depsMissing.add(20);
  const job = addJob(t, 20, 'queued');
  await t.dispatcher.tick();
  assert.equal(t.oh.started, 0);
  assert.equal(job.status, 'deleted');
  assert.equal(deletedLines().length, 1);
});

test('a 404 of the dependencies alone, on a ticket that exists, does not drop the job', async () => {
  const t = await setup();
  t.fg.depsMissing.add(20);
  const job = addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.reminder.startForgotten();
  assert.equal(job.status, 'waiting', 'the ticket is open: no dependencies is not a deletion');
  assert.equal(deletedLines().length, 0);
  assert.equal(droppedCount(), 0);
});

test('a running job of a deleted ticket is left alone; only its waiting and queued siblings are dropped', async () => {
  const t = await setup();
  t.fg.gone.add(20); t.fg.depsMissing.add(20);
  const running = t.jobs.add({ key: repo + '#20:ai:changes', label: 'ai:ready', event: eventOf('ai:ready', 20), status: 'running', created: clock, started: clock, conversation_id: 'conv-x', attempts: 0 });
  const waiting = addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.reminder.startForgotten();
  assert.equal(running.status, 'running');
  assert.equal(waiting.status, 'deleted');
  assert.equal(deletedLines().length, 1);
});

test('the ledger sync reads waiting and queued tickets too: a 404 on the ticket drops them on the second pass, a running ticket is not read', async () => {
  const t = await setup();
  t.fg.gone.add(20);
  const waiting = addJob(t, 20, 'waiting', { waiting_for: [5] });
  const running = t.jobs.add({ key: repo + '#21:ai:ready', label: 'ai:ready', event: eventOf('ai:ready', 21), status: 'running', created: clock, started: clock, conversation_id: 'conv-y', attempts: 0 });
  const queued = addJob(t, 22, 'queued');
  await t.dispatcher.ledgerSync.run();
  assert.equal(waiting.status, 'waiting', 'one 404 is not a deletion (a proxy can answer it)');
  await t.dispatcher.ledgerSync.run();
  assert.equal(waiting.status, 'deleted');
  assert.equal(queued.status, 'queued', 'an open ticket is read and left as it is');
  assert.equal(running.status, 'running');
  assert.equal(deletedLines().length, 1);
  assert.equal(deletedLines()[0], repo + '#20: deleted in the forge, removed from the status page');
  assert.equal(droppedCount(), 1);
});

test('a ticket the forge deleted with only finished jobs (a ghost) leaves the open list on the second pass: state `deleted in the forge`, one line, no more reads', async () => {
  const t = await setup();
  const done = addJob(t, 30, 'done', { finished: clock, result: 'finished' });
  t.fg.gone.add(30);
  await t.dispatcher.ledgerSync.run();
  assert.notEqual(buildStatus(t.config, t.jobs, clock).issues.find((issue) => issue.issue === repo + '#30').state, 'deleted in the forge', 'one 404: not yet');
  await t.dispatcher.ledgerSync.run();
  const ticket = buildStatus(t.config, t.jobs, clock).issues.find((issue) => issue.issue === repo + '#30');
  assert.equal(ticket.state, 'deleted in the forge');
  assert.equal(ticket.closed, true, 'out of the open list, in the closed list');
  assert.equal(done.archived_view, true);
  assert.equal(deletedLines().length, 1);
  const reads = t.fg.writes.length;
  await t.dispatcher.ledgerSync.run();
  await t.dispatcher.ledgerSync.run();
  assert.equal(deletedLines().length, 1, 'no more lines on the next passes');
  assert.equal(t.fg.writes.length, reads);
  assert.equal(droppedCount(), 1);
});

test('a waiting ticket is released when the issue it waits for is deleted in the forge, even if the dependency list still names it as open', async () => {
  const t = await setup();
  t.fg.gone.add(5);
  t.fg.deps[20] = [{ number: 5, state: 'open' }];
  addJob(t, 5, 'done', { finished: clock, result: 'finished' });
  const waiting = addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.ledgerSync.run();
  await t.dispatcher.ledgerSync.run();
  assert.equal(t.jobs.isDeletedInForge(repo + '#5'), true);
  assert.equal(waiting.waiting_for, undefined, 'nothing is waited for any more');
  assert.equal(waiting.status, 'queued');
  await t.dispatcher.tick();
  assert.equal(waiting.status, 'running', 'the dependent starts: it does not wait forever');
  assert.equal(t.oh.started, 1);
});

test('the sweep of closed tickets does not log a 404 again and again: the ledger sync decides it', async () => {
  const t = await setup();
  addJob(t, 40, 'failed', { finished: clock, result: 'error' });
  t.fg.gone.add(40);
  await t.dispatcher.sweepClosed(clock);
  await t.dispatcher.sweepClosed(clock + 2 * 86400000);
  assert.equal(logs.filter((line) => line.includes('could not read #40')).length, 0);
});

test('the ledger sync drops the queued jobs that name a deleted pull request, and leaves the open ticket alone', async () => {
  const t = await setup();
  t.fg.pullsGone.add(34);
  const round = t.jobs.add({ key: repo + '#20:ai:changes', label: 'ai:changes', event: { ...eventOf('ai:changes', 20), pull_request: { number: 34, head_ref: 'ai/issue-20', html_url: null } },
    status: 'queued', created: clock, attempts: 0 });
  await t.dispatcher.ledgerSync.run();
  assert.equal(round.status, 'deleted');
  assert.equal(deletedLines()[0], repo + '!pr34: deleted in the forge, its waiting jobs are dropped');
  assert.ok(!t.jobs.list().find((job) => job.key.startsWith(repo + '#20:') && job.archived_view), 'the issue is not closed by the pull request');
});

test('the ledger sync budget holds for waiting tickets: at most LEDGER_SYNC_BUDGET reads a pass', async () => {
  const t = await setup();
  for (let number = 100; number < 180; number += 1) addJob(t, number, 'waiting', { waiting_for: [5] });
  // Every read of a ticket goes through the forge fake: counted here, the answers are the usual ones.
  const answer = t.fg.send;
  const reads = [];
  t.fg.send = async (url, request) => { if (/\/issues\/\d+$/.test(new URL(url).pathname)) reads.push(url); return answer(url, request); };
  await t.dispatcher.ledgerSync.run();
  assert.ok(reads.length <= 60, 'the pass reads at most 60 tickets (' + reads.length + ')');
  assert.ok(reads.length > 0);
});

test('a stale dependency name does not block: an entry that is not open holds nothing back', async () => {
  const t = await setup();
  t.fg.deps[20] = [{ number: 99, state: 'deleted' }, { number: 98 }];
  const job = addJob(t, 20, 'queued');
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'the ticket starts: no open dependency is named');
  assert.equal(t.oh.started, 1);
});

test('the status page shows a deleted ticket as deleted, in the closed list, and no waiting job is left on it', async () => {
  const t = await setup();
  t.fg.gone.add(20); t.fg.depsMissing.add(20);
  addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.reminder.startForgotten();
  const status = buildStatus(t.config, t.jobs, clock);
  const ticket = status.issues.find((issue) => issue.issue === repo + '#20');
  assert.equal(ticket.state, 'deleted');
  assert.equal(ticket.closed, true);
  assert.equal(status.limits.running, 0);
  assert.equal(status.idle, undefined);
});

test('the deleted ticket is not dropped in a dry run', async () => {
  const t = await setup({ DRY_RUN: '1' });
  t.fg.gone.add(20); t.fg.depsMissing.add(20);
  const job = addJob(t, 20, 'waiting', { waiting_for: [5] });
  await t.dispatcher.reminder.startForgotten();
  assert.equal(job.status, 'waiting');
  assert.equal(droppedCount(), 0);
  assert.deepEqual(t.fg.writes, []);
});
