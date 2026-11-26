// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
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
import { normalizeEvent } from '../src/webhook/events.ts';

// Stage A (resume the conversation), stage B (escalate a round) and stage C (the human), with a fake OpenHands and a fake Forgejo.
const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const CHANGES = '44444444-4444-4444-8444-444444444444';
const ESCALATE = '33333333-3333-4333-8333-333333333333';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA2 = '0123456789abcdef0123456789abcdef01234567';
const ROUTES = {
  'ai:ready': { profile: WORKER, tier: 'free' },
  'ai:plan': { profile: PLANNER, tier: 'strong' },
  'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request', escalate_to: 'ai:escalate' },
  'ai:escalate': { profile: ESCALATE, tier: 'strong' }
};
let dir; let clock; let logs; let n = 0;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0', // these tests are about other features: their tickets have no Steps, Files or Acceptance (test/ticket-preflight.test.ts)
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify(ROUTES),
  MAX_CONCURRENT_PER_TIER: '5',
  ERROR_RETRIES: '0',
  UPDATE_BRANCHES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// OpenHands: conversations, their state, the message, run, pause and error calls. `runAnswers` and `eventAnswers` give the next answers.
function openhands() {
  const world = { states: {}, errors: {}, eventAnswers: [], runAnswers: [], calls: [], started: 0, deleted: new Set() };
  world.send = async (url, request) => {
    const path = new URL(url).pathname;
    const body = request.body ? JSON.parse(request.body) : undefined;
    const reply = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
    if (request.method === 'POST' && path === '/api/conversations') {
      world.started += 1;
      const id = 'conv-' + world.started;
      world.calls.push({ method: 'start', id, body });
      return reply(201, { id });
    }
    const [, id, action] = /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/.exec(path) || [];
    if (!id) return reply(404, {});
    if (action === 'events' && request.method === 'POST') { world.calls.push({ method: 'message', id, body }); return reply(world.eventAnswers.shift() ?? 200, {}); }
    if (action === 'run' && request.method === 'POST') { world.calls.push({ method: 'run', id }); return reply(world.runAnswers.shift() ?? 200, {}); }
    if (action === 'pause' && request.method === 'POST') { world.calls.push({ method: 'pause', id }); return reply(200, {}); }
    if (action === 'events/search') return reply(200, { items: world.errors[id] || [] });
    if (request.method === 'GET' && !action) {
      if (world.deleted.has(id)) return reply(404, {});
      return reply(200, { execution_status: world.states[id] || 'running', stats: { usage_to_metrics: {} } });
    }
    return reply(404, {});
  };
  return world;
}

// Forgejo: the pull request 34 of issue 26 with its head commit (move `head` to simulate a push), the labels, comments and writes.
// `labels` says which labels a ticket carries (the trigger label of a run is on it unless a test takes it off), `closed` the closed tickets,
// `unreadable` makes every read fail.
function forgejo() {
  const world = { head: SHA, calls: [], labels: { 34: ['ai:changes'], 57: ['ai:ready'], 58: ['ai:ready'], 60: ['ai:plan'], 61: ['ai:ready'] }, closed: new Set(), unreadable: false };
  const labelsOf = (number) => (world.labels[number] || []).map((name, index) => ({ id: index + 1, name }));
  world.send = async (url, request) => {
    const path = new URL(url).pathname.replace(API, '');
    const body = request.body ? JSON.parse(request.body) : undefined;
    world.calls.push({ method: request.method, path, body });
    const reply = (value) => ({ ok: true, status: 200, json: async () => value });
    if (request.method === 'GET' && world.unreadable) return { ok: false, status: 503, json: async () => ({}) };
    if (request.method === 'GET' && path === '/pulls/34') return reply({ number: 34, state: world.closed.has(34) ? 'closed' : 'open', merged: false, title: 'Fix it', body: 'Closes #26', head: { ref: 'ai/issue-26', sha: world.head }, labels: labelsOf(34), mergeable: true, merge_base: 'base0', html_url: 'https://forge.example/owner/hello/pulls/34' });
    const issue = /^\/issues\/(\d+)$/.exec(path);
    if (request.method === 'GET' && issue) return reply({ number: Number(issue[1]), state: world.closed.has(Number(issue[1])) ? 'closed' : 'open', labels: labelsOf(Number(issue[1])) });
    if (request.method === 'GET') return reply([]);
    if (request.method === 'POST' && path === '/labels') return reply({ id: 9, name: body.name });
    return reply({ id: 77 });
  };
  world.comments = () => world.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments')).map((c) => c.body.body);
  world.labelled = () => world.calls.filter((c) => c.method === 'POST' && /^\/issues\/\d+\/labels$/.test(c.path)).length;
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
  return { config, jobs, dispatcher, oh, forge, send, logger };
}

// A label on pull request 34 (of issue 26) starts a round: the same event the webhook would normalise.
const prPayload = (labels, { ref = 'ai/issue-26', number = 34 } = {}) => ({
  action: 'label_updated', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  pull_request: { number, state: 'open', merged: false, title: 'Fix it', body: 'Closes #26', comments: 2, html_url: 'https://forge.example/owner/hello/pulls/' + number,
    head: { ref }, labels: labels.map((name) => ({ name })) },
  sender: { login: 'marcel' }
});
const prEvent = () => normalizeEvent('pull_request', prPayload(['ai:changes']), new Set([repo]), ['ai:ready'], { labelEvents: true, prLabels: ['ai:changes'] });
const issueEvent = (label, number = 57) => ({
  type: 'issues.labeled', label,
  repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
  issue: { number, title: 'T', body: 'B', html_url: 'https://forge.example/owner/hello/issues/' + number, labels: [label] },
  sender: { login: 'marcel' }
});
const messages = (t, id) => t.oh.calls.filter((c) => c.method === 'message' && (!id || c.id === id));
const runs = (t, id) => t.oh.calls.filter((c) => c.method === 'run' && (!id || c.id === id));
const starts = (t) => t.oh.calls.filter((c) => c.method === 'start');
const logged = (text) => logs.some((line) => line.includes(text));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-resume-')); clock = 1_000_000; logs = []; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

// Starts the first round of pull request 34 and returns its job.
async function startRound(t) {
  await t.dispatcher.enqueue(prEvent());
  await t.dispatcher.tick();
  return t.jobs.list()[0];
}

test('a stuck round resumes once on the same conversation: one message, then the run; it is done when the resumed run finishes', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'continued, not failed');
  assert.equal(job.resumes, 1);
  assert.equal(job.conversation_id, 'conv-1');
  assert.deepEqual(t.oh.calls.filter((c) => c.id === 'conv-1' && c.method !== 'start').map((c) => c.method), ['message', 'run']);
  assert.equal(messages(t)[0].body.role, 'user');
  assert.equal(messages(t)[0].body.run, false, 'the message and the run are two calls, so a refused run is repeated without the message');
  assert.equal(messages(t)[0].body.content[0].type, 'text');
  assert.equal(messages(t)[0].body.content[0].text, 'The run stopped as stuck. Do not repeat what you did last. Look at the current state of the branch and of the checks, take a different approach, and end with the finish tool and a short summary.');
  assert.equal(starts(t).length, 1, 'no second conversation');
  assert.ok(logged('owner/hello#26:ai:changes: stuck, resuming the conversation (1/1)'));
  // The state it stopped in may still be reported for a moment: that is not news yet.
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(messages(t).length, 1);
  t.oh.states['conv-1'] = 'finished';
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(job.result, 'finished');
  assert.equal(t.jobs.list().length, 1, 'nothing escalated, nothing for the human');
  assert.deepEqual(t.forge.comments(), []);
});

test('a resumed round that stops stuck again starts once on the escalate_to profile; a second failure on the same head goes to the human', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'stuck');
  const escalated = t.jobs.list()[1];
  assert.equal(escalated.label, 'ai:changes', 'the own route: branch, prompt and limits stay');
  assert.equal(escalated.key, 'owner/hello#26:ai:changes:' + SHA.slice(0, 8), 'one escalation per head commit');
  assert.equal(escalated.escalated_after, 'stuck');
  assert.equal(escalated.failure_escalation, true);
  assert.deepEqual(t.forge.comments(), [], 'the human is not called while the fresh run is still to come');
  await t.dispatcher.tick();
  assert.equal(escalated.status, 'running');
  assert.equal(starts(t).at(-1).body.agent_profile_id, ESCALATE, 'the fresh run uses the profile of escalate_to');
  assert.equal(starts(t).at(-1).body.max_iterations, 90, 'with the limit of the own route');
  assert.equal(dispatcherRounds(t), 1, 'the fresh run does not use up a round');
  assert.equal(await t.dispatcher.escalateFailure(job, 'stuck'), false, 'a second escalation on the same head is refused');
  // The escalated run is continued too (its own resume), and when it stops stuck again the human is called.
  t.oh.states['conv-2'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(escalated.resumes, 1);
  clock += 61000;
  t.oh.states['conv-2'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(escalated.status, 'failed');
  assert.equal(t.jobs.list().length, 2, 'no third run on the same head');
  assert.equal(t.forge.comments().length, 1);
  assert.match(t.forge.comments()[0], /ForgeHands: the run for ai:changes on pull request #34 ended with "stuck"\. A human has to look at it\./);
  assert.ok(t.forge.calls.some((c) => c.method === 'POST' && c.path === '/issues/34/labels'), 'the pull request is marked for the human');
});

function dispatcherRounds(t) {
  return t.dispatcher.rounds(prEvent());
}

test('escalation is once per head commit: a push starts a new one, and a round is not counted twice', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(t.jobs.list().length, 2);
  t.forge.head = SHA2;
  assert.equal(await t.dispatcher.escalateFailure(job, 'stuck'), true, 'the new head commit gets its own fresh run');
  assert.equal(t.jobs.list().at(-1).key, 'owner/hello#26:ai:changes:' + SHA2.slice(0, 8));
});

test('a round that reaches its iteration limit goes to the escalate_to profile at once, without a resume', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.errors['conv-1'] = [{ kind: 'ConversationErrorEvent', code: 'MaxIterationsReached', detail: 'Agent reached maximum iterations limit (90).' }];
  t.oh.states['conv-1'] = 'error';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'max_iterations');
  assert.equal(messages(t).length, 0, 'an iteration limit is not continued');
  const escalated = t.jobs.list()[1];
  assert.equal(escalated.escalated_after, 'max_iterations');
  await t.dispatcher.tick();
  assert.equal(starts(t).at(-1).body.agent_profile_id, ESCALATE);
  assert.deepEqual(t.forge.comments(), []);
});

test('a route without escalate_to goes to the human after the resume', async () => {
  const routes = { ...ROUTES, 'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request' } };
  const t = await setup({ LABEL_ROUTES: JSON.stringify(routes) });
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(t.jobs.list().length, 1, 'no escalation without escalate_to');
  assert.match(t.forge.comments()[0], /ended with "stuck"\. A human has to look at it\./);
});

test('a planner run that stops stuck is continued once, then the human is called (no escalation for a planner)', async () => {
  const t = await setup();
  await t.dispatcher.enqueue(issueEvent('ai:plan', 60));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  clock += 61000;
  t.oh.states[job.conversation_id] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(t.jobs.list().length, 1);
  assert.match(t.forge.comments()[0], /ended with "stuck"/);
});

test('RESUME_ATTEMPTS=0: a stuck round is not continued; it goes on to the escalate_to stage at once', async () => {
  const t = await setup({ RESUME_ATTEMPTS: '0' });
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(messages(t).length, 0);
  assert.equal(t.jobs.list()[1].escalated_after, 'stuck');
  assert.deepEqual(t.forge.comments(), []);
});

test('RESUME_ATTEMPTS=0 and FAILURE_ESCALATE=0 restore the old behaviour: a stuck or timed out round is handed to the human at once', async () => {
  const t = await setup({ RESUME_ATTEMPTS: '0', FAILURE_ESCALATE: '0' });
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'stuck');
  assert.equal(messages(t).length, 0);
  assert.equal(t.jobs.list().length, 1);
  assert.match(t.forge.comments()[0], /ended with "stuck"\. A human has to look at it\./);
  const timed = await setup({ RESUME_ATTEMPTS: '0', FAILURE_ESCALATE: '0', MAX_RUN_MINUTES: '1' });
  await startRound(timed);
  clock += 61000;
  await timed.dispatcher.tick();
  assert.equal(timed.jobs.list()[0].result, 'timeout');
  assert.equal(timed.jobs.list().length, 1);
  assert.match(timed.forge.comments()[0], /ended with "timeout"/);
});

test('FAILURE_ESCALATE=0 restores the old behaviour: after the resume a round goes to the human, a max_iterations round too', async () => {
  const t = await setup({ FAILURE_ESCALATE: '0' });
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(t.jobs.list().length, 1);
  assert.match(t.forge.comments()[0], /ended with "stuck"/);
  const other = await setup({ FAILURE_ESCALATE: '0' });
  const limited = await startRound(other);
  other.oh.errors['conv-1'] = [{ kind: 'ConversationErrorEvent', code: 'MaxIterationsReached', detail: '90' }];
  other.oh.states['conv-1'] = 'error';
  await other.dispatcher.tick();
  assert.equal(limited.result, 'max_iterations');
  assert.equal(other.jobs.list().length, 1);
  assert.match(other.forge.comments()[0], /ended with "max_iterations"/);
});

test('an issue run that is stuck resumes once and then still goes to the planner through SPLIT_LABEL', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  assert.equal(messages(t).length, 1);
  clock += 61000;
  t.oh.states[job.conversation_id] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(t.jobs.list().length, 1, 'stage B does not apply to a worker run on an issue');
  assert.equal(t.forge.comments().length, 1);
  assert.match(t.forge.comments()[0], /^ForgeHands: the run for ai:ready ended with "stuck", so the ticket is probably too big for one run\./);
  assert.ok(t.forge.calls.some((c) => c.method === 'POST' && c.path === '/issues/57/labels'), 'the planner label goes on');
});

test('a continued issue run that then pauses is resumed again on the pause budget, and is not split (a pause is no sign of a big ticket)', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 58));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  t.oh.states[job.conversation_id] = 'paused';
  clock += 61000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.resumed_from, 'paused');
  assert.equal(job.pause_resumes, 1);
  assert.equal(messages(t).length, 2);
  assert.deepEqual(t.forge.comments(), []);
  assert.equal(t.forge.labelled(), 0, 'no planner label');
});

// The neutral message of a paused run (not the "take a different approach" text of stuck and timed out runs).
const PAUSE_TEXT = 'The run was interrupted (the agent server was restarted or the conversation was paused). Continue from where you stopped: check the state of the branch and of your last step, then finish the task and end with the finish tool.';

test('a paused issue run is resumed on its conversation with the neutral message, not split to the planner', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'continued, not failed');
  assert.equal(job.pause_resumes, 1);
  assert.equal(job.resumes, undefined, 'the stuck budget is not touched');
  assert.deepEqual(t.oh.calls.filter((c) => c.id === job.conversation_id && c.method !== 'start').map((c) => c.method), ['message', 'run']);
  assert.equal(messages(t)[0].body.run, false, 'the message and the run are two calls');
  assert.equal(messages(t)[0].body.content[0].text, PAUSE_TEXT);
  assert.ok(logged('owner/hello#57:ai:ready: paused, resuming the conversation (1/3)'));
  assert.equal(starts(t).length, 1, 'no second conversation');
  assert.deepEqual(t.forge.comments(), [], 'nobody is called');
  assert.equal(t.forge.labelled(), 0, 'no planner label');
  // The paused state may still be reported for a moment after the run call: that is not news yet.
  await t.dispatcher.tick();
  assert.equal(messages(t).length, 1);
  // The run delivers by closing the issue (the one delivery an issue run needs without a pull request).
  t.forge.closed.add(57);
  t.oh.states[job.conversation_id] = 'finished';
  await t.dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(t.jobs.list().length, 1);
});

test('a paused round on a pull request is resumed, not handed to the human', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.pause_resumes, 1);
  assert.equal(messages(t)[0].body.content[0].text, PAUSE_TEXT);
  assert.deepEqual(messages(t).map((c) => c.id), ['conv-1']);
  assert.deepEqual(t.forge.comments(), []);
  assert.ok(!t.forge.calls.some((c) => c.method === 'POST' && c.path === '/issues/34/labels'), 'the pull request is not marked for the human');
});

test('a paused planner run is resumed too (every kind of run gets the pause resume)', async () => {
  const t = await setup();
  await t.dispatcher.enqueue(issueEvent('ai:plan', 60));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.pause_resumes, 1);
  assert.equal(job.status, 'running');
  assert.deepEqual(t.forge.comments(), []);
});

test('a paused review run (a route "on": "ci_success") is resumed, and the verdict is left for when it ends', async () => {
  const routes = { ...ROUTES, 'ci:success': { profile: CHANGES, tier: 'strong', on: 'ci_success' } };
  const t = await setup({ LABEL_ROUTES: JSON.stringify(routes) });
  const event = { type: 'pull_request.ci_success', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
    pull_request: { number: 34, title: 'Fix it', body: 'Closes #26', state: 'open', head: { ref: 'ai/issue-26' }, html_url: null }, ci: { commit_sha: SHA }, sender: { login: 'marcel' } };
  // The job as the dispatcher writes it when the review starts (its own conversation, running).
  const job = t.jobs.add({ key: 'owner/hello#26:ci:success:' + SHA.slice(0, 8), label: 'ci:success', event, status: 'running', created: clock, started: clock, conversation_id: 'conv-9' });
  t.oh.states['conv-9'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.pause_resumes, 1);
  assert.deepEqual(t.oh.calls.filter((c) => c.id === 'conv-9').map((c) => c.method), ['message', 'run']);
  assert.deepEqual(t.forge.comments(), []);
});

test('PAUSE_RESUMES=0: a paused run is not resumed; it goes to the human, never to the planner', async () => {
  const t = await setup({ PAUSE_RESUMES: '0', SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(messages(t).length, 0);
  assert.equal(runs(t).length, 0);
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(t.jobs.list().length, 1, 'no split, no second run');
  assert.equal(t.forge.labelled(), 0, 'no planner label');
  assert.match(t.forge.comments()[0], /^ForgeHands: the run for ai:ready ended with "paused"\. A human has to look at it\./);
});

test('PAUSE_RESUMES=0 keeps the stuck resume as it was: a stuck run is still continued once', async () => {
  const t = await setup({ PAUSE_RESUMES: '0' });
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  assert.equal(job.pause_resumes, undefined);
});

test('the pause budget is 3 by default and independent of RESUME_ATTEMPTS: a fourth pause goes to the human, a stuck run keeps its resume', async () => {
  const t = await setup();
  const job = await startRound(t);
  // A stuck run is continued first; the pauses that follow have their own three resumes.
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1);
  for (let i = 1; i <= 3; i++) {
    clock += 61000;
    t.oh.states['conv-1'] = 'paused';
    await t.dispatcher.tick();
    assert.equal(job.pause_resumes, i, 'pause resume ' + i);
    assert.equal(job.status, 'running');
  }
  assert.equal(job.resumes, 1, 'the pauses did not touch the stuck budget');
  clock += 61000;
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(job.pause_resumes, 3);
  assert.equal(t.jobs.list().length, 1, 'a paused run is not escalated');
  assert.match(t.forge.comments()[0], /ended with "paused"\. A human has to look at it\./);
});

test('a stuck run after three pause resumes still gets its own resume (the two budgets do not share)', async () => {
  const t = await setup();
  const job = await startRound(t);
  for (let i = 1; i <= 3; i++) {
    t.oh.states['conv-1'] = 'paused';
    await t.dispatcher.tick();
    clock += 61000;
  }
  assert.equal(job.pause_resumes, 3);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1, 'continued on the stuck budget');
  assert.equal(job.status, 'running');
  assert.equal(job.resumed_from, 'stuck');
  assert.equal(t.jobs.list().length, 1);
});

test('a paused run whose message OpenHands refuses is not resumed: the human is called, the issue is not split', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.eventAnswers = [503];
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.pause_resumes, undefined);
  assert.equal(runs(t).length, 0);
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(t.jobs.list().length, 1);
  assert.equal(t.forge.labelled(), 0, 'no planner label');
  assert.match(t.forge.comments()[0], /^ForgeHands: the run for ai:ready ended with "paused"\. A human has to look at it\./);
});

test('a 429 from the run call of a paused run is repeated on the next poll, without a second message', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.runAnswers = [429];
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.resume_pending, true);
  assert.equal(messages(t).length, 1);
  assert.equal(runs(t).length, 1);
  clock += 15000;
  await t.dispatcher.tick();
  assert.equal(job.resume_pending, undefined);
  assert.equal(runs(t).length, 2, 'the run was repeated');
  assert.equal(messages(t).length, 1, 'the message was not repeated');
});

test('a 409 from the run call of a paused run means it runs already: no second run call, no message', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.runAnswers = [409];
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.resume_pending, undefined);
  assert.equal(job.status, 'running');
  t.oh.states['conv-1'] = 'running';
  clock += 15000;
  await t.dispatcher.tick();
  assert.equal(runs(t).length, 1);
  assert.equal(messages(t).length, 1);
});

test('a paused run whose run call keeps failing ends as paused after the run timeout, handed to the human and not split', async () => {
  const t = await setup({ MAX_RUN_MINUTES: '1', SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.oh.runAnswers = Array(10).fill(503);
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.resume_pending, true);
  clock += 61000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused', 'not a timeout');
  assert.equal(t.jobs.list().length, 1, 'not split');
  assert.equal(t.forge.labelled(), 0);
  assert.match(t.forge.comments()[0], /ended with "paused"\. A human has to look at it\./);
});

test('a paused run found after a restart of ForgeHands is resumed from the ledger, like any running job', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'paused';
  await t.jobs.persist(clock);
  const jobs = new JobStore(t.jobs.file);
  await jobs.load();
  const again = new Dispatcher(t.config, jobs, t.send, t.logger, () => clock);
  assert.equal(jobs.list()[0].status, 'running', 'still running in the ledger');
  await again.tick();
  const restored = jobs.list()[0];
  assert.equal(restored.id, job.id);
  assert.equal(restored.status, 'running');
  assert.equal(restored.pause_resumes, 1);
  assert.equal(messages(t).length, 1);
  assert.equal(runs(t).length, 1);
  assert.equal(jobs.list().length, 1);
});

test('a 429 from the run call is repeated on the next poll, without a second message', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.runAnswers = [429];
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.resume_pending, true, 'the run call is still to be made');
  assert.equal(messages(t).length, 1);
  assert.equal(runs(t).length, 1);
  clock += 15000;
  await t.dispatcher.tick();
  assert.equal(job.resume_pending, undefined);
  assert.equal(runs(t).length, 2, 'the run was repeated');
  assert.equal(messages(t).length, 1, 'the message was not repeated');
  assert.equal(job.status, 'running');
});

test('a 409 from the run call means the conversation runs already: no second run call, no message', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.runAnswers = [409];
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resume_pending, undefined);
  assert.equal(job.status, 'running');
  t.oh.states['conv-1'] = 'running';
  clock += 15000;
  await t.dispatcher.tick();
  assert.equal(runs(t).length, 1);
  assert.equal(messages(t).length, 1);
});

test('a message that OpenHands refuses is no resume: the next stage decides', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.eventAnswers = [503];
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, undefined);
  assert.equal(runs(t).length, 0);
  assert.equal(job.status, 'failed', 'the next stage: escalation (the route has escalate_to)');
  assert.equal(t.jobs.list()[1].escalated_after, 'stuck');
});

test('a resumed job survives a restart: the count and the pending state come back from the ledger', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  await t.jobs.persist(clock);
  const jobs = new JobStore(t.jobs.file);
  await jobs.load();
  const again = new Dispatcher(t.config, jobs, t.send, t.logger, () => clock);
  const restored = jobs.list()[0];
  assert.equal(restored.resumes, 1);
  assert.equal(restored.resumed_from, 'stuck');
  assert.equal(restored.status, 'running');
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await again.tick();
  assert.equal(messages(t).length, 1, 'no second message after the restart');
  assert.equal(jobs.list().length, 2, 'the second stuck end goes to stage B');
  assert.equal(jobs.list()[1].escalated_after, 'stuck');
  assert.equal(restored.status, 'failed');
  assert.equal(job.id, restored.id);
});

test('a timed out round is paused and continued; its timeout counts from the continuation, and a second timeout goes on', async () => {
  const t = await setup({ MAX_RUN_MINUTES: '1' });
  const job = await startRound(t);
  clock += 61000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.resumes, 1);
  assert.deepEqual(t.oh.calls.filter((c) => c.id === 'conv-1' && c.method !== 'start').map((c) => c.method), ['pause', 'message', 'run']);
  assert.equal(job.started, 1_000_000, 'the first start stays (MAX_RUNS_PER_HOUR counts the run once)');
  clock += 30000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'the continued run has its own minute');
  clock += 61000;
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'timeout');
  assert.equal(t.jobs.list()[1].escalated_after, 'timeout');
});

test('the metrics count the resume and the escalation, and the status page says resumed or escalated after the state', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  const during = buildStatus(t.config, t.jobs, clock).issues[0].state;
  assert.match(during, /follow-up round running \(resumed\)/);
  clock += 61000;
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  await t.dispatcher.tick();
  const after = buildStatus(t.config, t.jobs, clock).issues[0].state;
  assert.match(after, /follow-up round running \(escalated after stuck\)/);
  const text = metrics.render();
  assert.match(text, /^forgehands_resumes_total\{kind="pull_request",state="stuck"\} 1$/m);
  assert.match(text, /^forgehands_failure_escalations_total 1$/m);
  assert.equal(job.status, 'failed');
});

// A human stops a run by removing its trigger label (or closing the ticket): a paused run of such a ticket is not resumed, is not split and is not
// handed over. It ends as paused, with one log line, and nothing is written to the ticket.
test('a paused round whose trigger label is gone is not resumed: no split, no hand-over, one log line', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.forge.labels[34] = [];
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(job.pause_resumes, undefined);
  assert.equal(messages(t).length, 0, 'no message');
  assert.equal(runs(t).length, 0, 'no run call');
  assert.equal(t.jobs.list().length, 1, 'no escalation');
  assert.deepEqual(t.forge.comments(), [], 'nobody is called');
  assert.equal(t.forge.labelled(), 0, 'no label is set');
  assert.equal(logs.filter((line) => line.includes('not resumed')).length, 1);
  assert.ok(logged('owner/hello#26:ai:changes: paused, the trigger label is gone: not resumed'));
  assert.equal(t.jobs.list(true).length, 0, 'the slot is free');
});

test('a paused issue run whose trigger label is gone is not resumed and not split either', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.forge.labels[57] = ['ai:plan'];
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(messages(t).length, 0);
  assert.equal(t.jobs.list().length, 1);
  assert.equal(t.forge.labelled(), 0, 'the planner label is not set on a ticket the operator took off the run');
  assert.deepEqual(t.forge.comments(), []);
  assert.ok(logged('owner/hello#57:ai:ready: paused, the trigger label is gone: not resumed'));
});

test('a paused issue run of a closed issue is not resumed: one log line, no comment', async () => {
  const t = await setup({ SPLIT_LABEL: 'ai:plan' });
  await t.dispatcher.enqueue(issueEvent('ai:ready', 57));
  await t.dispatcher.tick();
  const job = t.jobs.list()[0];
  t.forge.closed.add(57);
  t.oh.states[job.conversation_id] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(messages(t).length, 0);
  assert.deepEqual(t.forge.comments(), []);
  assert.equal(t.forge.labelled(), 0);
  assert.equal(logs.filter((line) => line.includes('not resumed')).length, 1);
  assert.ok(logged('owner/hello#57:ai:ready: paused, the issue is closed: not resumed'));
});

test('a paused round on a closed pull request is not resumed', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.forge.closed.add(34);
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'paused');
  assert.equal(messages(t).length, 0);
  assert.deepEqual(t.forge.comments(), []);
  assert.ok(logged('owner/hello#26:ai:changes: paused, the pull request is closed: not resumed'));
});

test('a paused review run has no trigger label to look at: it is resumed even without the label, and stops only when closed', async () => {
  const routes = { ...ROUTES, 'ci:success': { profile: CHANGES, tier: 'strong', on: 'ci_success' } };
  const t = await setup({ LABEL_ROUTES: JSON.stringify(routes) });
  const event = { type: 'pull_request.ci_success', repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello.git', default_branch: 'main' },
    pull_request: { number: 34, title: 'Fix it', body: 'Closes #26', state: 'open', head: { ref: 'ai/issue-26' }, html_url: null }, ci: { commit_sha: SHA }, sender: { login: 'marcel' } };
  const job = t.jobs.add({ key: 'owner/hello#26:ci:success:' + SHA.slice(0, 8), label: 'ci:success', event, status: 'running', created: clock, started: clock, conversation_id: 'conv-9' });
  t.forge.labels[34] = [];
  t.oh.states['conv-9'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.pause_resumes, 1, 'resumed');
  t.forge.closed.add(34);
  clock += 61000;
  t.oh.states['conv-9'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed', 'a closed pull request is a stop');
  assert.equal(job.result, 'paused');
  assert.equal(messages(t).length, 1, 'the second pause was not resumed');
});

test('a deleted conversation is not resumed: it ends as deleted, as before', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.oh.deleted.add('conv-1');
  await t.dispatcher.tick();
  assert.equal(job.status, 'failed');
  assert.equal(job.result, 'deleted');
  assert.equal(messages(t).length, 0);
  assert.deepEqual(t.forge.comments(), [], 'a deleted run is not reported, as before');
});

test('a paused run whose ticket cannot be read is left as it is and tried again on the next pass', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.forge.unreadable = true;
  t.oh.states['conv-1'] = 'paused';
  await t.dispatcher.tick();
  assert.equal(job.status, 'running', 'not ended while the forge cannot say');
  assert.equal(messages(t).length, 0);
  assert.deepEqual(t.forge.comments(), []);
  t.forge.unreadable = false;
  await t.dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.pause_resumes, 1, 'resumed once the forge answers');
  assert.equal(messages(t).length, 1);
});

test('a stuck run does not read the trigger label: it is continued as before when the label is gone', async () => {
  const t = await setup();
  const job = await startRound(t);
  t.forge.labels[34] = [];
  t.oh.states['conv-1'] = 'stuck';
  await t.dispatcher.tick();
  assert.equal(job.resumes, 1, 'a stuck run is continued as before, the label is not read for it');
  assert.equal(job.status, 'running');
});

test('PAUSE_RESUMES is validated: the default is 3, 0 switches it off, at most 10', () => {
  assert.throws(() => loadConfig(env({ PAUSE_RESUMES: '11' })), /PAUSE_RESUMES/);
  assert.throws(() => loadConfig(env({ PAUSE_RESUMES: '-1' })), /PAUSE_RESUMES/);
  assert.equal(loadConfig(env()).pauseResumes, 3);
  assert.equal(loadConfig(env({ PAUSE_RESUMES: '0' })).pauseResumes, 0);
  assert.equal(loadConfig(env({ PAUSE_RESUMES: '10' })).pauseResumes, 10);
});

test('RESUME_ATTEMPTS and FAILURE_ESCALATE are validated', () => {
  assert.throws(() => loadConfig(env({ RESUME_ATTEMPTS: '-1' })), /RESUME_ATTEMPTS/);
  assert.throws(() => loadConfig(env({ RESUME_ATTEMPTS: '9' })), /RESUME_ATTEMPTS/);
  assert.throws(() => loadConfig(env({ FAILURE_ESCALATE: 'yes' })), /FAILURE_ESCALATE must be 0 or 1/);
  assert.equal(loadConfig(env()).resumeAttempts, 1);
  assert.equal(loadConfig(env()).failureEscalate, true);
  assert.equal(loadConfig(env({ RESUME_ATTEMPTS: '0' })).resumeAttempts, 0);
  assert.equal(loadConfig(env({ FAILURE_ESCALATE: '0' })).failureEscalate, false);
});
