// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The nudge is a message to a running conversation, which answers after the agent's current step: it gets NUDGE_TIMEOUT_SECONDS, is delivered in the
// background, and a timeout is checked in the events (by a marker) before any resend.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const MINUTE = 60000;
const ROUTES = { 'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 } };
let dir; let clock; let logs; let n = 0;

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

// The way the fake OpenHands answers a message to a running conversation:
// 'ok' stores it at once; 'slow' answers after 150 ms; 'store-timeout' stores it and then never answers (the call times out);
// 'drop-timeout' never answers and stores nothing; 'hold' answers only when the test releases it; 'refuse' answers 409 once.
const DOMAIN_TIMEOUT = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
function hang(signal) {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(DOMAIN_TIMEOUT())));
}
function openhands() {
  const world = { mode: 'ok', stored: [], posts: [], refuses: 0, counts: {}, started: 0, release: null };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') { world.started += 1; return reply(201, { id: 'conv-' + world.started }); }
    const [, id, action] = /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/.exec(path) || [];
    if (!id) return reply(404, {});
    if (action === 'events' && request.method === 'POST') {
      const text = JSON.parse(request.body).content[0].text;
      world.posts.push(text);
      if (world.refuses > 0) { world.refuses -= 1; return reply(409, {}); }
      if (world.mode === 'ok') { world.stored.push(text); return reply(200, {}); }
      if (world.mode === 'slow') { await new Promise((resolve, reject) => { const t = setTimeout(resolve, 150); request.signal.addEventListener('abort', () => { clearTimeout(t); reject(DOMAIN_TIMEOUT()); }); }); world.stored.push(text); return reply(200, {}); }
      if (world.mode === 'store-timeout') { world.stored.push(text); await hang(request.signal); }
      if (world.mode === 'drop-timeout') await hang(request.signal);
      if (world.mode === 'hold') { await world.release; world.stored.push(text); return reply(200, {}); }
    }
    if (request.method === 'GET' && action === 'events/count') return reply(200, world.counts[id] ?? 0);
    if (request.method === 'GET' && action === 'events/search') {
      return reply(200, { items: world.stored.map((text) => ({ kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text }] } })) });
    }
    if (request.method === 'GET' && !action) return reply(200, { execution_status: 'running', stats: { usage_to_metrics: {} } });
    return reply(200, {});
  };
  return world;
}

const forgeSend = async (url, request) => {
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  const path = new URL(url).pathname;
  if (request.method === 'GET' && /\/branches\//.test(path)) return { ok: false, status: 404, json: async () => ({}) };
  return reply(request.method === 'GET' ? [] : { id: 77 });
};

// Timeouts are shortened for the tests: the normal call timeout, and the nudge's.
async function setup({ timeoutMs = 50, nudgeTimeoutMs = 300 } = {}) {
  const config = loadConfig(env());
  config.timeoutMs = timeoutMs;
  config.nudgeTimeoutMs = nudgeTimeoutMs;
  config.nudgeAtPercent = 65;
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const oh = openhands();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgeSend(url, request) : oh.send(url, request);
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher, oh };
}

const issueEvent = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
async function startWorker(t) {
  await t.dispatcher.enqueue(issueEvent('ai:ready'));
  await t.dispatcher.tick();
  return t.jobs.list('running')[0];
}
// Waits for the background nudge deliveries of the dispatcher to end.
const settle = (t) => Promise.all([...t.dispatcher.nudgeInflight.values()]);
const logged = (text) => logs.some((line) => line.includes(text));
const countLogs = (text) => logs.filter((line) => line.includes(text)).length;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-nudge-timeout-')); clock = 1_000_000; logs = []; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a slow answer, longer than the normal timeout and shorter than NUDGE_TIMEOUT_SECONDS, delivers the nudge once', async () => {
  const t = await setup({ timeoutMs: 50, nudgeTimeoutMs: 1000 });
  t.oh.mode = 'slow';
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(t.oh.posts.length, 1, 'sent once, not resent');
  assert.equal(t.oh.stored.length, 1);
  assert.equal(job.nudged, 26);
  assert.equal(job.nudge_pending, undefined);
  assert.ok(logged(job.key + ': nudged at 26/40 actions, no branch yet'));
});

test('a timeout where the events hold the marker: confirmed, not sent again', async () => {
  const t = await setup({ nudgeTimeoutMs: 60 });
  t.oh.mode = 'store-timeout';
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(t.oh.posts.length, 1, 'the message is not resent');
  assert.equal(job.nudged, 26);
  assert.ok(logged(job.key + ': nudge pending (timeout), checking the events'));
  assert.ok(logged(job.key + ': nudge confirmed in the events'));
  assert.equal(job.nudge_pending, undefined);
  assert.equal(countLogs('nudged at 26/40'), 1);
});

test('a timeout where the events do not hold the marker: one resend, then no more nudges for the run', async () => {
  const t = await setup({ nudgeTimeoutMs: 60 });
  t.oh.mode = 'drop-timeout';
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(t.oh.posts.length, 2, 'the first send and one resend');
  assert.equal(t.oh.posts[0].split(' ').at(-1), t.oh.posts[1].split(' ').at(-1), 'the resend carries the same marker');
  assert.equal(job.nudge_gave_up, true);
  assert.equal(job.nudged, undefined);
  assert.ok(logged('the nudge was not delivered after 2 tries, no more nudges for this run'));
  // The run is not nudged again, however often it is looked at.
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(t.oh.posts.length, 2);
});

test('the dispatch loop is not blocked while a nudge is in flight; a second look sends nothing more', async () => {
  const t = await setup();
  t.oh.mode = 'hold';
  let release;
  t.oh.release = new Promise((resolve) => { release = resolve; });
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.dispatcher.nudgeInflight.size, 1, 'the nudge runs in the background');
  assert.equal(t.oh.posts.length, 1, 'the message is on its way');
  assert.equal(job.nudged, undefined, 'not yet delivered');
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  await t.dispatcher.tick();
  assert.equal(t.oh.posts.length, 1, 'no second nudge while one is in flight');
  release();
  await settle(t);
  assert.equal(job.nudged, 26);
  assert.equal(t.dispatcher.nudgeInflight.size, 0);
});

test('a refusal (HTTP 409) is not a delivery: the next look counts and tries again', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  t.oh.refuses = 1;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(job.nudged, undefined);
  assert.equal(job.nudge_pending, undefined);
  assert.ok(logged('nudge refused (HTTP 409), trying again on the next look'));
  clock += MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(job.nudged, 26);
  assert.equal(t.oh.posts.length, 2);
});

test('after a restart a pending nudge is looked for in the events before anything is sent', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  // The state a timeout left in the ledger: one send, its marker, nothing known yet.
  job.nudge_pending = { marker: '[forgehands-nudge abcd1234]', tries: 1, used: 26, max: 40 };
  t.oh.stored.push('You have used 26 of 40 actions ... [forgehands-nudge abcd1234]');
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await settle(t);
  assert.equal(t.oh.posts.length, 0, 'the message was stored: nothing is sent');
  assert.equal(job.nudged, 26);
  assert.equal(job.nudge_pending, undefined);
});

test('NUDGE_TIMEOUT_SECONDS defaults to 180 seconds and accepts 10 to 600 only', () => {
  assert.equal(loadConfig(env()).nudgeTimeoutMs, 180000);
  assert.equal(loadConfig(env({ NUDGE_TIMEOUT_SECONDS: '30' })).nudgeTimeoutMs, 30000);
  assert.throws(() => loadConfig(env({ NUDGE_TIMEOUT_SECONDS: '9' })), /NUDGE_TIMEOUT_SECONDS must be an integer from 10 to 600/);
  assert.throws(() => loadConfig(env({ NUDGE_TIMEOUT_SECONDS: '601' })), /NUDGE_TIMEOUT_SECONDS/);
});
