// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The idle line of a dispatch pass that starts nothing, the stall alert (STALL_ALERT_MINUTES) and the idle numbers on /status.json and the gauge.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { Notifier } from '../src/notify/index.ts';
import { buildStatus } from '../src/server/status.ts';
import { gaugeSamples, metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const PLANNER = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/hello';
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const ROUTES = {
  'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 },
  'ai:cheap': { profile: WORKER, tier: 'cheap', max_iterations: 40 },
  'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 60 }
};
let dir; let clock; let logs; let n = 0; let sent;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// OpenHands: a conversation per start, every other call answers 200 with an empty body.
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

// Forgejo: reads answer an empty list, the issues are open.
const forgeSend = async (url, request) => {
  const path = new URL(url).pathname;
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  if (request.method === 'GET' && /\/issues\/\d+$/.test(path)) return reply({ number: 1, state: 'open', labels: [] });
  return reply(request.method === 'GET' ? [] : { id: 77 });
};

// A channel that records what is sent; the notifier sends `stalled` at once, as NOTIFY_IMMEDIATE says.
const channel = { name: 'test', send: async (message) => { sent.push(message); } };

async function setup(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const oh = openhands();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgeSend(url, request) : oh.send(url, request);
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const notifier = new Notifier([channel], ['stalled'], () => false, logger, () => {});
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock, notifier);
  return { config, jobs, dispatcher, oh, logger };
}

const issueEvent = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
// A job the ledger holds in a given state, without going through an event.
function addJob(t, label, number, patch) {
  return t.jobs.add({ key: repo + '#' + number + ':' + label, label, event: { ...issueEvent(label, number), label }, status: 'queued', created: clock, attempts: 0, ...patch });
}
const idleLines = () => logs.filter((line) => line.startsWith('idle: '));
const stallLines = () => logs.filter((line) => line.startsWith('stall alert'));
const lastIdle = () => idleLines().at(-1);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-idle-')); clock = 1_000_000; logs = []; sent = []; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('the idle line is logged when the composition of a pass that starts nothing changes, and at most every 15 minutes otherwise', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  assert.equal(idleLines().length, 1);
  assert.equal(lastIdle(), 'idle: 1 waiting: 0 on dependencies, 0 on files of older tickets, 1 held (quota free), 0 held (low disk), 0 over the hourly limit, 0 over a concurrency limit');
  await t.dispatcher.tick();
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(idleLines().length, 1, 'the same composition is not logged on every tick');
  await t.dispatcher.enqueue(issueEvent('ai:ready', 58));
  await t.dispatcher.tick();
  assert.equal(idleLines().length, 2, 'a changed composition is logged at once');
  assert.match(lastIdle(), /^idle: 2 waiting: .* 2 held \(quota free\)/);
  clock += 14 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(idleLines().length, 2);
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(idleLines().length, 3, 'the same composition is logged again after 15 minutes');
});

test('every wait the dispatcher decides is counted once: dependencies, files, quota, disk, the hourly and the concurrency limits', async () => {
  const t = await setup({ MAX_RUNS_PER_HOUR: '1' });
  addJob(t, 'ai:ready', 60, { status: 'waiting', waiting_for: [5] });
  addJob(t, 'ai:ready', 61, { status: 'waiting', waiting_for_files: [3] });
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  addJob(t, 'ai:ready', 57);
  addJob(t, 'ai:ready', 58);
  // A run that started within the hour takes the one allowed start: not a quota hold, so it is the hourly limit that holds the queued jobs of tier cheap.
  addJob(t, 'ai:cheap', 62, { status: 'done', started: clock - 10 * MINUTE, finished: clock - 9 * MINUTE });
  addJob(t, 'ai:cheap', 63);
  await t.dispatcher.tick();
  const { reasons, tiers } = t.dispatcher.idleState();
  assert.deepEqual(reasons, { dependencies: 1, files: 1, quota: 2, disk: 0, hourly: 1, concurrency: 0, could_start: 0, cycle: 0, stuck: 0 });
  assert.deepEqual(tiers, ['free']);
  assert.equal(lastIdle(), 'idle: 5 waiting: 1 on dependencies, 1 on files of older tickets, 2 held (quota free), 0 held (low disk), 1 over the hourly limit, 0 over a concurrency limit');
});

test('disk, global and per-tier concurrency holds are counted as their own reasons', async () => {
  const disk = await setup();
  addJob(disk, 'ai:ready', 57);
  disk.dispatcher.workspace.holding = true;
  await disk.dispatcher.tick();
  assert.deepEqual(disk.dispatcher.idleState().reasons, { dependencies: 0, files: 0, quota: 0, disk: 1, hourly: 0, concurrency: 0, could_start: 0, cycle: 0, stuck: 0 });

  const global = await setup({ MAX_CONCURRENT: '1' });
  global.jobs.add({ key: repo + '#90:ai:cheap', label: 'ai:cheap', event: { ...issueEvent('ai:cheap', 90), label: 'ai:cheap' }, status: 'running', created: clock, started: clock, conversation_id: 'conv-x', attempts: 0 });
  addJob(global, 'ai:ready', 57);
  await global.dispatcher.tick();
  assert.deepEqual(global.dispatcher.idleState().reasons, { dependencies: 0, files: 0, quota: 0, disk: 0, hourly: 0, concurrency: 1, could_start: 0, cycle: 0, stuck: 0 });

  const tier = await setup({ MAX_CONCURRENT_PER_TIER: '1' });
  tier.jobs.add({ key: repo + '#90:ai:ready', label: 'ai:ready', event: { ...issueEvent('ai:ready', 90), label: 'ai:ready' }, status: 'running', created: clock, started: clock, conversation_id: 'conv-y', attempts: 0 });
  addJob(tier, 'ai:ready', 57);
  await tier.dispatcher.tick();
  assert.deepEqual(tier.dispatcher.idleState().reasons, { dependencies: 0, files: 0, quota: 0, disk: 0, hourly: 0, concurrency: 1, could_start: 0, cycle: 0, stuck: 0 });
});

test('a pass that starts something logs no idle line', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('cheap', clock + 20 * HOUR);
  addJob(t, 'ai:ready', 57);
  addJob(t, 'ai:cheap', 58);
  await t.dispatcher.tick();
  assert.equal(t.oh.started, 1, 'the free job starts');
  assert.equal(idleLines().length, 0, 'something started in this pass: nothing is idle');
  assert.equal(t.dispatcher.idleState(), null);
});

test('a queued job with a retry timer is not one of the counted waits', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  addJob(t, 'ai:ready', 57);
  addJob(t, 'ai:ready', 59, { next_try: clock + 10 * MINUTE });
  await t.dispatcher.tick();
  assert.deepEqual(t.dispatcher.idleState().reasons, { dependencies: 0, files: 0, quota: 1, disk: 0, hourly: 0, concurrency: 0, could_start: 0, cycle: 0, stuck: 0 });
});

test('pure dependency waits do not raise the stall alert', async () => {
  const t = await setup({ STALL_ALERT_MINUTES: '1' });
  addJob(t, 'ai:ready', 60, { status: 'waiting', waiting_for: [5] });
  addJob(t, 'ai:ready', 61, { status: 'waiting', waiting_for_files: [3] });
  clock += 2 * HOUR;
  await t.dispatcher.tick();
  assert.equal(t.dispatcher.idleState().reasons.dependencies, 1);
  assert.equal(sent.length, 0);
  assert.equal(stallLines().length, 0);
});

test('a quota hold with nothing started for the stall time raises one stalled notification, and nothing before the time', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  clock += 89 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(sent.length, 0, 'the default is 90 minutes');
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'stalled');
  assert.match(sent[0].subject, /nothing has started for 91 min/);
  assert.match(sent[0].text, /1 held by a quota \(free\)/);
  assert.match(sent[0].text, /Waits on dependencies do not count/);
  assert.equal(stallLines().length, 1);
});

test('a stall alert is not repeated for six hours, and a nothing-waiting composition lets the next one through', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 100 * HOUR);
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  clock += 91 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(sent.length, 1);
  clock += 3 * HOUR;
  await t.dispatcher.tick();
  assert.equal(sent.length, 1, 'not again within six hours');
  clock += 3 * HOUR + MINUTE;
  await t.dispatcher.tick();
  assert.equal(sent.length, 2, 'again after six hours while the work still waits');
  // Nothing waits any more: the next stall is a new one, at once after its own quiet time.
  t.jobs.remove(t.jobs.list('queued')[0].id);
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.dispatcher.idleState(), null);
  addJob(t, 'ai:ready', 58);
  clock += 92 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(sent.length, 3, 'a composition that was empty in between lets the next alert through');
});

test('STALL_ALERT_MINUTES=0 switches the stall alert off', async () => {
  const t = await setup({ STALL_ALERT_MINUTES: '0' });
  t.dispatcher.cooldowns.set('free', clock + 100 * HOUR);
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  clock += 30 * HOUR;
  await t.dispatcher.tick();
  assert.equal(sent.length, 0);
  assert.equal(stallLines().length, 0);
  assert.equal(idleLines().length >= 1, true, 'the idle line itself is not switched off');
});

test('a running run keeps the stall alert quiet, and a start resets the quiet time', async () => {
  const t = await setup({ MAX_CONCURRENT_PER_TIER: '1' });
  t.dispatcher.cooldowns.set('cheap', clock + 100 * HOUR);
  addJob(t, 'ai:ready', 57);
  await t.dispatcher.tick();
  assert.equal(t.oh.started, 1);
  addJob(t, 'ai:cheap', 58);
  clock += 2 * HOUR;
  await t.dispatcher.tick();
  assert.equal(sent.length, 0, 'a run is running: nothing is stalled');
});

test('the status JSON carries the idle state only while work waits, with the tiers of the quota holds', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  addJob(t, 'ai:ready', 57);
  addJob(t, 'ai:ready', 58, { status: 'waiting', waiting_for: [5] });
  await t.dispatcher.tick();
  const status = buildStatus(t.config, t.jobs, clock, undefined, [], null, { idle: t.dispatcher.idleState() });
  assert.deepEqual(status.idle, {
    since: new Date(clock).toISOString(),
    reasons: { dependencies: 1, files: 0, quota: 1, disk: 0, hourly: 0, concurrency: 0, could_start: 0, cycle: 0, stuck: 0 },
    quota_tiers: ['free'],
    cycles: []
  });
  assert.equal('idle' in buildStatus(t.config, t.jobs, clock, undefined, [], null, {}), false);
  t.dispatcher.cooldowns.clear();
  t.jobs.remove(t.jobs.list('queued')[0].id);
  t.jobs.remove(t.jobs.list('waiting')[0].id);
  await t.dispatcher.tick();
  assert.equal('idle' in buildStatus(t.config, t.jobs, clock, undefined, [], null, { idle: t.dispatcher.idleState() }), false);
});

test('the idle gauge carries the eight reasons (stuck: a wait behind a blocked pull request, see stuck.ts), zero while nothing waits', async () => {
  const t = await setup();
  t.dispatcher.cooldowns.set('free', clock + 20 * HOUR);
  addJob(t, 'ai:ready', 57);
  await t.dispatcher.tick();
  const samples = gaugeSamples(t.config, t.jobs, t.dispatcher.cooldowns, clock, null, t.dispatcher.idleState()).filter((sample) => sample.name === 'forgehands_idle_jobs');
  assert.deepEqual(samples.map((sample) => [sample.labels.reason, sample.value]), [['dependencies', 0], ['files', 0], ['quota', 1], ['disk', 0], ['hourly', 0], ['concurrency', 0], ['cycle', 0], ['stuck', 0]]);
  const idle = gaugeSamples(t.config, t.jobs, t.dispatcher.cooldowns, clock, null, null).filter((sample) => sample.name === 'forgehands_idle_jobs');
  assert.equal(idle.every((sample) => sample.value === 0), true);
});
