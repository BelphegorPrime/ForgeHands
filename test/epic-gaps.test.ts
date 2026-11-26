// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// An epic the epic review finds still open: back to the planner once (EPIC_GAP_REPLAN), then the human once per head of the default branch.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { notMetQuote, quoteBlock } from '../src/agent/epic-gaps.ts';
import { loadConfig } from '../src/config.ts';
import { metrics } from '../src/metrics.ts';
import { buildStatus } from '../src/server/status.ts';
import { JobStore } from '../src/store/jobs.ts';
import { normalizeEvent } from '../src/webhook/events.ts';

const PLANNER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const API = '/api/v1/repos/owner/hello';
const repo = 'owner/hello';
const quiet = { error() {} };
const REVIEW_TEXT = '@marcel — epic #10 stays open after review of main at aaaa1111. Met: criterion 1 (src/a.mjs line 3). '
  + 'Not met: criterion 2, the export is missing (no check in the tests).';

let dir; let clock; let calls; let states; let world; let routes; let notes;

const env = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong', max_iterations: 80 },
    'ai:ready': { profile: WORKER, tier: 'free' },
    'epic:done': { profile: REVIEWER, tier: 'strong', max_iterations: 40, on: 'epic_done' }
  }),
  MAX_CONCURRENT_PER_TIER: '2',
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL',
  FORGE_TOKEN: 'tok-secret-value',
  FORGE_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// OpenHands: every run starts, and its state is what the test sets.
function fakeApi() {
  return async (url, request) => {
    const path = new URL(url).pathname;
    calls.push({ method: request.method, path, body: request.body && JSON.parse(request.body) });
    if (request.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'conv-' + calls.length }) };
    const id = path.split('/').pop();
    return { ok: true, status: 200, json: async () => ({ execution_status: states[id] || 'running', metrics: null, stats: { usage_to_metrics: { default: { accumulated_cost: 0 } } } }) };
  };
}

// The forge: GET answers from `routes` (functions read the world of the test); a write without a route is refused (404), as a missing route should be.
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
  const writes = () => forgeCalls.filter((call) => call.method !== 'GET');
  return { forgeCalls, send, writes };
}

async function build(extra = {}, notifier) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const forgejo = fakeForgejo();
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => clock, notifier);
  return { config, jobs, forgejo, dispatcher };
}

const closedEvent = (number) => normalizeEvent('issues', { action: 'closed', repository: { full_name: repo, default_branch: 'main' }, issue: { number }, sender: { login: 'marcel' } }, new Set([repo]), ['ai:ready'], {});
const starts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/conversations'));
const reviewKey = 'owner/hello#10:epic:done';

// The epic as the forge has it: open, planned (ai:plan), one sub-issue closed, on main at `sha`. Routes read `world`, so a test changes it.
function setWorld(extra = {}) {
  world = {
    issue: { number: 10, state: 'open', title: 'Epic', body: 'Make X work', labels: [{ id: 1, name: 'ai:plan' }], html_url: 'https://forge.example/owner/hello/issues/10' },
    sha: 'aaaa1111bbbb2222', labels: [{ id: 1, name: 'ai:plan' }, { id: 2, name: 'ai:blocked' }], comments: [], sub: [{ number: 11, state: 'closed', title: 'Part one', labels: [] }],
    ...extra
  };
  routes = {
    ['GET ' + API + '/issues/11/blocks']: () => [world.issue],
    ['GET ' + API + '/issues/10/dependencies']: () => world.sub,
    ['GET ' + API + '/issues/10']: () => world.issue,
    ['GET ' + API + '/branches/main']: () => ({ commit: { id: world.sha } }),
    ['GET ' + API + '/issues/10/comments']: () => world.comments,
    ['GET ' + API + '/issues/10/labels']: () => world.labels,
    ['GET ' + API + '/labels']: () => [{ id: 1, name: 'ai:plan' }, { id: 2, name: 'ai:blocked' }],
    ['DELETE ' + API + '/issues/10/labels/1']: {},
    ['POST ' + API + '/issues/10/labels']: {},
    ['POST ' + API + '/issues/10/comments']: {}
  };
}

// The reviewer's comment (the run writes it while it runs) and the end of the run: starts the epic review, lets it run, writes `text`
// as the reviewer's comment, and lets the run finish. The poll of the finished run is the review.
async function reviewRun(t, { text = REVIEW_TEXT, before } = {}) {
  clock += 3600000;
  await t.dispatcher.onClosed(closedEvent(11));
  await t.dispatcher.tick();
  const job = t.jobs.list().filter((entry) => entry.key === reviewKey).at(-1);
  world.comments = text === null ? [] : [{ created_at: new Date(clock + 500).toISOString(), user: { login: 'agent' }, body: text }];
  if (before) before();
  states[job.conversation_id] = 'finished';
  await t.dispatcher.tick();
  return job;
}
const comments = (t) => t.forgejo.writes().filter((call) => call.method === 'POST' && call.path === API + '/issues/10/comments').map((call) => call.body.body);
const planned = (t) => t.forgejo.writes().filter((call) => call.method === 'POST' && call.path === API + '/issues/10/labels');
const handovers = () => notes.filter((message) => message.kind === 'handover');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-epic-gaps-'));
  clock = 1_000_000; calls = []; states = {}; notes = [];
  setWorld();
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('an epic the reviewer closed is left alone: nothing written, its record dropped', async () => {
  const t = await build();
  // A record from an earlier review; the reviewer closes the epic during this run.
  t.jobs.epicGaps.set('owner/hello#10', { repository: 'owner/hello', issue: 10, sha: 'old', at: clock, replans: 1, human: false, reason: 'x' });
  await reviewRun(t, { before: () => { world.issue.state = 'closed'; } });
  assert.equal(t.jobs.epicGaps.size, 0);
  assert.equal(comments(t).length, 0);
  assert.equal(t.forgejo.writes().length, 0);
});

test('an epic still open after its review goes back to the planner once, with the Not met lines quoted', async () => {
  const t = await build();
  const job = await reviewRun(t);
  assert.equal(job.status, 'done');
  assert.equal(comments(t).length, 1, 'one comment for the planner');
  const [text] = comments(t);
  assert.match(text, /^ForgeHands: the epic review of main at aaaa1111 found this epic still open/);
  assert.match(text, /planner \(ai:plan\) writes sub-issues/);
  assert.match(text, /Not met: criterion 2, the export is missing/);
  assert.doesNotMatch(text, /criterion 1/, 'the Met part is not quoted');
  assert.doesNotMatch(text, /@marcel/, 'the planner is no human: no mention');
  // The planner label goes off and on again: that is what starts the planner run (see src/agent/preflight.ts).
  assert.deepEqual(t.forgejo.writes().filter((call) => call.method === 'DELETE').map((call) => call.path), [API + '/issues/10/labels/1']);
  assert.equal(planned(t).length, 1);
  assert.deepEqual(planned(t)[0].body, { labels: [1] });
  assert.deepEqual(t.jobs.epicGaps.get('owner/hello#10').replans, 1);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, false);
  assert.equal(handovers().length, 0, 'the human is not called on the first gap');
});

test('the epic still open after the planner had its try calls the human once, and once per head of the default branch', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  await reviewRun(t);
  world.sha = 'cccc3333dddd4444';
  const second = await reviewRun(t, { text: REVIEW_TEXT.replace('aaaa1111', 'cccc3333') });
  assert.equal(second.status, 'done');
  const human = comments(t).filter((text) => text.includes('stays open after the review'));
  assert.equal(human.length, 1);
  assert.match(human[0], /^@marcel ForgeHands: epic #10 stays open after the review of main at cccc3333/);
  assert.match(human[0], /The planner already had its try \(EPIC_GAP_REPLAN\)/);
  assert.match(human[0], /A human has to decide what happens next/);
  assert.equal(comments(t).length, 2, 'the planner comment and the human comment, nothing more');
  // The hand-over is marked like the others: BLOCKED_LABEL on the issue (id 2 of the label list).
  assert.ok(t.forgejo.writes().some((call) => call.path === API + '/issues/10/labels' && JSON.stringify(call.body) === '{"labels":[2]}'));
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true);
  assert.equal(handovers().length, 1);
  assert.match(handovers()[0].subject, /^\[hello\] #10 stays open after the epic review$/);
  assert.match(handovers()[0].text, /Not met: criterion 2/);
  // Another review on the same head changes nothing: no second comment, no second notification.
  const again = await reviewRun(t, { text: REVIEW_TEXT.replace('aaaa1111', 'cccc3333') });
  assert.equal(again.status, 'done');
  assert.equal(comments(t).length, 2);
  assert.equal(handovers().length, 1);
});

test('no duplicate per head: a review that ends on the same head as the last decision writes nothing', async () => {
  const t = await build();
  await reviewRun(t);
  assert.equal(comments(t).length, 1);
  const job = await reviewRun(t);
  assert.equal(job.status, 'done');
  assert.equal(comments(t).length, 1, 'still one planner comment');
  assert.equal(planned(t).length, 1, 'the planner label was set once');
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').replans, 1);
});

test('EPIC_GAP_REPLAN=0 switches the replan off: the human is called at once', async () => {
  const t = await build({ EPIC_GAP_REPLAN: '0' }, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  await reviewRun(t);
  const [text] = comments(t);
  assert.match(text, /^@marcel ForgeHands: epic #10 stays open after the review/);
  assert.match(text, /EPIC_GAP_REPLAN is off, so the planner was not asked/);
  assert.equal(planned(t).filter((call) => call.body.labels.includes(1)).length, 0, 'the planner label is not set');
  assert.equal(t.forgejo.writes().filter((call) => call.method === 'DELETE').length, 0);
  assert.equal(handovers().length, 1);
});

test('EPIC_GAP_REPLAN=2 sends the epic back twice before the human is called', async () => {
  const t = await build({ EPIC_GAP_REPLAN: '2' });
  await reviewRun(t);
  world.sha = 'cccc3333dddd4444';
  await reviewRun(t, { text: REVIEW_TEXT.replace('aaaa1111', 'cccc3333') });
  assert.equal(comments(t).filter((text) => text.includes('found this epic still open')).length, 2);
  assert.equal(comments(t).filter((text) => text.startsWith('@marcel')).length, 0);
  world.sha = 'eeee5555ffff6666';
  await reviewRun(t, { text: REVIEW_TEXT.replace('aaaa1111', 'eeee5555') });
  assert.equal(comments(t).filter((text) => text.startsWith('@marcel')).length, 1);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').replans, 2);
});

test('an epic without a planner label (not planned by ForgeHands) is handed to the human at once', async () => {
  setWorld({ issue: { number: 10, state: 'open', title: 'Epic', body: 'B', labels: [{ id: 3, name: 'ai:close' }] }, labels: [{ id: 3, name: 'ai:close' }] });
  const t = await build();
  await reviewRun(t);
  assert.equal(planned(t).filter((call) => call.body.labels.includes(3)).length, 0, 'no planner label is set');
  assert.match(comments(t)[0], /^@marcel ForgeHands: epic #10 stays open/);
  assert.match(comments(t)[0], /No planner label is there to send the epic back to/);
});

test('SPLIT_LABEL is the planner when the epic carries no epic label with a planner route', async () => {
  // ai:close is an epic label without a route: it is no planner, so the planner is SPLIT_LABEL.
  setWorld({ issue: { number: 10, state: 'open', title: 'Epic', body: 'B', labels: [{ id: 3, name: 'ai:close' }] }, labels: [{ id: 3, name: 'ai:close' }] });
  routes['GET ' + API + '/labels'] = () => [{ id: 4, name: 'ai:split' }];
  const t = await build({ SPLIT_LABEL: 'ai:split', EPIC_LABEL: 'ai:close', LABEL_ROUTES: JSON.stringify({ 'ai:split': { profile: PLANNER, tier: 'strong' }, 'epic:done': { profile: REVIEWER, tier: 'strong', on: 'epic_done' }, 'ai:ready': { profile: WORKER, tier: 'free' } }) });
  await reviewRun(t);
  assert.equal(planned(t).length, 1);
  assert.deepEqual(planned(t)[0].body, { labels: [4] });
  assert.match(comments(t)[0], /found this epic still open/);
});

test('a dry run writes nothing to the forge and keeps no record', async () => {
  const t = await build({ DRY_RUN: '1' });
  const job = { key: reviewKey, label: 'epic:done', status: 'done', started: clock - 1000, event: { type: 'epic.done', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 10, title: 'Epic', body: 'B', labels: ['ai:plan'] }, epic: { children: [] }, sender: { login: 'marcel' } } };
  world.comments = [{ created_at: new Date(clock).toISOString(), body: REVIEW_TEXT }];
  const outcome = await t.dispatcher.epicGaps.review(job);
  assert.equal(outcome, 'replanned');
  assert.equal(t.forgejo.writes().length, 0, 'the transport stops every write');
  assert.ok(t.dispatcher.dry.writes.length >= 2, 'the would-be writes are logged');
  assert.equal(t.jobs.epicGaps.size, 0, 'a dry run decides nothing that the next review must respect');
});

test('a dry run that hands the epic to the human writes nothing and keeps no record', async () => {
  const t = await build({ DRY_RUN: '1', EPIC_GAP_REPLAN: '0' });
  const job = { key: reviewKey, label: 'epic:done', status: 'done', started: clock - 1000, event: { type: 'epic.done', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 10, title: 'Epic', body: 'B', labels: ['ai:plan'] }, epic: { children: [] }, sender: { login: 'marcel' } } };
  world.comments = [{ created_at: new Date(clock).toISOString(), body: REVIEW_TEXT }];
  assert.equal(await t.dispatcher.epicGaps.review(job), 'handed');
  assert.equal(t.forgejo.writes().length, 0);
  assert.equal(t.jobs.epicGaps.size, 0);
});

test('a failed read of the epic decides nothing; a failed write hands the epic to the human instead of losing it', async () => {
  const t = await build();
  routes['GET ' + API + '/issues/10'] = { __status: 500 };
  const job = await reviewRun(t, { before: () => {} });
  assert.equal(job.status, 'done');
  assert.equal(t.forgejo.writes().length, 0);
  assert.equal(t.jobs.epicGaps.size, 0);
  routes['GET ' + API + '/issues/10'] = () => world.issue;
  routes['POST ' + API + '/issues/10/comments'] = { __status: 503 };
  const second = await reviewRun(t);
  assert.equal(second.status, 'done');
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true, 'the planner comment failed: the human is called');
});

test('the reviewer comment is read from the newest comment written during the run; without one the planner checks the criteria itself', async () => {
  const t = await build();
  await reviewRun(t, { text: null });
  assert.match(comments(t)[0], /The reviewer wrote no comment, so the gaps are not known/);
});

test('the quote is the Not met part, capped, and a fence longer than the backticks in it', () => {
  assert.equal(notMetQuote('Met: a. Not met: b\nc'), 'Not met: b\nc');
  assert.equal(notMetQuote('Met: a\nNot met:\n- one\n- two'), 'Not met:\n- one\n- two');
  assert.equal(notMetQuote('no marker here').startsWith('no marker here'), true);
  assert.ok(notMetQuote('Not met: ' + 'x'.repeat(5000)).length <= 1500);
  assert.equal(quoteBlock('a ``` b'), '````\na ``` b\n````');
  assert.equal(quoteBlock('plain'), '```\nplain\n```');
});

test('the status page shows the tickets that wait behind an epic with gaps, and the epic waits for the human', () => {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'status.json'));
  const waiting = (issue, on) => jobs.add({ key: repo + '#' + issue + ':ai:ready', label: 'ai:ready', status: 'waiting', created: clock - 1000, attempts: 0, waiting_for: [on],
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: issue, title: 'W' + issue, body: '', labels: [] }, sender: { login: 'marcel' } } });
  waiting(233, 232);
  waiting(235, 234);
  waiting(236, 233);
  jobs.epicGaps.set(repo + '#232', { repository: repo, issue: 232, sha: 'aaaa', at: clock, replans: 1, human: true, reason: 'Not met: x' });
  const status = buildStatus(config, jobs, clock);
  const row = (issue) => status.issues.find((entry) => entry.issue === repo + '#' + issue);
  assert.equal(row(233).state, 'waiting behind epic with gaps #232');
  assert.deepEqual(row(233).blocked_by_epic_gaps, [232]);
  assert.equal(row(236).state, 'waiting behind epic with gaps #232', 'transitively, through #233');
  assert.deepEqual(row(236).blocked_by_stuck, []);
  assert.equal(row(235).state, 'waiting for #234', 'an epic without gaps changes nothing');
  assert.deepEqual(row(235).blocked_by_epic_gaps, []);
  const hand = status.waiting_for_human.find((entry) => entry.issue === 232);
  assert.ok(hand, 'the epic is listed as waiting for a human');
  assert.equal(hand.pr, null);
  assert.match(hand.reason, /stays open after its review: Not met: x/);
});

test('a replanned epic (not yet for the human) is not waiting for a human, but its dependents still wait behind it', () => {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'status2.json'));
  jobs.add({ key: repo + '#233:ai:ready', label: 'ai:ready', status: 'waiting', created: clock - 1000, attempts: 0, waiting_for: [232],
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 233, title: 'W', body: '', labels: [] }, sender: { login: 'marcel' } } });
  jobs.epicGaps.set(repo + '#232', { repository: repo, issue: 232, sha: 'aaaa', at: clock, replans: 1, human: false, reason: 'x' });
  const status = buildStatus(config, jobs, clock);
  assert.equal(status.waiting_for_human.length, 0);
  assert.equal(status.issues.find((entry) => entry.issue === repo + '#233').state, 'waiting behind epic with gaps #232');
});

test('EPIC_GAP_REPLAN defaults to 1, takes 0 to 5 and rejects anything else', () => {
  assert.equal(loadConfig(env()).epicGapReplan, 1);
  assert.equal(loadConfig(env({ EPIC_GAP_REPLAN: '0' })).epicGapReplan, 0);
  assert.equal(loadConfig(env({ EPIC_GAP_REPLAN: '5' })).epicGapReplan, 5);
  assert.throws(() => loadConfig(env({ EPIC_GAP_REPLAN: '6' })), /EPIC_GAP_REPLAN must be an integer between 0 and 5/);
  assert.throws(() => loadConfig(env({ EPIC_GAP_REPLAN: '-1' })), /EPIC_GAP_REPLAN must be an integer between 0 and 5/);
});

test('the decision survives a restart: the ledger keeps the epic gap records', async () => {
  const t = await build();
  await reviewRun(t);
  await t.jobs.persist(clock);
  const again = new JobStore(join(dir, 'jobs.json'));
  await again.load();
  assert.equal(again.epicGaps.get('owner/hello#10').replans, 1);
  assert.equal(again.epicGaps.get('owner/hello#10').sha, 'aaaa1111bbbb2222');
  assert.equal(again.epicGaps.get('owner/hello#10').human, false);
});

// The planner run of the epic (its label went on again, see replan): started through the normal path, so its sub-issues are read at its start
// (deps_before); `before` changes the forge while it runs; the run finishes with `text` as the planner's comment.
async function plannerRun(t, { before, text = 'Which export name do you want?' } = {}) {
  clock += 3600000;
  const event = normalizeEvent('issues', { action: 'labeled', label: { name: 'ai:plan' }, repository: { full_name: repo, default_branch: 'main' }, issue: { number: 10, title: 'Epic', body: 'Make X work', labels: [{ name: 'ai:plan' }] }, sender: { login: 'marcel' } }, new Set([repo]), ['ai:plan'], { labelEvents: true });
  await t.dispatcher.enqueue(event);
  await t.dispatcher.tick();
  const job = t.jobs.list().filter((entry) => entry.label === 'ai:plan').at(-1);
  world.comments = text === null ? [] : [{ created_at: new Date(clock + 500).toISOString(), user: { login: 'planner' }, body: text }];
  if (before) before();
  states[job.conversation_id] = 'finished';
  await t.dispatcher.tick();
  return job;
}

// A run of the epic review (or any job under `key`) that is started by the tick and finished with `text` as the reviewer's comment.
async function finishRun(t, key, text) {
  await t.dispatcher.tick();
  const job = t.jobs.list().filter((entry) => entry.key === key).at(-1);
  world.comments = [{ created_at: new Date(clock + 500).toISOString(), user: { login: 'agent' }, body: text }];
  states[job.conversation_id] = 'finished';
  await t.dispatcher.tick();
  return job;
}

// A planner run of the epic that ended `ago` ms before now, as a ledger job (a legacy one has no deps_before snapshot).
const plannerJob = (created, extra = {}) => ({
  key: 'owner/hello#10:ai:plan', label: 'ai:plan', status: 'done', created, attempts: 0, started: created, finished: created + 1000,
  event: { type: 'issues.labeled', label: 'ai:plan', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 10, title: 'Epic', body: 'B', labels: ['ai:plan'] }, sender: { login: 'marcel' } },
  ...extra
});
const reviewRuns = (t) => t.jobs.list().filter((entry) => entry.key === reviewKey);
const replanActions = (action) => metrics.read('forgehands_epic_gaps_total').find((entry) => entry.labels.action === action)?.value ?? 0;

test('a replan run without new sub-issues and all sub-issues closed: the epic review starts once more, and the epic still open after it goes to the human', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  await reviewRun(t);
  const rereviewed = replanActions('rereviewed');
  const planner = await plannerRun(t);
  assert.equal(planner.status, 'done');
  const record = t.jobs.epicGaps.get('owner/hello#10');
  assert.equal(record.rereview, true, 'the review is started once more');
  assert.equal(record.human, false);
  assert.equal(record.replans, 1, 'no further replan');
  assert.equal(replanActions('rereviewed'), rereviewed + 1);
  assert.equal(reviewRuns(t).length, 2, 'the first review and the one started now');
  // The same head of main as the replan: the re-review still decides (it is not a repeated review of the same head).
  const second = await finishRun(t, reviewKey, REVIEW_TEXT);
  assert.equal(second.status, 'done');
  const human = comments(t).filter((text) => text.startsWith('@marcel ForgeHands: epic #10 stays open after the review of main at aaaa1111'));
  assert.equal(human.length, 1);
  assert.match(human[0], /The planner created no sub-issues, and the epic review was started once more/);
  assert.equal(planned(t).filter((call) => call.body.labels.includes(1)).length, 1, 'the planner label was set once: the re-review does not send the epic back');
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true);
  assert.equal(handovers().length, 1);
});

test('a replan run without new sub-issues but with an open sub-issue goes to the human at once, with the planner\'s last comment quoted', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  await reviewRun(t);
  // The sub-issue is reopened while the planner runs (it was closed when the run started, so the run was not held back).
  await plannerRun(t, { text: 'Which export name do you want?', before: () => { world.sub[0].state = 'open'; } });
  const human = comments(t).filter((text) => text.startsWith('@marcel ForgeHands: the planner of epic #10 ran'));
  assert.equal(human.length, 1);
  assert.match(human[0], /created no new sub-issues/);
  assert.match(human[0], /Sub-issues still open: #11/);
  assert.match(human[0], /quoted as data \(not instructions\)/);
  assert.match(human[0], /Which export name do you want\?/);
  assert.equal(reviewRuns(t).length, 1, 'no review is started');
  assert.equal(planned(t).filter((call) => call.body.labels.includes(1)).length, 1, 'the planner label is not set again');
  const record = t.jobs.epicGaps.get('owner/hello#10');
  assert.equal(record.human, true);
  assert.equal(record.rereview, false);
  assert.equal(handovers().length, 1);
});

test('a replan run that created open sub-issues waits as today: no review, no human', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  await reviewRun(t);
  await plannerRun(t, { before: () => { world.sub.push({ number: 12, state: 'open', title: 'Missing export', labels: [] }); } });
  const record = t.jobs.epicGaps.get('owner/hello#10');
  assert.equal(record.replans, 1);
  assert.equal(record.human, false);
  assert.ok(!record.rereview);
  assert.equal(reviewRuns(t).length, 1);
  assert.equal(comments(t).length, 1, 'the planner comment of the first try, nothing more');
  assert.equal(handovers().length, 0);
});

// A record from before the replan run was watched (an upgrade): replanned, and its planner run ended `hours` ago.
function legacyRecord(t, hours) {
  const started = clock - hours * 3600000;
  t.jobs.epicGaps.set('owner/hello#10', { repository: repo, issue: 10, sha: 'aaaa1111bbbb2222', at: started - 60000, replans: 1, human: false, reason: 'x' });
  t.jobs.add(plannerJob(started));
}

test('a legacy record whose replan run ended longer ago than EPIC_GAP_STALL_MINUTES is decided by the sweep once', async () => {
  const t = await build();
  legacyRecord(t, 4);
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), true);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').rereview, true, 'the sub-issues are closed: the review starts once more');
  assert.equal(reviewRuns(t).length, 1);
  clock += 10 * 60000;
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), false, 'the review is under way: nothing more is decided');
  assert.equal(reviewRuns(t).length, 1);
  assert.equal(t.forgejo.writes().length, 0, 'nothing written to the forge by the sweep itself');
});

test('a legacy record whose replan run ended recently is left alone by the sweep', async () => {
  const t = await build();
  legacyRecord(t, 1);
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), false);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').rereview, undefined);
  assert.equal(reviewRuns(t).length, 0);
});

test('a stalled replan with an open sub-issue is handed to the human once by the sweep', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  legacyRecord(t, 4);
  t.jobs.list()[0].deps_before = [11, 12];
  world.sub.push({ number: 12, state: 'open', title: 'Reopened', labels: [] });
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), true);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true);
  assert.equal(comments(t).filter((text) => text.startsWith('@marcel ForgeHands: the planner of epic #10 ran')).length, 1);
  assert.equal(handovers().length, 1);
  clock += 10 * 60000;
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), false);
  assert.equal(handovers().length, 1);
});

test('a re-review that ends without a decision is handed to the human once the stall time is over', async () => {
  const t = await build({}, { wants: (kind) => kind === 'handover', notify: (message) => notes.push(message) });
  legacyRecord(t, 4);
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), true);
  const review = reviewRuns(t).at(-1);
  review.status = 'failed';
  review.finished = clock;
  clock += 4 * 3600000;
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), true);
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true);
  assert.equal(handovers().length, 1);
  assert.equal(reviewRuns(t).length, 1, 'no review is started again');
});

test('EPIC_GAP_STALL_MINUTES=0 switches the sweep off: a stalled replan is left as it is', async () => {
  const t = await build({ EPIC_GAP_STALL_MINUTES: '0' });
  legacyRecord(t, 4);
  assert.equal(await t.dispatcher.epicGaps.sweep(clock), false);
  const record = t.jobs.epicGaps.get('owner/hello#10');
  assert.equal(record.human, false);
  assert.equal(record.rereview, undefined);
  assert.equal(reviewRuns(t).length, 0);
  assert.equal(t.forgejo.writes().length, 0);
});

test('EPIC_GAP_STALL_MINUTES defaults to 180, takes 0 to 10080 and rejects anything else', () => {
  assert.equal(loadConfig(env()).epicGapStallMinutes, 180);
  assert.equal(loadConfig(env({ EPIC_GAP_STALL_MINUTES: '0' })).epicGapStallMinutes, 0);
  assert.equal(loadConfig(env({ EPIC_GAP_STALL_MINUTES: '10080' })).epicGapStallMinutes, 10080);
  assert.throws(() => loadConfig(env({ EPIC_GAP_STALL_MINUTES: '10081' })), /EPIC_GAP_STALL_MINUTES must be an integer between 0 and 10080/);
});

test('an epic handed to the human loses its gap record when the human closes it', async () => {
  const t = await build();
  await reviewRun(t);
  world.sha = 'cccc3333dddd4444';
  await reviewRun(t, { text: REVIEW_TEXT.replace('aaaa1111', 'cccc3333') });
  assert.equal(t.jobs.epicGaps.get('owner/hello#10').human, true);
  await t.dispatcher.onClosed(closedEvent(10));
  assert.equal(t.jobs.epicGaps.has('owner/hello#10'), false, 'no review or sweep looks at a handed epic again, so the close drops it');
});
