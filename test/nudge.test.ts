// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// NUDGE_AT_PERCENT: a worker run that has used its share of the iteration limit without a pushed branch is told once to stop exploring and push.
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
const PLANNER = '11111111-1111-4111-8111-111111111111';
const CHANGES = '44444444-4444-4444-8444-444444444444';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const ROUTES = {
  'ai:ready': { profile: WORKER, tier: 'free', max_iterations: 40 },
  'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 60 },
  'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request' },
  'ai:review': { profile: REVIEWER, tier: 'free', max_iterations: 50, on: 'ci_success' }
};
const MINUTE = 60000;
let dir; let clock; let logs; let n = 0;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  MAX_CONCURRENT_PER_TIER: '5',
  ERROR_RETRIES: '1',
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// OpenHands: the conversations with their state, the event counts, the messages and the runs. `countStatus` makes the count call fail.
function openhands() {
  const world = { states: {}, counts: {}, countStatus: 200, countCalls: 0, messages: [], runs: [], started: 0 };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const body = request.body ? JSON.parse(request.body) : undefined;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') {
      world.started += 1;
      return reply(201, { id: 'conv-' + world.started });
    }
    const [, id, action] = /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/.exec(path) || [];
    if (!id) return reply(404, {});
    if (action === 'events' && request.method === 'POST') { world.messages.push({ id, text: body.content[0].text, run: body.run }); return reply(200, {}); }
    if (action === 'run' && request.method === 'POST') { world.runs.push(id); return reply(200, {}); }
    if (action === 'events/count') {
      world.countCalls += 1;
      if (world.countStatus !== 200) return reply(world.countStatus, {});
      return reply(200, world.counts[id] ?? 0);
    }
    if (action === 'events/search') return reply(200, { items: [] });
    if (request.method === 'GET' && !action) return reply(200, { execution_status: world.states[id] || 'running', stats: { usage_to_metrics: {} } });
    return reply(404, {});
  };
  return world;
}

// Forgejo: the branches that exist (their names), reads that fail when `unreadable` is set. Other reads answer an empty list.
function forgejo() {
  const world = { branches: new Set(), unreadable: false, calls: [] };
  world.send = async (url, request) => {
    const path = new URL(url).pathname.replace(API, '');
    world.calls.push({ method: request.method, path });
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'GET' && world.unreadable) return reply(503, {});
    const branch = /^\/branches\/(.+)$/.exec(path);
    if (request.method === 'GET' && branch) {
      const name = decodeURIComponent(branch[1]);
      return world.branches.has(name) ? reply(200, { name, commit: { id: 'c0ffee' } }) : reply(404, { message: 'branch does not exist' });
    }
    const issue = /^\/issues\/(\d+)$/.exec(path);
    if (request.method === 'GET' && issue) return reply(200, { number: Number(issue[1]), state: 'open', labels: [{ id: 1, name: 'ai:ready' }] });
    if (request.method === 'GET') return reply(200, []);
    return reply(201, { id: 77 });
  };
  return world;
}

async function setup(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (n++) + '.json'));
  await jobs.load();
  const oh = openhands();
  const forge = forgejo();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forge.send(url, request) : oh.send(url, request);
  const logger = { error(...args) { logs.push(args.join(' ')); } };
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher, oh, forge, logger };
}

const issueEvent = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
// A job that is already running on a conversation, for the routes that are not started by a plain label event here.
function addRunning(t, label, event, conversation) {
  return t.jobs.add({ key: repo + '#' + event.issue.number + ':' + label, label, event: { ...event, label }, status: 'running', created: clock, started: clock,
    conversation_id: conversation, attempts: 0 });
}
const nudges = (t) => t.oh.messages.filter((message) => message.text.startsWith('You have used') || message.text.startsWith('Stop.'));
const logged = (text) => logs.some((line) => line.includes(text));
const nudgeSeries = () => (/forgehands_nudges_total\{kind="issue"\} (\d+)/.exec(metrics.render()) || [])[1];

// Starts one worker run on issue 57 and returns its job.
async function startWorker(t) {
  await t.dispatcher.enqueue(issueEvent('ai:ready'));
  await t.dispatcher.tick();
  return t.jobs.list('running')[0];
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-nudge-')); clock = 1_000_000; logs = []; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a worker run at the threshold without a branch is nudged once, with the counted actions', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26; // 65 % of 40 actions
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 1);
  assert.match(nudges(t)[0].text, /You have used 26 of 40 actions and have not pushed a branch yet/);
  assert.equal(nudges(t)[0].run, false, 'the message goes in without a run call; the agent is running already');
  assert.equal(job.nudged, 26);
  assert.equal(nudgeSeries(), '1');
  assert.ok(logged(job.key + ': nudged at 26/40 actions, no branch yet'));
});

test('a run below the threshold is not nudged', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 25;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.equal(job.nudged, undefined);
});

test('a run whose branch ai/issue-<n> exists is not nudged, and is not counted again', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.forge.branches.add('ai/issue-57');
  t.oh.counts[job.conversation_id] = 30;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.equal(job.nudge_settled, true);
  const calls = t.oh.countCalls;
  clock += 5 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.oh.countCalls, calls, 'a settled run is no longer counted');
});

test('a run is nudged once, even when it goes on past the threshold', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  t.oh.counts[job.conversation_id] = 60;
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 1);
  assert.equal(t.oh.countCalls, 1, 'a nudged run is not counted again');
});

test('the run is counted at most once a minute, and not before it is three minutes old', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 10;
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.oh.countCalls, 0, 'a run younger than three minutes is not counted');
  clock += 1 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.oh.countCalls, 1);
  await t.dispatcher.tick();
  assert.equal(t.oh.countCalls, 1, 'a second look in the same minute counts nothing');
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(t.oh.countCalls, 2);
});

test('rounds, reviews and planner runs are never nudged', async () => {
  const t = await setup();
  const round = addRunning(t, 'ai:changes', { ...issueEvent('ai:changes', 26), pull_request: { number: 34, head_ref: 'ai/issue-26', html_url: null } }, 'conv-round');
  const review = addRunning(t, 'ai:review', { ...issueEvent('ai:review', 26), type: 'ci.success', ci: { commit_sha: 'abc', status: 'success' } }, 'conv-review');
  const planner = addRunning(t, 'ai:plan', issueEvent('ai:plan', 60), 'conv-plan');
  for (const id of ['conv-round', 'conv-review', 'conv-plan']) t.oh.counts[id] = 500;
  clock += 10 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.equal(round.nudged, undefined);
  assert.equal(review.nudged, undefined);
  assert.equal(planner.nudged, undefined);
  assert.equal(t.oh.countCalls, 0, 'the actions of these runs are not even counted');
});

test('NUDGE_AT_PERCENT=0 switches the nudge off: no count, no message', async () => {
  const t = await setup({ NUDGE_AT_PERCENT: '0' });
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 500;
  clock += 10 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.equal(t.oh.countCalls, 0);
});

test('a count that fails means unknown: nothing is sent, and the next look nudges when the count works', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.countStatus = 500;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.ok(logged('actions not counted, no nudge yet'));
  t.oh.countStatus = 200;
  t.oh.counts[job.conversation_id] = 40;
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 1);
});

test('a forge read that fails means unknown: nothing is sent', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 40;
  t.forge.unreadable = true;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 0);
  assert.equal(job.nudged, undefined);
  assert.ok(logged('the branch is not read, no nudge yet'));
});

test('the count may come as a bare number or as {count}', async () => {
  const t = await setup();
  const job = await startWorker(t);
  const send = t.oh.send;
  t.oh.send = async (url, request) => {
    if (/\/events\/count/.test(url)) return { ok: true, status: 200, json: async () => ({ count: 30 }) };
    return send(url, request);
  };
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.nudged, 30);
});

test('the default message names the actions, the branch and the way out', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 27;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  // The marker of the delivery (a short id) is added after the text; it is what a timed out nudge is looked for by.
  const text = nudges(t)[0].text.replace(/ \[forgehands-nudge [0-9a-f]{8}\]$/, '');
  assert.equal(text, 'You have used 27 of 40 actions and have not pushed a branch yet. Stop exploring. Implement the smallest change that meets the acceptance check, '
    + 'commit and push it to the branch ai/issue-57 and open the draft pull request; or, if something blocks you, write a comment on the issue that names the exact blocker '
    + 'and finish. Do not start new investigations.');
});

test('NUDGE_MESSAGE replaces the text, with {used}, {max} and {branch} filled in', async () => {
  const t = await setup({ NUDGE_MESSAGE: 'Stop. {used} of {max} on {branch}: push now.' });
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.match(nudges(t)[0].text, /^Stop\. 26 of 40 on ai\/issue-57: push now\. \[forgehands-nudge [0-9a-f]{8}\]$/);
});

test('the nudge flag survives a ledger round trip', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  await t.jobs.persist(clock);
  const reloaded = new JobStore(t.jobs.file);
  await reloaded.load();
  const again = reloaded.list('running')[0];
  assert.equal(again.nudged, 26);
  assert.equal(again.key, job.key);
});

test('a resumed run keeps the flag of its conversation: the resume sends its own message, the nudge does not come again', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  t.oh.states[job.conversation_id] = 'stuck';
  clock += MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  assert.equal(t.oh.messages.filter((message) => message.text.startsWith('The run stopped as stuck')).length, 1);
  t.oh.states[job.conversation_id] = 'running';
  t.oh.counts[job.conversation_id] = 70;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(nudges(t).length, 1);
  assert.equal(job.nudged, 26);
});

test('a new conversation of the same job is nudged again', async () => {
  const t = await setup();
  const job = await startWorker(t);
  t.oh.counts[job.conversation_id] = 26;
  clock += 3 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.nudged, 26);
  // The run ends in an error and is started once more: a new conversation.
  t.oh.states[job.conversation_id] = 'error';
  clock += MINUTE;
  await t.dispatcher.tick();
  clock += 2 * MINUTE;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.notEqual(job.conversation_id, 'conv-1');
  assert.equal(job.nudged, undefined, 'the flag belongs to the conversation that was nudged');
  assert.equal(job.nudge_settled, undefined);
});
