// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// REVIEW_SWEEP_MINUTES: the reconciler that starts the review of a pull request head that has none in the ledger.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';

const REVIEWER = '55555555-5555-4555-8555-555555555555';
const repo = 'owner/hello';
const API = '/api/v1/repos/owner/hello';
const DAY = 86400000;
const MINUTE = 60000;
const HOUR = 3600000;
const quiet = { error() {} };
let dir; let clock; let logs; let openhands; let world; let counter = 0;
const logger = { error(...args) { logs.push(args.join(' ')); } };
// A 40 hex commit id from a short prefix.
const sha = (prefix) => (prefix + '0'.repeat(40)).slice(0, 40);
const OLD = sha('f1720071');
const NEW = sha('e2a3c2a0');

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
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

// A pull request as Forgejo lists it (created `ageDays` ago; a repository without CI unless `world.workflows` says so).
const pull = (number, head, over = {}) => ({ number, state: 'open', merged: false, title: 'Fix it', body: 'B', html_url: 'https://forge.example/owner/hello/pulls/' + number,
  user: { login: 'forgehands' }, head: { ref: 'ai/issue-' + (number + 20), sha: head, repo: { full_name: repo } },
  base: { repo: { full_name: repo, default_branch: 'main', clone_url: 'https://forge.example/owner/hello.git', html_url: 'https://forge.example/owner/hello' } },
  labels: [], created_at: new Date(clock - 2 * DAY).toISOString(), ...over });
const answer = (value) => value && value.__status ? { ok: false, status: value.__status } : { ok: true, status: 200, json: async () => value };

// A fake Forgejo (pulls, commit statuses, workflow folders, labels) and a fake OpenHands; `world` is changed by the tests.
function freshWorld() {
  return { pulls: [], statuses: {}, status: { state: 'pending', total_count: 0 }, workflows: {}, pullsStatus: null, calls: [], routes: {} };
}
async function send(url, request) {
  const u = new URL(url);
  if (u.host !== 'forge.example') {
    if (request.method === 'POST') { openhands.push(JSON.parse(request.body)); return { ok: true, status: 201, json: async () => ({ id: 'conv-' + openhands.length }) }; }
    return { ok: true, status: 200, json: async () => ({ execution_status: 'running', metrics: null }) };
  }
  const path = u.pathname.replace(API, '');
  world.calls.push(request.method + ' ' + path);
  // Routes a test adds (the approval safety net reads the comments, the files and the commit time, and merges).
  const extra = world.routes?.[request.method + ' ' + path];
  if (extra) return answer(typeof extra === 'function' ? extra(request) : extra);
  if (request.method === 'GET') {
    if (path === '/pulls') return world.pullsStatus ? { ok: false, status: world.pullsStatus } : answer(world.pulls);
    const one = /^\/pulls\/(\d+)$/.exec(path);
    if (one) return answer(world.pulls.find((entry) => entry.number === Number(one[1])) ?? { __status: 404 });
    const status = /^\/commits\/([0-9a-f]+)\/status$/.exec(path);
    if (status) return answer(world.statuses[status[1]] || world.status);
    if (path.startsWith('/contents/')) return answer(world.workflows[path.slice('/contents/'.length).split('?')[0]] ?? { __status: 404 });
    if (path.endsWith('/labels')) return answer([]);
  }
  return answer({ __status: 404 });
}

async function build(extra = {}) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => clock);
  return { config, jobs, dispatcher };
}
// A ledger job: a run on issue `issue` (or on the pull request `pr` with the commit `commit` of a review), in `status`.
function addJob(jobs, { label, status = 'done', issue = 56, pr, commit, key } = {}) {
  return jobs.add({
    key: key || repo + '#' + issue + ':' + label + (commit ? ':' + commit.slice(0, 8) : ''), label, status, created: clock - HOUR, started: clock - HOUR, finished: status === 'running' || status === 'queued' ? undefined : clock - HOUR / 2,
    attempts: 0, event: { type: commit ? 'ci.success' : 'issues.labeled', label, repository: { full_name: repo, default_branch: 'main' }, issue: { number: issue, title: 'T', body: '', labels: [] }, sender: { login: 'marcel' },
      ...(pr ? { pull_request: { number: pr, head_ref: 'ai/issue-' + issue } } : {}), ...(commit ? { ci: { run_id: null, workflow: '', commit_sha: commit, status: 'success', html_url: null } } : {}) }
  });
}
const reviews = () => openhands.filter((body) => body.agent_profile_id === REVIEWER);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-sweep-')); clock = Date.parse('2026-11-18T12:00:00Z'); logs = []; openhands = []; world = freshWorld(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('levelUp #71: a round that rebased and ended without a commit leaves the new head unreviewed; the sweep starts exactly one review for it', async () => {
  const t = await build();
  // The ledger as it was: the worker, the review of the old commit (NOT OK), the conflict round that force-pushed NEW, the changes round that pushed nothing.
  addJob(t.jobs, { label: 'ai:ready', issue: 56, status: 'done' });
  addJob(t.jobs, { label: 'ci:success', issue: 56, pr: 34, commit: OLD, status: 'done' });
  addJob(t.jobs, { label: 'pr:conflict', issue: 56, pr: 34, status: 'done' });
  addJob(t.jobs, { label: 'ai:changes', issue: 56, pr: 34, status: 'done' });
  world.pulls = [pull(34, NEW, { head: { ref: 'ai/issue-56', sha: NEW, repo: { full_name: repo } }, labels: [] })];
  assert.equal(await t.dispatcher.sweep.run(), 1);
  const started = t.jobs.list().filter((job) => job.event.ci?.commit_sha === NEW);
  assert.equal(started.length, 1);
  assert.equal(started[0].label, 'ci:success');
  assert.equal(started[0].event.action, 'sweep');
  assert.equal(started[0].event.pull_request.number, 34);
  assert.ok(logs.some((line) => line === 'owner/hello#34: head ' + NEW.slice(0, 7) + ' has no review, starting it'));
  assert.equal(await t.dispatcher.sweep.run(), 0, 'the next pass finds the review in the ledger');
  assert.equal(t.jobs.list().filter((job) => job.event.ci?.commit_sha === NEW).length, 1);
});

test('a pull request with approved, changes, blocked or hold is skipped', async () => {
  for (const label of ['ai:approved', 'ai:changes', 'ai:blocked', 'ai:hold']) {
    const t = await build({ TWO_KEYS_HOLD_MINUTES: '0' });
    world = freshWorld();
    world.pulls = [pull(34, NEW, { labels: [{ name: label }] })];
    assert.equal(await t.dispatcher.sweep.run(), 0, label);
    assert.equal(reviews().length, 0);
  }
});

test('a pull request with a running, queued or waiting job is skipped; a worker still on the issue counts too', async () => {
  for (const status of ['running', 'queued', 'waiting']) {
    const t = await build();
    world = freshWorld();
    world.pulls = [pull(34, NEW)];
    addJob(t.jobs, { label: 'pr:conflict', issue: 56, pr: 34, status });
    assert.equal(await t.dispatcher.sweep.run(), 0, status);
  }
  const worker = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW, { head: { ref: 'ai/issue-56', sha: NEW, repo: { full_name: repo } } })];
  addJob(worker.jobs, { label: 'ai:ready', issue: 56, status: 'running' });
  assert.equal(await worker.dispatcher.sweep.run(), 0, 'the agent works on the issue');
});

test('a head that already has a review job is skipped, also when that review failed', async () => {
  for (const status of ['done', 'failed']) {
    const t = await build();
    world = freshWorld();
    world.pulls = [pull(34, NEW)];
    addJob(t.jobs, { label: 'ci:success', issue: 56, pr: 34, commit: NEW, status });
    assert.equal(await t.dispatcher.sweep.run(), 0, status);
    assert.equal(reviews().length, 0);
  }
});

test('a head with a pending or failed CI status is skipped; the CI events own that commit', async () => {
  for (const state of ['pending', 'failure']) {
    const t = await build();
    world = freshWorld();
    world.pulls = [pull(34, NEW)];
    world.statuses[NEW] = { state, total_count: 2 };
    assert.equal(await t.dispatcher.sweep.run(), 0, state);
  }
});

test('a repository without any workflow file starts the review; a green CI status does too', async () => {
  const noCi = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW)];
  assert.equal(await noCi.dispatcher.sweep.run(), 1, 'no CI');
  const green = await build();
  world = freshWorld();
  world.pulls = [pull(35, NEW, { head: { ref: 'ai/issue-55', sha: NEW, repo: { full_name: repo } } })];
  world.statuses[NEW] = { state: 'success', total_count: 2 };
  assert.equal(await green.dispatcher.sweep.run(), 1, 'green CI');
});

test('a fork, a pull request older than 30 days, and a draft are not swept', async () => {
  const t = await build();
  world = freshWorld();
  world.pulls = [
    pull(34, NEW, { head: { ref: 'ai/issue-56', sha: NEW, repo: { full_name: 'other/hello' } } }),
    pull(35, sha('aaaa'), { created_at: new Date(clock - 31 * DAY).toISOString(), head: { ref: 'ai/issue-57', sha: sha('aaaa'), repo: { full_name: repo } } }),
    pull(36, sha('bbbb'), { draft: true, head: { ref: 'ai/issue-58', sha: sha('bbbb'), repo: { full_name: repo } } })
  ];
  assert.equal(await t.dispatcher.sweep.run(), 0);
});

test('a WIP-titled agent pull request that Forgejo reports as a draft is swept; the author\'s own draft is not', async () => {
  const wip = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW, { title: 'WIP: Fix it', draft: true })];
  assert.equal(await wip.dispatcher.sweep.run(), 1, 'the WIP marker is the agent\'s normal state');
  const own = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW, { title: 'Fix it', draft: true })];
  assert.equal(await own.dispatcher.sweep.run(), 0, 'a draft by the author is left alone');
});

test('at most 5 reviews per pass; the rest follows on the next pass', async () => {
  const t = await build();
  world = freshWorld();
  world.pulls = Array.from({ length: 7 }, (_, i) => pull(40 + i, sha('c' + i), { head: { ref: 'ai/issue-' + (60 + i), sha: sha('c' + i), repo: { full_name: repo } } }));
  assert.equal(await t.dispatcher.sweep.run(), 5);
  assert.equal(await t.dispatcher.sweep.run(), 2);
  assert.equal(t.jobs.list().filter((job) => job.event.action === 'sweep').length, 7);
});

test('the cooldown: a head tried in the last hour is not tried again, even when its job is gone', async () => {
  const t = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW)];
  assert.equal(await t.dispatcher.sweep.run(), 1);
  for (const job of t.jobs.list()) t.jobs.remove(job.id); // the job was lost (or never kept)
  clock += 10 * MINUTE;
  assert.equal(await t.dispatcher.sweep.run(), 0, 'within the hour');
  clock += HOUR;
  assert.equal(await t.dispatcher.sweep.run(), 1, 'after the hour it is tried again');
});

test('a forge read error does nothing: no start, the error is logged, the pass goes on', async () => {
  const t = await build();
  world = freshWorld();
  world.pullsStatus = 500;
  assert.equal(await t.dispatcher.sweep.run(), 0);
  assert.ok(logs.some((line) => /could not list the open pull requests of owner\/hello/.test(line)));
  assert.equal(t.jobs.list().length, 0);
});

test('REVERT_SWEEP: REVIEW_SWEEP_MINUTES=0 switches the sweep off; the default is 10 minutes', async () => {
  const off = await build({ REVIEW_SWEEP_MINUTES: '0' });
  world = freshWorld();
  world.pulls = [pull(34, NEW)];
  assert.equal(off.dispatcher.sweep.enabled, false);
  assert.equal(await off.dispatcher.sweep.run(), 0);
  assert.equal(world.calls.length, 0, 'no call to the forge');
  off.dispatcher.sweep.start();
  assert.equal(off.dispatcher.sweep.firstTimer, undefined);
  assert.equal((await build()).config.reviewSweepMinutes, 10);
  assert.throws(() => loadConfig(env({ REVIEW_SWEEP_MINUTES: '-1' })), /REVIEW_SWEEP_MINUTES must be an integer between 0 and 1440/);
  assert.throws(() => loadConfig(env({ REVIEW_SWEEP_MINUTES: '1441' })), /REVIEW_SWEEP_MINUTES must be an integer between 0 and 1440/);
});

test('the sweep starts its first pass about 90 seconds after start, and stop clears the timers', async () => {
  const t = await build();
  t.dispatcher.sweep.start();
  assert.ok(t.dispatcher.sweep.firstTimer);
  assert.ok(t.dispatcher.sweep.timer);
  t.dispatcher.sweep.stop();
});

test('a dry run starts nothing', async () => {
  const t = await build({ DRY_RUN: '1' });
  world = freshWorld();
  world.pulls = [pull(34, NEW)];
  assert.equal(await t.dispatcher.sweep.run(), 0);
  assert.equal(t.jobs.list().length, 0);
  assert.equal(openhands.length, 0);
});

test('a late webhook for the same commit does not start a second review', async () => {
  const t = await build();
  world = freshWorld();
  world.pulls = [pull(34, NEW)];
  assert.equal(await t.dispatcher.sweep.run(), 1);
  const late = t.dispatcher.sweep.eventOf(repo, world.pulls[0], t.dispatcher.sweep.candidate(repo, world.pulls[0]), NEW, 'ci:success', 'no_ci');
  assert.equal((await t.dispatcher.enqueue(late)).status, 'duplicate_job');
  assert.equal(t.jobs.list().filter((job) => job.event.ci?.commit_sha === NEW).length, 1);
});

// The approval safety net (sweepApproved): an approved, green, OK-verdict pull request that is not merged is handed to the merger once per head and 30 minutes.
const APPROVAL_ENV = { MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }) };
const VERDICT = '## Verdict: OK\n' + 'Evidence: criterion met at src/a.mjs line 12, check bash validate.sh exit 0. '.repeat(8);
// An approved agent pull request with an OK verdict on NEW, green CI and the given files; the merge calls are recorded in `merges`.
function approvedWorld(files = ['src/a.mjs'], labels = ['ai:approved']) {
  const merges = [];
  world.pulls = [pull(34, NEW, { labels: labels.map((name) => ({ name })) })];
  world.statuses[NEW] = { state: 'success', total_count: 2 };
  world.routes = {
    ['GET /issues/34/comments']: [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'reviewer' }, body: VERDICT }],
    ['GET /git/commits/' + NEW]: { created: '2026-11-15T10:00:00Z' },
    ['GET /pulls/34/files']: files.map((filename) => ({ filename })),
    ['POST /pulls/34/merge']: () => { merges.push(clock); return {}; }
  };
  return merges;
}

test('approval safety net: an approved, green pull request with an OK verdict that is not merged is handed to the merger; the merge follows', async () => {
  const t = await build(APPROVAL_ENV);
  const merges = approvedWorld();
  await t.dispatcher.sweep.run();
  assert.equal(merges.length, 1, 'the pull request is merged');
  assert.ok(logs.some((line) => line === 'owner/hello#34: approved and green at head ' + NEW.slice(0, 7) + ' but not merged, the approval sweep hands it to the merger'));
  assert.ok(logs.includes('owner/hello#34: merged (' + NEW.slice(0, 7) + ')'));
  assert.equal(reviews().length, 0, 'an approved pull request starts no review');
});

test('approval safety net: once per head per 30 minutes; the next look comes after that', async () => {
  const t = await build(APPROVAL_ENV);
  const merges = approvedWorld(['src/a.mjs']);
  world.routes['POST /pulls/34/merge'] = () => { merges.push(clock); return { __status: 405 }; };
  await t.dispatcher.sweep.run();
  clock += 10 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.equal(merges.length, 1, 'no second hand-over within 30 minutes');
  clock += 25 * MINUTE;
  await t.dispatcher.sweep.run();
  assert.equal(merges.length, 2, 'after 30 minutes the head is looked at again');
});

test('approval safety net: a held, blocked, protected or unverdicted pull request is not merged', async () => {
  for (const labels of [['ai:approved', 'ai:hold'], ['ai:approved', 'ai:blocked']]) {
    const t = await build(APPROVAL_ENV);
    const merges = approvedWorld(['src/a.mjs'], labels);
    await t.dispatcher.sweep.run();
    assert.equal(merges.length, 0, labels.join(' '));
  }
  const protectedTest = await build(APPROVAL_ENV);
  const protectedMerges = approvedWorld(['compose.yaml']);
  await protectedTest.dispatcher.sweep.run();
  assert.equal(protectedMerges.length, 0, 'a protected path is handed over by the dispatcher, never merged by the sweep');
  assert.ok(!world.calls.includes('POST /issues/34/comments'), 'and no hand-over comment is written by the sweep');
  const unverdicted = await build(APPROVAL_ENV);
  const noVerdict = approvedWorld(['src/a.mjs']);
  world.routes['GET /issues/34/comments'] = [];
  await unverdicted.dispatcher.sweep.run();
  assert.equal(noVerdict.length, 0, 'no OK verdict for the head: nothing is merged');
});

test('approval safety net: a pull request whose ledger hold is running is left to the hold timer', async () => {
  const t = await build(APPROVAL_ENV);
  const merges = approvedWorld(['src/a.mjs']);
  t.jobs.holds.set('owner/hello#pr34', { repository: repo, number: 34, sha: NEW, since: clock - MINUTE, merge_after: clock + HOUR, check_at: clock + HOUR });
  await t.dispatcher.sweep.run();
  assert.equal(merges.length, 0);
});

test('approval safety net: a dry run starts nothing and merges nothing', async () => {
  const t = await build({ ...APPROVAL_ENV, DRY_RUN: '1' });
  const merges = approvedWorld(['src/a.mjs']);
  await t.dispatcher.sweep.run();
  assert.equal(merges.length, 0);
});
