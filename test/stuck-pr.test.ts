// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Stuck pull requests: (1) the last allowed round that ends with a NOT OK verdict on its head hands the pull request to a human at once;
// (2) the stuck-PR watchdog of the review sweep (STUCK_PR_MINUTES) blocks an agent pull request that nothing moves on from, once per head;
// (3) tickets that wait behind a blocked pull request are marked on the status page, in the idle summary and in the gauges.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Notifier } from '../src/notify/index.ts';
import { buildStatus } from '../src/server/status.ts';
import { gaugeSamples, metrics } from '../src/metrics.ts';

const REVIEWER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const quiet = { error() {} };
const NEW = ('e2a3c2a0' + '0'.repeat(40)).slice(0, 40);
const NEWER = ('b7c1d2e3' + '0'.repeat(40)).slice(0, 40);
const CI_OK = ('a1b2c3d4' + '0'.repeat(40)).slice(0, 40);
const NOT_OK = 'Verdict: NOT OK\n' + 'The ticket contradicts itself, so no worker can satisfy it. '.repeat(8);
const OK = 'Verdict: OK\n' + 'Evidence: the criterion is met at src/a.ts line 12, bash validate.sh exits 0. '.repeat(8);
let dir; let clock; let openhands; let world; let counter = 0; let conversation;
const iso = (at) => new Date(at).toISOString();

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  HUMAN_LOGIN: 'marcel',
  LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: REVIEWER, tier: 'free' },
    'ai:changes': { profile: REVIEWER, tier: 'free', on: 'pull_request' },
    'pr:conflict': { profile: REVIEWER, tier: 'free', on: 'conflict' },
    'ci:success': { profile: REVIEWER, tier: 'strong', max_iterations: 60, on: 'ci_success' }
  }),
  ERROR_RETRIES: '0',
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };
const names = (number) => [...(world.labels[number] ?? [])];
const view = (pr) => ({ ...pr, labels: names(pr.number).map((name) => ({ name })) });

// A fake Forgejo (pulls, comments, labels, reviews, commit times) and a fake OpenHands whose conversations end in `conversation.state`.
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') { openhands.push(JSON.parse(request.body)); return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) }; }
    return { ok: true, status: 200, json: async () => ({ execution_status: conversation.state, metrics: null }) };
  }
  const path = u.pathname.replace(API, '');
  const body = request.body ? JSON.parse(request.body) : undefined;
  world.calls.push(request.method + ' ' + path);
  if (request.method === 'GET') {
    if (path === '/pulls') return answer(world.pulls.filter((pr) => pr.state === 'open').map(view));
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) { const pr = world.pulls.find((entry) => entry.number === Number(one[1])); return pr ? answer(view(pr)) : answer({ __status: 404 }); }
    const reviews = /^\/pulls\/(\d+)\/reviews$/.exec(path);
    if (reviews) return answer(world.reviews[reviews[1]] || []);
    const comments = /^\/issues\/(\d+)\/comments/.exec(path);
    if (comments) return answer(world.comments[comments[1]] || []);
    const labels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (labels) return answer(names(Number(labels[1])).map((name) => ({ name, id: world.catalog.find((entry) => entry.name === name)?.id })));
    if (path === '/labels') return answer(world.catalog);
    const status = /^\/commits\/([0-9a-f]+)\/status$/.exec(path);
    if (status) return answer(world.statuses[status[1]] || { state: 'pending', total_count: 0 });
    const commit = /^\/git\/commits\/([0-9a-f]+)$/.exec(path);
    if (commit) return answer({ created: world.commitTimes[commit[1]] ?? null });
    return answer({ __status: 404 });
  }
  if (request.method === 'POST') {
    const comment = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (comment) {
      (world.comments[comment[1]] ||= []).push({ created_at: iso(clock), user: { login: 'forgehands' }, body: body.body });
      return answer({});
    }
    const labelled = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (labelled) {
      for (const id of body.labels) (world.labels[labelled[1]] ||= new Set()).add(world.catalog.find((entry) => entry.id === id).name);
      return answer({});
    }
    if (path === '/labels') { const created = { id: world.catalog.length + 1, name: body.name }; world.catalog.push(created); return answer(created); }
  }
  if (request.method === 'DELETE') {
    const removed = /^\/issues\/(\d+)\/labels\/(\d+)$/.exec(path);
    if (removed) { world.labels[removed[1]]?.delete(world.catalog.find((entry) => entry.id === Number(removed[2]))?.name); return answer({}); }
  }
  return answer({ __status: 404 });
}

const freshWorld = () => ({
  pulls: [], labels: {}, comments: {}, reviews: {}, commitTimes: {}, statuses: {}, calls: [],
  catalog: [{ id: 1, name: 'ai:changes' }, { id: 2, name: 'ai:approved' }, { id: 3, name: 'ai:blocked' }, { id: 4, name: 'ai:hold' }]
});

// The agent pull request 34 of issue 56, with its head `sha`, its labels, and the comments it has (a verdict of the reviewer, say).
function agentPull(sha, labels = [], over = {}) {
  world.labels[34] = new Set(labels);
  world.commitTimes[sha] ??= iso(clock - 3 * HOUR);
  return { number: 34, state: 'open', merged: false, title: 'Fix it', body: 'B', html_url: 'https://forge.example/owner/hello/pulls/34',
    user: { login: 'forgehands' }, head: { ref: 'ai/issue-56', sha, repo: { full_name: repo } },
    base: { repo: { full_name: repo, default_branch: 'main', clone_url: 'https://forge.example/owner/hello.git', html_url: 'https://forge.example/owner/hello' } },
    created_at: iso(clock - 2 * DAY), ...over };
}
const verdict = (text, at) => ({ created_at: iso(at), user: { login: 'openhands' }, body: text });

async function build(extra = {}, immediate = ['blocked']) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const channel = { name: 'fake', sent: [], async send(message) { this.sent.push(message); } };
  const notifier = new Notifier([channel], immediate, () => false, quiet, () => {});
  const dispatcher = new Dispatcher(config, jobs, send, logger(), () => clock, notifier);
  return { config, jobs, dispatcher, channel };
}
const logs = [];
const logger = () => ({ error(...args) { logs.push(args.join(' ')); } });

// A job of the worker or the review routes on issue 56 (the pull request 34 when `pr`), in `status`.
function addJob(jobs, { label, status = 'done', pr = 34, commit, index = 0, started, finished, conversation } = {}) {
  const key = repo + '#56:' + label + (commit ? ':' + commit.slice(0, 8) : '') + ':' + index;
  return jobs.add({
    key, label, status, created: clock - (6 - index) * HOUR,
    started: started ?? (status === 'queued' ? undefined : clock - (5 - index) * HOUR),
    finished: finished ?? (status === 'done' ? clock - (4 - index) * HOUR : undefined),
    conversation_id: conversation ?? 'conv-' + key, attempts: 0,
    event: { type: commit ? 'ci.success' : 'issues.labeled', label, repository: { full_name: repo, default_branch: 'main' },
      issue: { number: 56, title: 'T', body: '', labels: [] }, sender: { login: 'marcel' },
      ...(pr ? { pull_request: { number: pr, head_ref: 'ai/issue-56' } } : {}), ...(commit ? { ci: { run_id: null, workflow: '', commit_sha: commit, status: 'success', html_url: null } } : {}) }
  });
}
// The review of a head is in the ledger, so the review sweep does not start one for it.
const reviewed = (jobs, sha) => addJob(jobs, { label: 'ci:success', commit: sha, index: 9 });
const reviews = () => openhands.filter((body) => body.agent_profile_id === REVIEWER);
const sentBlocked = (channel) => channel.sent.filter((message) => /blocked|stopped|ForgeHands/i.test(JSON.stringify(message)));
const comments = (number = 34) => (world.comments[number] || []).filter((entry) => entry.user?.login === 'forgehands').map((entry) => entry.body);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-stuck-'));
  clock = Date.parse('2026-11-18T12:00:00Z');
  openhands = [];
  world = freshWorld();
  conversation = { state: 'running' };
  logs.length = 0;
});
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

// ---- 1. the last allowed round ends with a NOT OK verdict on the head it left

test('the last allowed round ends with a NOT OK verdict on its head: the pull request is blocked at once, with one comment and one mail', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW, ['ai:changes'])];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  addJob(t.jobs, { label: 'ai:changes', index: 1 });
  addJob(t.jobs, { label: 'ai:changes', index: 2 });
  const last = addJob(t.jobs, { label: 'ai:changes', index: 3, status: 'running', finished: undefined });
  conversation = { state: 'finished' };
  await t.dispatcher.poll(last, clock);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(names(34).includes('ai:blocked'), 'the label is on');
  assert.equal(comments().length, 1);
  assert.match(comments()[0], /used up/);
  assert.match(comments()[0], /@marcel/, 'the human is mentioned');
  assert.equal(sentBlocked(t.channel).length, 1, 'one mail');
});

test('a round that is not the last allowed one, or that left a head with no verdict, blocks nothing', async () => {
  const early = await build();
  world.pulls = [agentPull(NEW, ['ai:changes'])];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(early.jobs, NEW);
  addJob(early.jobs, { label: 'ai:changes', index: 1 });
  const second = addJob(early.jobs, { label: 'ai:changes', index: 2, status: 'running', finished: undefined });
  conversation = { state: 'finished' };
  await early.dispatcher.poll(second, clock);
  assert.ok(!names(34).includes('ai:blocked'), 'two of three rounds: not used up');

  world = freshWorld();
  const pushed = await build();
  world.pulls = [agentPull(NEWER, ['ai:changes'])];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  world.commitTimes[NEWER] = iso(clock - HOUR);
  reviewed(pushed.jobs, NEW);
  addJob(pushed.jobs, { label: 'ai:changes', index: 1 });
  addJob(pushed.jobs, { label: 'ai:changes', index: 2 });
  const last = addJob(pushed.jobs, { label: 'ai:changes', index: 3, status: 'running', finished: undefined });
  conversation = { state: 'finished' };
  await pushed.dispatcher.poll(last, clock);
  assert.ok(!names(34).includes('ai:blocked'), 'the last round pushed NEWER, which no verdict has yet: the review of it decides');
  assert.equal(comments().length, 0);
});

// ---- 2. the stuck-PR watchdog of the review sweep

test('stuck by NOT OK and an unchanged head: blocked once, after STUCK_PR_MINUTES, with one mail', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW, ['ai:changes'])];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  addJob(t.jobs, { label: 'ai:changes', index: 1 });
  assert.equal(await t.dispatcher.sweep.run(), 0);
  assert.ok(!names(34).includes('ai:blocked'), 'the first sighting only starts the clock');
  clock += 60 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(!names(34).includes('ai:blocked'), 'not yet 90 minutes');
  clock += 35 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(names(34).includes('ai:blocked'), 'blocked after 95 minutes');
  assert.equal(comments().length, 1);
  assert.match(comments()[0], /NOT OK/);
  assert.match(comments()[0], /Verdict: NOT OK/, 'the first lines of the last verdict are quoted');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sentBlocked(t.channel).length, 1);
  clock += 6 * HOUR;
  await t.dispatcher.sweep.run();
  await t.dispatcher.sweep.run();
  assert.equal(comments().length, 1, 'once per head and reason');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sentBlocked(t.channel).length, 1, 'and one mail');
  assert.equal(reviews().length, 0, 'no review or round is started by the watchdog');
});

test('rounds used up, no run active and a verdict on the head: blocked by the watchdog', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW)];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  for (const index of [1, 2, 3]) addJob(t.jobs, { label: 'ai:changes', index });
  await t.dispatcher.sweep.run();
  assert.ok(names(34).includes('ai:blocked'));
  assert.match(comments()[0], /used up/);
  assert.match(metrics.render(), /forgehands_stuck_pr_blocks_total\{reason="stuck_rounds"\} [1-9]/);
});

test('a pull request waiting for its CI or its first review is not stuck', async () => {
  const t = await build();
  world.pulls = [agentPull(NEWER)];
  world.statuses[NEWER] = { state: 'pending', total_count: 2 };
  addJob(t.jobs, { label: 'ai:changes', index: 1 });
  addJob(t.jobs, { label: 'ai:changes', index: 2 });
  addJob(t.jobs, { label: 'ai:changes', index: 3 });
  for (let i = 0; i < 4; i++) { await t.dispatcher.sweep.run(); clock += HOUR; }
  assert.ok(!names(34).includes('ai:blocked'));
  assert.equal(comments().length, 0);
});

test('a pull request with a run queued or running on its issue is not stuck', async () => {
  for (const status of ['queued', 'running']) {
    const t = await build();
    world = freshWorld();
    world.pulls = [agentPull(NEW, ['ai:changes'])];
    world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
    reviewed(t.jobs, NEW);
    addJob(t.jobs, { label: 'ai:changes', index: 1 });
    addJob(t.jobs, { label: 'ai:changes', index: 2, status });
    for (let i = 0; i < 3; i++) { await t.dispatcher.sweep.run(); clock += HOUR; }
    assert.ok(!names(34).includes('ai:blocked'), status);
    assert.equal(comments().length, 0, status);
    clock -= 3 * HOUR;
  }
});

test('a human who removes the label gets the pull request back: eligible again after the grace; a new head counts its grace from itself', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW, ['ai:changes'])];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  addJob(t.jobs, { label: 'ai:changes', index: 1 });
  await t.dispatcher.sweep.run();
  clock += 100 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(names(34).includes('ai:blocked'));
  world.labels[34].delete('ai:blocked');
  await t.dispatcher.sweep.run();
  assert.ok(!names(34).includes('ai:blocked'), 'the removal starts the grace: no immediate re-block');
  clock += 30 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(!names(34).includes('ai:blocked'), 'still within the grace');
  clock += 65 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(names(34).includes('ai:blocked'), 'eligible again after the grace');
  assert.equal(comments().length, 2, 'a second block is a second comment');

  // A new head after the removal: its own grace, counted from the new head's first verdict.
  world.labels[34].delete('ai:blocked');
  await t.dispatcher.sweep.run();
  world.pulls[0].head.sha = NEWER;
  world.commitTimes[NEWER] = iso(clock + 5 * MINUTE);
  world.comments[34].push(verdict(NOT_OK, clock + 10 * MINUTE));
  clock += 20 * MINUTE;
  reviewed(t.jobs, NEWER);
  await t.dispatcher.sweep.run();
  assert.ok(!names(34).includes('ai:blocked'), 'the new head starts its own grace');
  clock += 95 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.ok(names(34).includes('ai:blocked'));
  assert.match(comments().at(-1), new RegExp(NEWER.slice(0, 7)), 'the comment names the new head');
});

test('STUCK_PR_MINUTES=0 switches the watchdog off', async () => {
  const t = await build({ STUCK_PR_MINUTES: '0' });
  world.pulls = [agentPull(NEW)];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  for (const index of [1, 2, 3]) addJob(t.jobs, { label: 'ai:changes', index });
  for (let i = 0; i < 3; i++) { await t.dispatcher.sweep.run(); clock += 2 * HOUR; }
  assert.ok(!names(34).includes('ai:blocked'));
  assert.equal(comments().length, 0);
  assert.equal(t.jobs.stuck.size, 0);
  assert.equal(loadConfig(env()).stuckPrMinutes, 90, 'the default is 90 minutes');
  assert.throws(() => loadConfig(env({ STUCK_PR_MINUTES: '-1' })), /STUCK_PR_MINUTES must be an integer between 0 and 10080/);
});

test('a dry run blocks nothing', async () => {
  const t = await build({ DRY_RUN: '1' });
  world.pulls = [agentPull(NEW)];
  world.comments[34] = [verdict(NOT_OK, clock - 2 * HOUR)];
  reviewed(t.jobs, NEW);
  for (const index of [1, 2, 3]) addJob(t.jobs, { label: 'ai:changes', index });
  await t.dispatcher.sweep.run();
  assert.ok(!names(34).includes('ai:blocked'));
  assert.equal(comments().length, 0);
});

// ---- 3. the chain: tickets that wait behind a blocked pull request

test('tickets that wait, directly or transitively, behind a blocked pull request are marked on the status page and in the idle summary', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW, ['ai:blocked'])];
  reviewed(t.jobs, NEW);
  addJob(t.jobs, { label: 'ai:ready', index: 0, status: 'done', pr: null });
  await t.dispatcher.sweep.run(); // records the blocked pull request
  const waiting = (issue, on) => t.jobs.add({ key: repo + '#' + issue + ':ai:ready', label: 'ai:ready', status: 'waiting', created: clock - HOUR, attempts: 0, waiting_for: [on],
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: issue, title: 'W', body: '', labels: [] }, sender: { login: 'marcel' } } });
  waiting(60, 56);
  waiting(61, 60);
  waiting(62, 99);
  const status = buildStatus(t.config, t.jobs, clock);
  const row = (issue) => status.issues.find((entry) => entry.issue === repo + '#' + issue);
  assert.deepEqual(row(60).blocked_by_stuck, [56]);
  assert.equal(row(60).state, 'waiting behind stuck #56');
  assert.deepEqual(row(61).blocked_by_stuck, [56], 'transitively');
  assert.equal(row(61).state, 'waiting behind stuck #56');
  assert.deepEqual(row(62).blocked_by_stuck, [], 'a wait on another ticket is not marked');
  assert.equal(row(62).state, 'waiting for #99');
  assert.equal(t.dispatcher.idleCounts(clock).reasons.stuck, 2);
  const gauge = gaugeSamples(t.config, t.jobs, new Map(), clock).find((entry) => entry.name === 'forgehands_stuck_pull_requests');
  assert.equal(gauge.value, 1);
});

test('a blocked pull request that is closed leaves the chain', async () => {
  const t = await build();
  world.pulls = [agentPull(NEW, ['ai:blocked'])];
  reviewed(t.jobs, NEW);
  t.jobs.add({ key: repo + '#60:ai:ready', label: 'ai:ready', status: 'waiting', created: clock - HOUR, attempts: 0, waiting_for: [56],
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo, default_branch: 'main' }, issue: { number: 60, title: 'W', body: '', labels: [] }, sender: { login: 'marcel' } } });
  await t.dispatcher.sweep.run();
  assert.deepEqual(buildStatus(t.config, t.jobs, clock).issues.find((entry) => entry.issue === repo + '#60').blocked_by_stuck, [56]);
  world.pulls[0].state = 'closed';
  await t.dispatcher.sweep.run();
  assert.deepEqual(buildStatus(t.config, t.jobs, clock).issues.find((entry) => entry.issue === repo + '#60').blocked_by_stuck, []);
});
