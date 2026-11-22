// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildStatus, renderStatus } from '../src/server/status.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const DAY = 86400000;
const repo = 'owner/hello';
const quiet = { error() {} };
let dir; let clock; let posts; let pulls; let comments; let dependencies;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
  FORGEJO_TOKEN: 'tok',
  FORGEJO_URL: 'https://forge.example',
  HUMAN_LOGIN: 'marcel',
  REMIND_AFTER_DAYS: '3',
  ARCHIVE_AFTER_DAYS: '0',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

const iso = (at) => new Date(at).toISOString();
const pull = (number, labels, extra = {}) => ({ number, state: 'open', merged: false, title: 'T', head: { ref: 'ai/issue-' + (number - 100), sha: 'abcdef123456', repo: { full_name: repo } },
  labels: labels.map((name) => ({ name })), created_at: iso(clock - 10 * DAY), updated_at: iso(clock - 5 * DAY), ...extra });
const comment = (body, at, login = 'forgehands-bot') => ({ body, created_at: iso(at), user: { login } });

async function build(extra) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs.json'));
  await jobs.load();
  const send = async (url, request) => {
    const parsed = new URL(url);
    const path = (parsed.pathname + parsed.search).replace('/api/v1/repos/' + repo, '');
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (request.method === 'POST') { posts.push({ path, body: JSON.parse(request.body) }); return reply({ id: 40 }); }
    if (path.startsWith('/pulls?')) return reply(pulls);
    const issue = /^\/issues\/(\d+)\/comments/.exec(path);
    if (issue) return reply(comments[issue[1]] || []);
    const deps = /^\/issues\/(\d+)\/dependencies/.exec(path);
    if (deps) return reply(dependencies[deps[1]] || []);
    if (path.startsWith('/labels')) return reply([]);
    if (path.includes('/status')) return reply({ state: 'success', total_count: 1 });
    if (path.includes('/files')) return reply([{ filename: '.forgejo/workflows/ci.yml' }]);
    return reply({});
  };
  return { config, jobs, dispatcher: new Dispatcher(config, jobs, send, quiet, () => clock) };
}
const reminders = () => posts.filter((post) => post.path.endsWith('/comments')).map((post) => post.body.body);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-remind-')); clock = Date.parse('2026-11-16T10:00:00Z'); posts = []; pulls = []; comments = {}; dependencies = {}; });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('REMIND_AFTER_DAYS is off by default and needs Forgejo access and HUMAN_LOGIN', () => {
  assert.equal(loadConfig(env({ REMIND_AFTER_DAYS: undefined })).remindAfterDays, 0);
  assert.throws(() => loadConfig(env({ HUMAN_LOGIN: undefined })), /REMIND_AFTER_DAYS needs/);
  assert.throws(() => loadConfig(env({ REMIND_AFTER_DAYS: '-1' })), /REMIND_AFTER_DAYS/);
  assert.equal(loadConfig(env()).remindMax, 3);
});

test('nothing is written while the reminders are off', async () => {
  const { dispatcher } = await build({ REMIND_AFTER_DAYS: '0' });
  pulls = [pull(101, ['ai:blocked'])];
  await dispatcher.tick();
  assert.deepEqual(posts, []);
});

test('no reminder before n days: the hand-over is younger than n days', async () => {
  const { dispatcher } = await build();
  pulls = [pull(101, ['ai:blocked'], { updated_at: iso(clock - DAY) })];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 2 * DAY)];
  await dispatcher.tick();
  assert.deepEqual(reminders(), []);
});

test('one reminder after n days, mentioning only the human, and not twice within n days', async () => {
  const { dispatcher } = await build();
  pulls = [pull(101, ['ai:blocked'])];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 4 * DAY)];
  await dispatcher.tick();
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0], /^@marcel ForgeHands: reminder 1 of 3: this pull request has been waiting for you since 2026-11-12 \(it is marked ai:blocked\)\.$/);
  assert.equal([...reminders()[0].matchAll(/@\w+/g)].length, 1);
  // The daily look does not repeat inside a day ...
  clock += 2 * 3600000;
  await dispatcher.tick();
  assert.equal(reminders().length, 1);
  // ... and a look the next day finds the reminder younger than n days.
  comments[101].push(comment(reminders()[0], clock));
  clock += DAY + 1;
  await dispatcher.tick();
  assert.equal(reminders().length, 1);
  clock += 3 * DAY;
  await dispatcher.tick();
  assert.equal(reminders().length, 2);
  assert.match(reminders()[1], /reminder 2 of 3/);
});

test('REMIND_MAX stops the reminders, and STALE_LABEL goes on after the last one', async () => {
  const { dispatcher } = await build({ REMIND_MAX: '2', STALE_LABEL: 'ai:stale' });
  pulls = [pull(101, ['ai:blocked'])];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 10 * DAY), comment('@marcel ForgeHands: reminder 1 of 2: x', clock - 4 * DAY)];
  await dispatcher.tick();
  assert.match(reminders()[0], /reminder 2 of 2.* This is the last reminder\.$/);
  assert.ok(posts.some((post) => post.path === '/labels' && post.body.name === 'ai:stale'), 'label created');
  assert.ok(posts.some((post) => post.path === '/issues/101/labels'), 'label added');
  comments[101].push(comment(reminders()[0], clock));
  posts.length = 0;
  clock += 5 * DAY;
  await dispatcher.tick();
  assert.deepEqual(posts, [], 'nothing more after REMIND_MAX');
});

test('a comment of the human resets the count and holds the next reminder back', async () => {
  const { dispatcher } = await build({ REMIND_MAX: '1' });
  pulls = [pull(101, ['ai:blocked'])];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 20 * DAY), comment('@marcel ForgeHands: reminder 1 of 1: x', clock - 10 * DAY), comment('looking', clock - 5 * DAY, 'Marcel')];
  await dispatcher.tick();
  assert.equal(reminders().length, 1, 'the used-up count started again after his comment');
  assert.match(reminders()[0], /reminder 1 of 1/);
  clock += 5 * DAY;
  comments[101] = [...comments[101], comment('looking again', clock - DAY, 'marcel')];
  posts.length = 0;
  await dispatcher.tick();
  assert.deepEqual(posts, [], 'he commented less than n days ago');
});

test('approved and green on a protected path is reminded, a pull request in flight or recently touched is not', async () => {
  const { dispatcher, jobs } = await build({ MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['.forgejo/**'] } }) });
  pulls = [pull(101, ['ai:approved']), pull(102, [], { updated_at: iso(clock - DAY) }), pull(103, [])];
  jobs.add({ key: 'owner/hello#3:ai:ready', label: 'ai:ready', status: 'running', created: clock, event: { repository: { full_name: repo }, issue: { number: 3 } } });
  comments[101] = [comment('@marcel ForgeHands: approved and green', clock - 4 * DAY)];
  await dispatcher.tick();
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0], /touches protected paths/);
  const stale = await build();
  pulls = [pull(104, [])];
  await stale.dispatcher.tick();
  assert.match(reminders()[1], /nothing has happened on it for 3 days and no run is active/);
});

test('a waiting job whose dependencies are all closed is started instead of reminded', async () => {
  const { dispatcher, jobs } = await build();
  const job = jobs.add({ key: 'owner/hello#7:ai:ready', label: 'ai:ready', status: 'waiting', waiting_for: [5], created: clock - 9 * DAY,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo }, issue: { number: 7, title: 'T', body: '', labels: ['ai:ready'] }, sender: { login: 'marcel' } } });
  dependencies[7] = [{ number: 5, state: 'closed' }];
  await dispatcher.tick();
  assert.notEqual(job.status, 'waiting');
  assert.equal(job.waiting_for, undefined);
  assert.deepEqual(reminders(), []);
  const open = await build();
  const other = open.jobs.add({ key: 'owner/hello#8:ai:ready', label: 'ai:ready', status: 'waiting', waiting_for: [5], created: clock,
    event: { type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo }, issue: { number: 8, title: 'T', body: '', labels: ['ai:ready'] }, sender: { login: 'marcel' } } });
  dependencies[8] = [{ number: 5, state: 'open' }];
  await open.dispatcher.tick();
  assert.equal(other.status, 'waiting');
});

test('/status shows what waits for a human since when', async () => {
  const { dispatcher, jobs, config } = await build();
  pulls = [pull(101, ['ai:blocked'])];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 4 * DAY)];
  await dispatcher.tick();
  const status = buildStatus(config, jobs, clock, undefined, [...dispatcher.reminder.waiting.values()]);
  assert.deepEqual(status.waiting_for_human, [{ repository: repo, issue: 1, pr: 101, since: '2026-11-12', reason: 'it is marked ai:blocked', issue_url: 'https://forge.example/owner/hello/issues/1', pr_url: 'https://forge.example/owner/hello/pulls/101', reason_links: {} }]);
  assert.match(renderStatus(status), /waiting for a human since 2026-11-12/);
});

test('a blocked dependency bot pull request is reminded, an unblocked one is not', async () => {
  const { dispatcher } = await build({ BOT_AUTHORS: 'renovate' });
  const bot = (number, labels) => pull(number, labels, { head: { ref: 'renovate/x', sha: 'abc', repo: { full_name: repo } }, user: { login: 'renovate' } });
  pulls = [bot(201, ['ai:blocked']), bot(202, [])];
  comments[201] = [comment('@marcel ForgeHands: handed over', clock - 4 * DAY)];
  await dispatcher.tick();
  assert.equal(reminders().length, 1);
  assert.ok(posts.some((post) => post.path === '/issues/201/comments'));
});

test('in a dry run the reminder is only logged, never sent', async () => {
  const { dispatcher } = await build({ DRY_RUN: '1' });
  pulls = [pull(101, ['ai:blocked'])];
  comments[101] = [comment('@marcel ForgeHands: handed over', clock - 4 * DAY)];
  await dispatcher.tick();
  assert.deepEqual(posts, []);
  assert.ok(dispatcher.dry.writes.some((write) => /reminder 1 of 3/.test(JSON.stringify(write))));
});
