// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The scheduler's clone breaker gate: while the breaker is not closed no new start leaves the queue, the hold has exactly one half-open trial,
// and a trial that cannot be confirmed reopens instead of leaving a second start behind.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { Notifier } from '../src/notify/index.ts';
import { CLONE_BREAKER_HOLD_MS } from '../src/agent/clone-breaker.ts';
import { metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const PLANNER = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/hello';
const quiet = { error() {} };
const HOUR = 60 * 60_000;

let dir;
let clock;
let logs;
let sent;
let apiCalls;
let forgeCalls;
let fileCount;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // the jobs below carry no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 80, max_budget: 1.5 },
    'ai:ready': { profile: WORKER, tier: 'free' }
  }),
  ERROR_RETRIES: '1',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// OpenHands: one conversation per accepted start, every other call answers 200 with an empty body.
function openhands() {
  const world = { started: 0, failStart: false };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    apiCalls.push({ method: request.method, path });
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') {
      if (world.failStart) return { ok: false, status: 503, json: async () => ({}) };
      world.started += 1;
      return reply(201, { id: 'conv-' + world.started });
    }
    if (request.method === 'GET' && /^\/api\/conversations\/[^/]+$/.test(path)) return reply(200, { execution_status: 'running', metrics: null, stats: { usage_to_metrics: {} } });
    return reply(200, {});
  };
  return world;
}

// Forgejo: reads answer an empty list, issue 57 is open, pull request 34 is open and unchanged.
const forgeSend = async (url, request) => {
  const path = new URL(url).pathname;
  forgeCalls.push({ method: request.method, path });
  const reply = (value) => ({ ok: true, status: 200, json: async () => value });
  if (request.method === 'GET' && /\/pulls\/\d+$/.test(path)) return reply({ number: 34, state: 'open', title: 'Fix', head: { ref: 'ai/issue-1', sha: 'cafe' } });
  if (request.method === 'GET' && /\/issues\/\d+$/.test(path)) return reply({ number: 57, state: 'open', labels: [{ name: 'ai:ready' }] });
  if (request.method === 'GET' && /\/issues\/\d+\/dependencies$/.test(path)) return reply([]);
  return reply(request.method === 'GET' ? [] : { id: 77 });
};

const issueEvent = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});

async function setup(extra = {}, file = 'jobs-' + (++fileCount) + '.json') {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, file));
  await jobs.load();
  const oh = openhands();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgeSend(url, request) : oh.send(url, request);
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const notifier = new Notifier([{ name: 'test', send: async (message) => { sent.push(message); } }], ['handover'], () => false, logger, () => {});
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock, notifier);
  return { config, jobs, dispatcher, oh, logger };
}

function addJob(t, label, number, patch = {}) {
  return t.jobs.add({ key: repo + '#' + number + ':' + label, label, event: { ...issueEvent(label, number), label }, status: 'queued', created: clock, attempts: 0, ...patch });
}

// Three confirmed failures in three conversations of two repositories open the breaker (CLONE_BREAKER_MIN_*).
async function trip(dispatcher) {
  await dispatcher.reportCloneFailure({ class: 'clone_failed', repository: 'owner/a', conversation: 'conv-1' }, 'owner/a');
  await dispatcher.reportCloneFailure({ class: 'clone_failed', repository: 'owner/a', conversation: 'conv-2' }, 'owner/a');
  return dispatcher.reportCloneFailure({ class: 'repository_not_found', repository: 'owner/b', conversation: 'conv-3' }, 'owner/b');
}

const starts = () => apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/conversations');
const idleLines = () => logs.filter((line) => line.startsWith('idle: '));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-clone-scheduler-')); clock = 1_000_000; logs = []; sent = []; apiCalls = []; forgeCalls = []; fileCount = 0; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('an open breaker holds the queued jobs of every route, without touching them, and counts the reason clone_breaker', async () => {
  const t = await setup();
  await trip(t.dispatcher);
  const plan = addJob(t, 'ai:plan', 70);
  const ready = addJob(t, 'ai:ready', 71);

  await t.dispatcher.tick();

  assert.equal(starts().length, 0, 'no start request reaches OpenHands while the breaker is open');
  assert.equal(t.oh.started, 0);
  assert.equal(plan.attempts, 0, 'a held job does not spend an attempt');
  assert.equal(ready.attempts, 0);
  assert.equal(plan.next_try, undefined, 'a held job gets no retry time');
  assert.equal(ready.next_try, undefined);
  assert.deepEqual(plan.event.issue.labels, ['ai:plan'], 'a held job keeps its labels');
  assert.deepEqual(ready.event.issue.labels, ['ai:ready']);
  assert.equal(t.jobs.list('queued').length, 2);
  assert.equal(t.dispatcher.idleState().reasons.clone_breaker, 2);
  assert.match(idleLines().at(-1), /2 held \(clone breaker\)/);
});

test('a running job is still polled and a deferred run is released while the breaker holds', async () => {
  const t = await setup();
  await trip(t.dispatcher);
  const running = t.jobs.add({ key: repo + '#60:ai:ready', label: 'ai:ready', event: issueEvent('ai:ready', 60), status: 'running', created: clock, started: clock, conversation_id: 'conv-run', attempts: 0 });
  const deferred = t.jobs.add({ key: repo + '#72:ai:ready', label: 'ai:ready', event: { ...issueEvent('ai:ready', 72), pull_request: { number: 34 } },
    status: 'waiting', waiting_for_run: true, created: clock, started: clock, conversation_id: 'conv-wait', attempts: 0 });

  await t.dispatcher.tick();

  assert.equal(apiCalls.some((call) => call.method === 'GET' && call.path === '/api/conversations/conv-run'), true, 'the running job is polled during the hold');
  assert.equal(running.status, 'running');
  assert.equal(deferred.waiting_for_run, undefined, 'releaseDeferred ran while the breaker held');
  assert.equal(deferred.status, 'queued');
  assert.equal(starts().length, 0);
});

test('after the hold exactly one of two queued jobs starts, the other stays queued behind the claimed trial', async () => {
  const t = await setup();
  await trip(t.dispatcher);
  addJob(t, 'ai:ready', 57);
  addJob(t, 'ai:ready', 58);

  clock += CLONE_BREAKER_HOLD_MS + 1;
  await t.dispatcher.tick();

  assert.equal(starts().length, 1, 'one half-open trial, not two');
  assert.equal(t.jobs.list('running').length, 1);
  assert.equal(t.jobs.list('queued').length, 1, 'the second job sees the claimed trial and stays queued');
  const running = t.jobs.list('running')[0];
  assert.equal(t.dispatcher.cloneBreaker.state(), 'half_open');
  assert.equal(t.jobs.meta.clone_breaker.trial.owner, running.id);
  assert.equal(t.jobs.meta.clone_breaker.trial.conversation, running.conversation_id);
});

test('a failed start of the half-open trial reopens the breaker', async () => {
  const t = await setup();
  await trip(t.dispatcher);
  const job = addJob(t, 'ai:ready', 57);
  t.oh.failStart = true;

  clock += CLONE_BREAKER_HOLD_MS + 1;
  await t.dispatcher.tick();

  assert.equal(starts().length, 1);
  assert.equal(job.attempts, 1, 'the existing attempt handling still runs');
  assert.equal(job.next_try, clock + 60_000, 'and the retry time is set');
  assert.equal(t.dispatcher.cloneBreaker.state(), 'open', 'an unanswered start is not positive evidence');
  assert.equal(t.jobs.meta.clone_breaker.trial, null, 'no trial is left claimed');
  assert.equal(t.jobs.list('queued').length, 1);
});

test('a restart in the middle of an unconfirmed claim reopens, so there is never a second trial', async () => {
  const first = await setup({}, 'restart.json');
  await trip(first.dispatcher);
  const job = addJob(first, 'ai:ready', 57);
  clock += CLONE_BREAKER_HOLD_MS + 1;
  assert.equal(await first.dispatcher.admitCloneTrial(job.id), true);
  assert.equal(first.jobs.meta.clone_breaker.trial.conversation, null);

  const second = await setup({}, 'restart.json');
  await second.dispatcher.pass();

  assert.equal(second.dispatcher.cloneBreaker.state(), 'open', 'the orphaned claim reopens');
  assert.equal(second.jobs.meta.clone_breaker.trial, null);
  assert.equal(await second.dispatcher.admitCloneTrial(job.id), false, 'an open breaker admits no trial');
  clock += CLONE_BREAKER_HOLD_MS + 1;
  assert.equal(await second.dispatcher.admitCloneTrial(job.id), true);
  assert.equal(await second.dispatcher.admitCloneTrial(job.id), false, 'only one trial can be claimed');
});

test('a dry run admits nothing, even when the hold has passed', async () => {
  const t = await setup({ DRY_RUN: '1' });
  await trip(t.dispatcher);
  const job = addJob(t, 'ai:ready', 57);

  clock += CLONE_BREAKER_HOLD_MS + 1;
  await t.dispatcher.tick();

  assert.equal(starts().length, 0);
  assert.equal(job.status, 'dry');
  assert.equal(t.dispatcher.cloneBreaker.state(), 'half_open');
  assert.equal(t.jobs.meta.clone_breaker.trial, null, 'a dry run claims no trial');
});

test('a trial whose claim the ledger cannot hold starts nothing and spends no attempt', async () => {
  const t = await setup();
  await trip(t.dispatcher);
  const job = addJob(t, 'ai:ready', 57);
  clock += CLONE_BREAKER_HOLD_MS + 1;
  // A real store write failure: the ledger's directory path is a regular file, so the directory cannot be created.
  const blocked = join(dir, 'blocked-ledger');
  await writeFile(blocked, 'not a directory');
  t.jobs.file = join(blocked, 'jobs.json');

  assert.equal(await t.dispatcher.admitCloneTrial(job.id), false);
  assert.equal(t.jobs.meta.clone_breaker.trial, null, 'the claim the ledger did not take is given back');
  assert.equal(await t.dispatcher.startJob(job, clock), false);
  assert.equal(starts().length, 0, 'no conversation start is sent without a durable claim');
  assert.equal(job.attempts, 0, 'no attempt is spent');
  assert.equal(job.status, 'queued');
  assert.equal(t.dispatcher.cloneBreaker.state(), 'half_open');
});
