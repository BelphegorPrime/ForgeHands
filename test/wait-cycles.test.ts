// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Waits that close a cycle: a same-files wait is not taken when the older ticket already waits for this one (explicit dependencies and the waits in
// force); an explicit dependency cycle is reported, counted as idle and alerted, but not broken.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { Notifier } from '../src/notify/index.ts';
import { metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const PLANNER = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/hello';
const MINUTE = 60000;
const DOCS = '## Exact files\n- `docs/agents.md`\n';
const ROUTES = {
  'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 },
  'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 60 }
};
let dir; let clock; let logs; let n = 0; let sent; let closed;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  WAIT_FOR_SAME_FILES: '1',
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// The forge: a ticket is open unless it is in `closed`; dependency lists and pull requests are empty. Reads are counted.
function forge() {
  const world = { reads: 0 };
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  world.send = async (url, request) => {
    if (request.method !== 'GET') return reply({ id: 77 });
    world.reads += 1;
    const path = new URL(url).pathname;
    const issue = /\/issues\/(\d+)$/.exec(path);
    if (issue) return reply({ number: Number(issue[1]), state: closed.has(Number(issue[1])) ? 'closed' : 'open', labels: [] });
    return reply([]);
  };
  return world;
}

function openhands() {
  const world = { started: [] };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') { world.started.push(JSON.parse(request.body).tags.issue); return reply(201, { id: 'conv-' + world.started.length }); }
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
  const notifier = new Notifier([{ name: 'test', send: async (message) => { sent.push(message); } }], ['stalled'], () => false, logger, () => {});
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock, notifier);
  return { config, jobs, dispatcher, fg, oh };
}

// A ticket in the ledger: its trigger label, its declared files and its waits.
function addJob(t, number, status, { label = 'ai:ready', body = DOCS, waiting_for, waiting_for_files } = {}) {
  const event = { type: 'issues.labeled', label, repository: { full_name: repo, clone_url: null, default_branch: 'main' },
    issue: { number, title: 'T' + number, body, html_url: null, labels: [label] }, sender: { login: 'marcel' }, label };
  return t.jobs.add({ key: repo + '#' + number + ':' + label, label, event, status, created: clock + number, attempts: 0,
    ...(waiting_for ? { waiting_for } : {}), ...(waiting_for_files ? { waiting_for_files } : {}) });
}
const started = (t) => t.oh.started.map(Number);
const cycleLines = (text) => logs.filter((line) => line.includes(text));
const dropLines = () => logs.filter((line) => line.includes('(cycle)'));
const byNumber = (t, number) => t.jobs.list().find((job) => job.event.issue.number === number && job.label === 'ai:ready');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-cycles-')); clock = 1_000_000; logs = []; sent = []; closed = new Set(); metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('example 1: the epic 234 waits for its children, 235 waits for 234; 278 does not wait for 235 (a cycle), only for the older 261 it shares files with', async () => {
  const t = await setup();
  addJob(t, 234, 'waiting', { label: 'ai:plan', body: '', waiting_for: [278, 279, 280, 281, 282] });
  addJob(t, 235, 'waiting', { waiting_for: [234] });
  // 261 is an older ticket with work in progress (an agent pull request in the forge would look the same): it is a blocker, not a waiter.
  const older = addJob(t, 261, 'running');
  const child278 = addJob(t, 278, 'queued');
  const child279 = addJob(t, 279, 'queued');
  await t.dispatcher.tick();
  assert.equal(child278.status, 'waiting');
  assert.deepEqual(child278.waiting_for_files, [261], 'the wait for 235 is not taken: 235 waits for 234, which waits for 278');
  assert.equal(cycleLines(repo + '#278: not waiting for #235 (same files): #235 is blocked by this ticket (cycle)').length, 1);
  assert.deepEqual(started(t), []);
  // 261 is done: the deepest child 278 starts; 279 waits for it (the same files, an older ticket) and starts after it.
  older.status = 'done';
  closed.add(261);
  await t.dispatcher.releaseFileWaits();
  await t.dispatcher.tick();
  assert.deepEqual(started(t), [278]);
  assert.equal(child279.status, 'waiting');
  assert.deepEqual(child279.waiting_for_files, [278]);
  child278.status = 'done';
  closed.add(278);
  await t.dispatcher.releaseFileWaits();
  await t.dispatcher.tick();
  assert.deepEqual(started(t), [278, 279]);
});

test('example 2: 232 (epic) waits for 269..271, 233 waits for 232; 269 does not wait for 233 and starts', async () => {
  const t = await setup();
  addJob(t, 232, 'waiting', { label: 'ai:plan', body: '', waiting_for: [269, 270, 271] });
  addJob(t, 233, 'waiting', { waiting_for: [232] });
  const child = addJob(t, 269, 'queued');
  await t.dispatcher.tick();
  assert.equal(child.status, 'running', 'the same-files wait for 233 closes a cycle and is not taken');
  assert.deepEqual(started(t), [269]);
  assert.equal(cycleLines(repo + '#269: not waiting for #233 (same files): #233 is blocked by this ticket (cycle)').length, 1);
});

test('a same-files wait that closes a cycle created later is dropped by the pass, and the job starts', async () => {
  const t = await setup();
  const child = addJob(t, 269, 'waiting', { waiting_for_files: [233] });
  addJob(t, 233, 'waiting', { waiting_for: [232] });
  addJob(t, 232, 'waiting', { label: 'ai:plan', body: '', waiting_for: [269, 270, 271] });
  await t.dispatcher.tick();
  assert.equal(child.status, 'running');
  assert.equal(child.waiting_for_files, undefined);
  assert.equal(cycleLines(repo + '#269: not waiting for #233 (same files)').length, 1);
  assert.equal(metrics.counters.get('forgehands_wait_cycles_broken_total'), 1);
});

test('a plain same-files wait without a cycle is unchanged: the newer ticket waits for the older, then starts', async () => {
  const t = await setup();
  const older = addJob(t, 299, 'queued');
  const newer = addJob(t, 300, 'queued');
  await t.dispatcher.tick();
  assert.equal(older.status, 'running');
  assert.equal(newer.status, 'waiting');
  assert.deepEqual(newer.waiting_for_files, [299]);
  assert.equal(dropLines().length, 0);
  assert.equal(metrics.counters.get('forgehands_wait_cycles_broken_total'), undefined);
  older.status = 'done';
  closed.add(299);
  await t.dispatcher.releaseFileWaits();
  await t.dispatcher.tick();
  assert.deepEqual(started(t), [299, 300]);
});

test('the edge is skipped only when the older ticket really reaches this one', async () => {
  const t = await setup();
  // 298 is an older waiter on other files: it does not reach 300 and shares no files with it, so it is not a blocker.
  addJob(t, 298, 'waiting', { waiting_for: [297], body: '## Exact files\n- `other.md`\n' });
  addJob(t, 299, 'queued');
  const newer = addJob(t, 300, 'queued');
  await t.dispatcher.tick();
  assert.deepEqual(newer.waiting_for_files, [299]);
});

test('an explicit dependency cycle is detected, logged once, counted as idle and alerted, and not broken', async () => {
  const t = await setup({ STALL_ALERT_MINUTES: '1' });
  const a = addJob(t, 10, 'waiting', { waiting_for: [11] });
  const b = addJob(t, 11, 'waiting', { waiting_for: [10] });
  await t.dispatcher.tick();
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  await t.dispatcher.tick();
  assert.equal(a.status, 'waiting');
  assert.equal(b.status, 'waiting');
  assert.deepEqual(a.waiting_for, [11]);
  assert.deepEqual(b.waiting_for, [10], 'explicit edges are never dropped');
  assert.equal(started(t).length, 0);
  assert.equal(cycleLines('dependency cycle: #10 -> #11 -> #10 (owner/hello)').length, 1);
  assert.equal(t.dispatcher.idleState().reasons.cycle, 2);
  assert.equal(t.dispatcher.idleState().reasons.dependencies, 0);
  assert.deepEqual(t.dispatcher.idleState().cycles, ['dependency cycle: #10 -> #11 -> #10 (owner/hello)']);
  assert.equal(sent.length, 1, 'the cycle is an alert condition');
  assert.equal(sent[0].kind, 'stalled');
  assert.match(sent[0].text, /dependency cycle: #10 -> #11 -> #10 \(owner\/hello\)/);
});

test('a plain dependency chain is not a cycle and does not alert', async () => {
  const t = await setup({ STALL_ALERT_MINUTES: '1' });
  addJob(t, 20, 'waiting', { waiting_for: [21] });
  addJob(t, 21, 'waiting', { waiting_for: [22] });
  addJob(t, 22, 'waiting');
  clock += 3 * 60 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.dispatcher.idleState().reasons.cycle, 0);
  assert.equal(t.dispatcher.idleState().reasons.dependencies, 2);
  assert.equal(sent.length, 0);
});

test('the cycle line is logged once across passes, and the same-files pair once too', async () => {
  const t = await setup();
  addJob(t, 278, 'queued');
  addJob(t, 235, 'waiting', { waiting_for: [234] });
  addJob(t, 234, 'waiting', { label: 'ai:plan', body: '', waiting_for: [278] });
  for (let i = 0; i < 4; i += 1) { clock += 5 * MINUTE; await t.dispatcher.tick(); }
  assert.equal(cycleLines('not waiting for #235').length, 1);
  assert.equal(metrics.counters.get('forgehands_wait_cycles_broken_total'), 1);
});

test('the passes read the forge no more than the starts need: a pass over waiting jobs only reads nothing', async () => {
  const t = await setup();
  addJob(t, 234, 'waiting', { label: 'ai:plan', body: '', waiting_for: [278] });
  addJob(t, 235, 'waiting', { waiting_for: [234] });
  addJob(t, 278, 'waiting', { waiting_for_files: [235] });
  await t.dispatcher.tick(); // the first pass may read what the sweep of closed tickets needs
  const reads = t.fg.reads;
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.fg.reads, reads, 'no forge read on the ticks: the graph comes from the ledger');
});
