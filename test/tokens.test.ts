// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Token metrics: the tokens of a run's conversations (OpenHands' stats, every LLM call of every usage id) are counted when the run ends, per
// repository, the tier it really ran on, the route kind and the type; the ledger keeps the totals and /status.json the 7-day sums per tier.
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher, tokenUsage } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';
import { buildStatus } from '../src/server/status.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const CHANGES = '44444444-4444-4444-8444-444444444444';
const repo = 'owner/hello';
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const ROUTES = {
  'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 },
  'ai:cheap': { profile: WORKER, tier: 'cheap', max_iterations: 40 },
  'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request' }
};
let dir; let clock; let n = 0;

const env = () => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  ERROR_RETRIES: '1',
  DATA_FILE: join(dir, 'deliveries.json')
});

// One LLM call of a conversation, as OpenHands reports it.
const call = (prompt, completion, cache = 0, reasoning = 0, cacheWrite = 0) => ({
  prompt_tokens: prompt, completion_tokens: completion, cache_read_tokens: cache, cache_write_tokens: cacheWrite, reasoning_tokens: reasoning
});

// OpenHands: each conversation has a state, a usage (stats.usage_to_metrics) and can answer a read with an error (`failRead`).
function openhands() {
  const world = { states: {}, usage: {}, failRead: false, started: 0 };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') { world.started += 1; return reply(201, { id: 'conv-' + world.started }); }
    const [, id, action] = /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/.exec(path) || [];
    if (!id) return reply(404, {});
    if (request.method === 'GET' && !action) {
      if (world.failRead) return reply(500, {});
      return reply(200, { execution_status: world.states[id] || 'running', stats: { usage_to_metrics: world.usage[id] || {} } });
    }
    if (action === 'events/search') return reply(200, { items: [] });
    return reply(200, {});
  };
  return world;
}

// Forgejo: reads answer an empty list.
const forgeSend = async (url, request) => {
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  return reply(request.method === 'GET' ? [] : { id: 77 });
};

async function setup() {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const oh = openhands();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgeSend(url, request) : oh.send(url, request);
  const logger = { error() {} };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher, oh };
}

const event = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
// A running job on a conversation, inserted directly (a round of a pull request: it ends without a delivery check).
function addRunning(t, label, conversation, patch = {}) {
  return t.jobs.add({ key: repo + '#26:' + label, label, event: { ...event(label, 26), pull_request: { number: 34, head_ref: 'ai/issue-26', html_url: null }, label },
    status: 'running', created: clock, started: clock, conversation_id: conversation, attempts: 0, ...patch });
}
const counter = (labels) => {
  const key = 'forgehands_tokens_total{' + Object.entries(labels).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + '="' + v + '"').join(',') + '}';
  return metrics.counters.get(key) || 0;
};
const tokens = (type, extra = {}) => counter({ kind: 'pull_request', repository: repo, tier: 'free', type, ...extra });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-tokens-')); clock = 1_000_000; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('the counters add up the LLM calls of two usage ids, per type, when the run ends', async () => {
  const t = await setup();
  const job = addRunning(t, 'ai:changes', 'conv-r1');
  t.oh.usage['conv-r1'] = {
    default: { token_usages: [call(1000, 100, 400, 0, 7), call(1200, 150, 900, 30, 0)] },
    condenser: { token_usages: [call(300, 20, 0, 5, 3)] }
  };
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'a running conversation adds nothing yet');
  assert.equal(tokens('prompt'), 0);
  t.oh.states['conv-r1'] = 'finished';
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(tokens('prompt'), 2500);
  assert.equal(tokens('completion'), 270);
  assert.equal(tokens('cache_read'), 1300);
  assert.equal(tokens('reasoning'), 35);
  assert.deepEqual(job.tokens, { prompt: 2500, completion: 270, cache_read: 1300, cache_write: 10, reasoning: 35 });
  assert.deepEqual(job.tokens_seen, { prompt: 2500, completion: 270, cache_read: 1300, cache_write: 10, reasoning: 35 });
});

test('the tier of a fallback run is the tier it really ran on, and the kind is the route kind', async () => {
  const t = await setup();
  addRunning(t, 'ai:changes', 'conv-f1', { fell_back: 'ai:cheap' });
  t.oh.usage['conv-f1'] = { default: { token_usages: [call(50, 5)] } };
  t.oh.states['conv-f1'] = 'finished';
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(counter({ kind: 'pull_request', repository: repo, tier: 'cheap', type: 'prompt' }), 50);
  assert.equal(tokens('prompt'), 0, 'nothing is counted on the own route tier');
});

test('a conversation read that fails adds nothing, and the next good read counts the run', async () => {
  const t = await setup();
  const job = addRunning(t, 'ai:changes', 'conv-e1');
  t.oh.usage['conv-e1'] = { default: { token_usages: [call(70, 7)] } };
  t.oh.states['conv-e1'] = 'finished';
  t.oh.failRead = true;
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(tokens('prompt'), 0);
  t.oh.failRead = false;
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(tokens('prompt'), 70);
});

test('a continued run adds only the tokens that came after its continuation', async () => {
  const t = await setup();
  const job = addRunning(t, 'ai:changes', 'conv-c1');
  t.oh.usage['conv-c1'] = { default: { token_usages: [call(100, 10)] } };
  t.oh.states['conv-c1'] = 'stuck';
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1, 'the stuck run is continued on its conversation');
  assert.equal(tokens('prompt'), 100, 'what the stuck run used is counted at its stop');
  t.oh.states['conv-c1'] = 'finished';
  t.oh.usage['conv-c1'] = { default: { token_usages: [call(100, 10), call(40, 4)] } };
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(tokens('prompt'), 140, 'the continuation adds 40, the first 100 are not counted twice');
  assert.equal(tokens('completion'), 14);
  assert.equal(job.tokens.prompt, 140);
});

test('a new conversation after an error starts its own count; the first one is kept', async () => {
  const t = await setup();
  const job = addRunning(t, 'ai:changes', 'conv-x1');
  t.oh.usage['conv-x1'] = { default: { token_usages: [call(30, 3)] } };
  t.oh.states['conv-x1'] = 'error';
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'queued', 'an error is run once more');
  assert.equal(tokens('prompt'), 30);
  // The fake OpenHands numbers its conversations from 1: the new one is conv-1 (the old one was conv-x1, inserted by the test).
  t.oh.usage['conv-1'] = { default: { token_usages: [call(20, 2)] } };
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.conversation_id, 'conv-1');
  t.oh.states['conv-1'] = 'finished';
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(tokens('prompt'), 50);
  assert.equal(job.tokens.prompt, 50);
});

test('tokenUsage sums every usage id and LLM call, and is null without usage', () => {
  assert.equal(tokenUsage({ stats: { usage_to_metrics: {} } }).prompt, 0);
  assert.equal(tokenUsage({ stats: {} }), null);
  assert.deepEqual(tokenUsage({ metrics: { usage_to_metrics: { default: { token_usages: [call(1, 2, 3, 4, 5)] }, condenser: { token_usages: [call(10, 20)] } } } }),
    { prompt: 11, completion: 22, cache_read: 3, cache_write: 5, reasoning: 4 });
});

test('/status.json adds the tokens of the last 7 days per repository and tier, and leaves older runs out', async () => {
  const t = await setup();
  const eventOf = (label, number) => ({ ...event(label, number), label });
  t.jobs.add({ key: repo + '#57:ai:ready', label: 'ai:ready', event: eventOf('ai:ready', 57), status: 'done', created: clock - 2 * DAY, started: clock - 2 * DAY, finished: clock - 2 * DAY + MINUTE,
    tokens: { prompt: 100, completion: 10, cache_read: 5, cache_write: 1, reasoning: 2 }, attempts: 0 });
  t.jobs.add({ key: repo + '#58:ai:ready', label: 'ai:ready', event: eventOf('ai:ready', 58), status: 'done', created: clock - 3 * DAY, started: clock - 3 * DAY, finished: clock - 3 * DAY + MINUTE,
    tokens: { prompt: 50, completion: 5, cache_read: 0, cache_write: 0, reasoning: 0 }, attempts: 0 });
  t.jobs.add({ key: repo + '#59:ai:ready', label: 'ai:ready', event: eventOf('ai:ready', 59), status: 'done', created: clock - 10 * DAY, started: clock - 10 * DAY, finished: clock - 10 * DAY + MINUTE,
    tokens: { prompt: 9999, completion: 9999, cache_read: 9999, cache_write: 0, reasoning: 0 }, attempts: 0 });
  t.jobs.add({ key: repo + '#60:ai:cheap', label: 'ai:cheap', event: eventOf('ai:cheap', 60), status: 'done', created: clock - DAY, started: clock - DAY, finished: clock - DAY + MINUTE,
    tokens: { prompt: 7, completion: 1, cache_read: 2, cache_write: 0, reasoning: 0 }, attempts: 0 });
  const status = buildStatus(t.config, t.jobs, clock);
  const tiers = status.summary[repo].tiers;
  assert.deepEqual(tiers.free.tokens, { prompt: 150, completion: 15, cache_read: 5 });
  assert.deepEqual(tiers.cheap.tokens, { prompt: 7, completion: 1, cache_read: 2 });
  assert.equal(tiers.free.last_30_days.started, 3, 'the runs of 30 days are still counted in the window');
});
