// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// PLAN_ANSWER_RESTARTS: a comment of HUMAN_LOGIN answers a planner that finished without sub-issues, and the planner starts again.
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
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { metrics } from '../src/metrics.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const quiet = { error() {} };
let dir; let clock; let runs; let states; let counter = 0;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 80 },
    'ai:ready': { profile: WORKER, tier: 'free' }
  }),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  HUMAN_LOGIN: 'marcel',
  RESUME_ATTEMPTS: '0',
  ...extra
});

// A fake Forgejo: `routes` maps "METHOD path" to a value, a function, or {__status}; unknown calls answer 404.
function fakeForgejo(routes) {
  const calls = [];
  const send = async (url, request) => {
    const u = new URL(url);
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ method: request.method, path: u.pathname, body });
    const route = routes[request.method + ' ' + u.pathname];
    if (route === undefined) return { ok: false, status: 404 };
    const value = typeof route === 'function' ? route(u, body) : route;
    if (value && value.__status) return { ok: false, status: value.__status };
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, send };
}

// The forge's view of issue 26 (state, labels, sub-issues) can be changed by a test; OpenHands answers as a running conversation.
async function build(extra = {}, logger = quiet) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const issue = { state: 'open', labels: ['ai:plan'], dependencies: [], blocks: [] };
  const forgejo = fakeForgejo({
    ['GET ' + API + '/issues/26']: () => ({ number: 26, state: issue.state, labels: issue.labels.map((name) => ({ name })) }),
    ['GET ' + API + '/issues/26/dependencies']: () => issue.dependencies,
    ['GET ' + API + '/issues/26/blocks']: () => issue.blocks,
    ['POST ' + API + '/issues/26/comments']: {},
    ['GET ' + API + '/pulls']: [],
    ['GET ' + API + '/labels']: []
  });
  const api = async (url, request) => {
    runs.push({ method: request.method, path: new URL(url).pathname, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + runs.length }) };
    return { ok: true, status: 200, json: async () => ({ execution_status: states[new URL(url).pathname.split('/').pop()] || 'running', stats: { usage_to_metrics: {} } }) };
  };
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher, issue, forgejo };
}
const event = (label, number = 26) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'Epic', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
const starts = () => runs.filter((call) => call.method === 'POST' && call.path.startsWith('/api/conversations'));
// Ends the last run of the ledger with `end` ("finished" makes it done).
async function endLast(t, end = 'finished') {
  await t.dispatcher.tick();
  const job = t.jobs.list().at(-1);
  states[job.conversation_id] = end;
  await t.dispatcher.tick();
  return t.jobs.list().at(-1);
}
let deliveries = 0;
// One delivery of a comment of `login` on issue 26, as Forgejo sends it to the webhook.
async function postComment(t, { login = 'marcel', id = 601, number = 26, action = 'created', pull = false } = {}) {
  const store = new DeliveryStore(t.config.dataFile);
  const server = createApp(t.config, store, undefined, quiet, t.dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = JSON.stringify({ action, sender: { login }, repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
      issue: { number, title: 'Epic', body: 'B', state: 'open', labels: t.issue.labels.map((name) => ({ name })), ...(pull ? { pull_request: { merged: false } } : {}) },
      comment: { id, body: 'my answers', user: { login } } });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', { method: 'POST', body: raw, headers: {
      'content-type': 'application/json', 'x-forgejo-event': 'issue_comment', 'x-gitea-delivery': 'pa-' + (++deliveries),
      'x-forgejo-signature': createHmac('sha256', t.config.forgejoSecret).update(raw).digest('hex') } });
    return (await response.json()).status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
// The same comment straight to the dispatcher (what the webhook hands it after normalizing).
const answer = (t, { login = 'marcel', id = 601, label, number = 26 } = {}) => t.dispatcher.onComment({
  type: 'issues.commented', source: 'forgejo', action: 'created', repository: { full_name: repo, default_branch: 'main' },
  issue: { number, title: 'Epic', body: 'B', html_url: null, comments: 0, labels: label ? [label] : [] }, comment: { id: String(id), login }, sender: { login }
});
const notices = (t) => t.forgejo.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && c.body.body.includes('PLAN_ANSWER_RESTARTS='));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-plan-answers-')); clock = Date.parse('2026-11-18T12:00:00Z'); runs = []; states = {}; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('a planner that finished without sub-issues starts again on the answer of the operator, and the run is told so', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  assert.equal((await endLast(t)).status, 'done');
  assert.equal(await postComment(t, { id: 601 }), 'queued');
  await t.dispatcher.tick();
  assert.equal(starts().length, 2);
  const again = starts().at(-1);
  assert.equal(again.body.agent_profile_id, PLANNER);
  const job = t.jobs.list().at(-1);
  assert.equal(job.label, 'ai:plan');
  assert.equal(job.event.plan_answer, true);
  assert.equal(job.event.comment, undefined, 'the comment does not count as a COMMENT_RESTARTS restart');
  const line = 'You are started again because the operator commented. Read ALL comments of the epic first; his answers are binding; do not ask a question that was answered; ask only what is still open.';
  assert.match(again.body.initial_message.content[0].text, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!again.body.initial_message.content[0].text.includes('This run starts again because'));
  assert.equal(t.jobs.noted('comment:owner/hello#26#601'), true);
});

test('the message of the restarted planner has the line, and a first run has none', () => {
  const config = loadConfig(env());
  const first = buildPrompt(event('ai:plan'), config);
  assert.ok(!first.includes('You are started again'));
  const answered = buildPrompt({ ...event('ai:plan'), plan_answer: true }, config);
  assert.match(answered, /You are started again because the operator commented\. Read ALL comments of the epic first; his answers are binding;/);
});

test('no restart when the planner created sub-issues', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  assert.deepEqual(t.jobs.list().at(-1).deps_before, [], 'the snapshot of the run: no dependencies when it started');
  t.issue.dependencies = [{ number: 27, state: 'open' }];
  assert.equal(await answer(t, { label: 'ai:plan' }), 'has_sub_issues');
  assert.equal(t.jobs.list().length, 1);
});

test('a planner that blocks other issues, and has dependencies from before it ran, is restarted by the answer', async () => {
  const t = await build();
  // #26 depends on two earlier tickets of its epic (closed, so the planner is not held back) and blocks the next ticket and its epic
  t.issue.dependencies = [{ number: 56, state: 'closed' }, { number: 57, state: 'closed' }];
  t.issue.blocks = [{ number: 60, state: 'open' }, { number: 47, state: 'open' }];
  await t.dispatcher.enqueue(event('ai:plan'));
  assert.equal((await endLast(t)).status, 'done');
  assert.deepEqual(t.jobs.list().at(-1).deps_before, [56, 57]);
  assert.equal(await answer(t, { label: 'ai:plan' }), 'queued');
  await t.dispatcher.tick();
  assert.equal(starts().length, 2, 'the planner starts again');
  assert.equal(t.jobs.list().at(-1).event.plan_answer, true);
});

test('a planner that created sub-issues is not restarted, even with blocks and earlier dependencies', async () => {
  const t = await build();
  t.issue.dependencies = [{ number: 56, state: 'closed' }];
  t.issue.blocks = [{ number: 60, state: 'open' }];
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  t.issue.dependencies = [{ number: 56, state: 'closed' }, { number: 58, state: 'open' }];
  assert.equal(await answer(t, { label: 'ai:plan' }), 'has_sub_issues');
  assert.equal(starts().length, 1);
});

test('every planner run has its own snapshot: a dependency from before the first run does not block the answers to the runs after it', async () => {
  const t = await build();
  t.issue.dependencies = [{ number: 56, state: 'closed' }];
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  assert.deepEqual(t.jobs.list().at(-1).deps_before, [56]);
  assert.equal(await answer(t, { label: 'ai:plan' }), 'queued', 'the first answer restarts the planner');
  assert.equal(starts().length, 2);
  await endLast(t);
  assert.deepEqual(t.jobs.list().at(-1).deps_before, [56], 'the restarted run starts with the same dependencies');
  assert.equal(await answer(t, { id: 613, label: 'ai:plan' }), 'queued', 'and so does the next answer');
  assert.equal(starts().length, 3);
});

test('a job from before the snapshot: dependencies created after its run started count, earlier ones do not', async () => {
  const t = await build();
  t.issue.dependencies = [{ number: 56, state: 'closed', created_at: '2026-11-18T11:00:00Z' }];
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  delete t.jobs.list().at(-1).deps_before;
  assert.equal(await answer(t, { label: 'ai:plan' }), 'queued', 'an earlier dependency is not a sub-issue of this run');
  await endLast(t); // the restarted run (its snapshot is taken again) ends
  delete t.jobs.list().at(-1).deps_before;
  t.issue.dependencies = [{ number: 56, state: 'closed', created_at: '2026-11-18T11:00:00Z' }, { number: 58, state: 'open', created_at: '2026-11-18T13:00:00Z' }];
  assert.equal(await answer(t, { id: 610, label: 'ai:plan' }), 'has_sub_issues', 'a dependency created after the run started is one');
  assert.equal(starts().length, 2);
});

test('a job from before the snapshot without creation times: every dependency counts, blocks do not', async () => {
  const t = await build();
  t.issue.dependencies = [{ number: 56, state: 'closed' }];
  t.issue.blocks = [{ number: 60, state: 'open' }];
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  delete t.jobs.list().at(-1).deps_before;
  assert.equal(await answer(t, { label: 'ai:plan' }), 'has_sub_issues', 'no time to tell, so the dependency counts as a sub-issue');
  t.issue.dependencies = [];
  assert.equal(await answer(t, { id: 611, label: 'ai:plan' }), 'queued', 'blocks alone never stop an answer');
});

test('an ignored answer after a finished planner is logged in one line and counted by reason', async () => {
  const lines = [];
  const logger = { error: (...parts) => lines.push(parts.join(' ')) };
  const t = await build({}, logger);
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  const count = (reason) => [...metrics.counters].filter(([key]) => key.startsWith('forgehands_comment_ignored_total') && key.includes('reason="' + reason + '"')).reduce((sum, [, value]) => sum + value, 0);
  const before = count('has_sub_issues');
  t.issue.dependencies = [{ number: 27, state: 'open' }];
  assert.equal(await answer(t, { label: 'ai:plan' }), 'has_sub_issues');
  assert.ok(lines.includes(repo + '#26: marcel commented, not restarting the plan: has_sub_issues'), lines.join('\n'));
  assert.equal(count('has_sub_issues'), before + 1);
  // a planner that is gone from the label is logged too
  t.issue.dependencies = [];
  t.issue.labels = [];
  assert.equal(await answer(t, { id: 612, label: 'ai:plan' }), 'label_gone');
  assert.ok(lines.includes(repo + '#26: marcel commented, not restarting the plan: label_gone'));
  assert.equal(starts().length, 1);
});

test('a comment with no finished planner (the usual case) is not logged as an ignored answer', async () => {
  const lines = [];
  const t = await build({}, { error: (...parts) => lines.push(parts.join(' ')) });
  assert.equal(await answer(t, { label: 'ai:plan' }), 'no_failed_run');
  assert.equal(lines.filter((line) => line.includes('not restarting the plan')).length, 0);
});

test('no restart while the planner runs or waits, nor when the planner is queued', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  await t.dispatcher.tick();
  assert.equal(t.jobs.list().at(-1).status, 'running');
  assert.equal(await answer(t, { label: 'ai:plan' }), 'run_active');
  assert.equal(starts().length, 1);
});

test('no restart for a label that is not a planner (a worker route), nor for an issue without a finished planner', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:ready'));
  assert.equal((await endLast(t)).status, 'done');
  assert.equal(await answer(t, { label: 'ai:ready' }), 'no_failed_run');
  assert.equal(starts().length, 1);
  const none = await build();
  assert.equal(await answer(none, { label: 'ai:plan' }), 'no_failed_run');
});

test('no restart for the comments of the agents, and for anybody but HUMAN_LOGIN', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  assert.equal(await answer(t, { login: 'forgehands', label: 'ai:plan' }), 'not_the_human');
  assert.equal(await answer(t, { login: 'openhands', id: 603, label: 'ai:plan' }), 'not_the_human');
  assert.equal(starts().length, 1);
});

test('a comment is an answer once: the same comment id does nothing the second time', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  assert.equal(await postComment(t, { id: 604 }), 'queued');
  await endLast(t);
  assert.equal(await answer(t, { id: 604, label: 'ai:plan' }), 'duplicate_comment');
  assert.equal(t.jobs.list().filter((job) => job.event.plan_answer).length, 1);
});

test('the limit is PLAN_ANSWER_RESTARTS per ticket and label: then one notice on the issue, and nothing more', async () => {
  const t = await build({ PLAN_ANSWER_RESTARTS: '1' });
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  assert.equal(await answer(t, { id: 605, label: 'ai:plan' }), 'queued');
  await endLast(t);
  assert.equal(await answer(t, { id: 606, label: 'ai:plan' }), 'plan_answers_used_up');
  assert.equal(notices(t).length, 1);
  assert.match(notices(t)[0].body.body, /@marcel ForgeHands: ai:plan was started again by answers 1 times already \(PLAN_ANSWER_RESTARTS=1\)/);
  assert.equal(await answer(t, { id: 607, label: 'ai:plan' }), 'plan_answers_used_up');
  assert.equal(notices(t).length, 1, 'one notice only');
  assert.equal(t.jobs.list().at(-1).blocked_at, undefined, 'the notice does not mark the planner run blocked');
  assert.equal(starts().length, 2, 'no run beyond the limit');
});

test('PLAN_ANSWER_RESTARTS=0 switches the answers off, and COMMENT_RESTARTS still works for failed runs', async () => {
  const off = await build({ PLAN_ANSWER_RESTARTS: '0' });
  await off.dispatcher.enqueue(event('ai:plan'));
  await endLast(off);
  assert.equal(await answer(off, { label: 'ai:plan' }), 'plan_answers_off');
  assert.equal(starts().length, 1);
  assert.throws(() => loadConfig(env({ PLAN_ANSWER_RESTARTS: '21' })), /PLAN_ANSWER_RESTARTS must be an integer between 0 and 20/);
  assert.equal(loadConfig(env()).planAnswerRestarts, 5);
  const failed = await build({ PLAN_ANSWER_RESTARTS: '0' });
  failed.issue.labels = ['ai:ready'];
  await failed.dispatcher.enqueue(event('ai:ready'));
  const job = await endLast(failed, 'stuck');
  assert.equal(job.status, 'failed');
  assert.equal(await answer(failed, { id: 608, label: 'ai:ready' }), 'queued', 'the comment restart of a failed run is unchanged');
});

test('an unreadable forge means nothing happens: no restart, no notice', async () => {
  const t = await build();
  await t.dispatcher.enqueue(event('ai:plan'));
  await endLast(t);
  const broken = fakeForgejo({
    ['GET ' + API + '/issues/26']: { number: 26, state: 'open', labels: [{ name: 'ai:plan' }] },
    ['GET ' + API + '/issues/26/dependencies']: { __status: 500 },
    ['GET ' + API + '/issues/26/blocks']: []
  });
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? broken.send(url, request) : t.dispatcher.send(url, request);
  // the same ledger, the same clock, a forge whose sub-issue read fails
  const again = new Dispatcher(t.config, t.jobs, send, quiet, () => clock);
  assert.equal(await again.onComment({ type: 'issues.commented', source: 'forgejo', action: 'created', repository: { full_name: repo, default_branch: 'main' },
    issue: { number: 26, title: 'Epic', body: 'B', html_url: null, comments: 0, labels: ['ai:plan'] }, comment: { id: '609', login: 'marcel' }, sender: { login: 'marcel' } }), 'issue_unreadable');
  assert.equal(t.jobs.list().length, 1);
  assert.equal(broken.calls.filter((c) => c.method === 'POST').length, 0);
});
