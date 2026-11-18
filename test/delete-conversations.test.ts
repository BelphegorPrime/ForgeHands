// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// DELETE_AFTER_DAYS: the OpenHands conversation of an archived run goes after the limit; the ledger keeps the run.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildStatus } from '../src/server/status.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const quiet = { error() {} };
const DAY = 86400000;
const HOUR = 3600000;
let dir; let clock; let counter = 0;

const env = (extra = {}) => ({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
  AGENT_SECRETS: 'FORGEJO_TOKEN,FORGEJO_URL',
  FORGEJO_TOKEN: 'tok-secret-value',
  FORGEJO_URL: 'https://forge.example',
  DATA_FILE: join(dir, 'deliveries.json'),
  ...extra
});

// A fake OpenHands: GET answers a finished conversation, DELETE answers `answer(id)` (a status number, default 200) and is recorded.
function openhands(answer = () => 200) {
  const deletes = [];
  const send = async (url, request) => {
    const path = new URL(url).pathname;
    if (request.method === 'DELETE') {
      const id = path.split('/').pop();
      deletes.push(id);
      const status = answer(id, deletes.length);
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ execution_status: 'finished', tags: {}, stats: { usage_to_metrics: {} } }) };
  };
  return { deletes, send };
}

async function build(extra = {}, answer) {
  const config = loadConfig(env(extra));
  const jobs = new JobStore(join(dir, 'jobs-' + (counter++) + '.json'));
  await jobs.load();
  const api = openhands(answer);
  const dispatcher = new Dispatcher(config, jobs, api.send, quiet, () => clock);
  return { config, jobs, dispatcher, deletes: api.deletes };
}

// One job of issue n. Old (finished `ago` days before the clock) and archived unless said otherwise.
function addJob(jobs, n, { status = 'done', ago = 2, conv = 'conv-' + n + '-' + jobs.list().length, archived = true, extra = {}, label = 'ai:ready' } = {}) {
  return jobs.add({ key: repo + '#' + n + ':' + label, label, status, created: clock - (ago + 1) * DAY, started: clock - (ago + 1) * DAY,
    finished: status === 'running' || status === 'queued' || status === 'waiting' ? undefined : clock - ago * DAY,
    conversation_id: conv, archived, attempts: 0, ...extra,
    event: { type: 'issues.labeled', label, repository: { full_name: repo, default_branch: 'main' }, issue: { number: n, title: 'T', body: '', labels: [] }, sender: { login: 'marcel' } } });
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-delete-')); clock = Date.parse('2026-11-18T12:00:00Z'); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('off by default: nothing is deleted and the pass does nothing', async () => {
  const t = await build();
  addJob(t.jobs, 1, { ago: 400 });
  assert.equal(await t.dispatcher.deleteOld(clock), false);
  assert.deepEqual(t.deletes, []);
});

test('an archived run that ended after DELETE_AFTER_DAYS loses its conversation; a younger one is kept', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  const old = addJob(t.jobs, 1, { ago: 2, conv: 'old' });
  const young = addJob(t.jobs, 2, { ago: 0.5, conv: 'young' });
  assert.equal(await t.dispatcher.deleteOld(clock), true);
  assert.deepEqual(t.deletes, ['old']);
  assert.equal(old.conversation_deleted, true);
  assert.equal(young.conversation_deleted, undefined);
  assert.equal(old.conversation_id, 'old', 'the ledger keeps the conversation id');
  assert.equal(old.status, 'done');
});

test('a run that is not archived yet is not deleted, even when it is old', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  addJob(t.jobs, 1, { ago: 5, archived: false });
  await t.dispatcher.deleteOld(clock);
  assert.deepEqual(t.deletes, []);
});

test('DELETE_FAILED_AFTER_DAYS keeps failed runs longer', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1', DELETE_FAILED_AFTER_DAYS: '5' });
  const failedYoung = addJob(t.jobs, 1, { status: 'failed', ago: 2, conv: 'f-young' });
  const failedOld = addJob(t.jobs, 2, { status: 'failed', ago: 6, conv: 'f-old' });
  const doneOld = addJob(t.jobs, 3, { status: 'done', ago: 2, conv: 'd-old' });
  await t.dispatcher.deleteOld(clock);
  assert.deepEqual(t.deletes.sort(), ['d-old', 'f-old']);
  assert.equal(failedYoung.conversation_deleted, undefined);
  assert.equal(failedOld.conversation_deleted, true);
  assert.equal(doneOld.conversation_deleted, true);
});

test('a 404 counts as deleted: the conversation is gone already', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' }, () => 404);
  const job = addJob(t.jobs, 1, { ago: 2, conv: 'gone' });
  assert.equal(await t.dispatcher.deleteOld(clock), true);
  assert.equal(job.conversation_deleted, true);
});

test('never deleted while another job of the same conversation is still going or not yet finished with it', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  const finishedOld = addJob(t.jobs, 1, { ago: 2, conv: 'shared' });
  addJob(t.jobs, 1, { status: 'running', conv: 'shared', archived: false, label: 'ai:ready' });
  const continued = addJob(t.jobs, 2, { ago: 2, conv: 'continued' });
  addJob(t.jobs, 2, { ago: 0.1, conv: 'continued', archived: false, label: 'ai:changes' });
  await t.dispatcher.deleteOld(clock);
  assert.deepEqual(t.deletes, []);
  assert.equal(finishedOld.conversation_deleted, undefined);
  assert.equal(continued.conversation_deleted, undefined);
});

test('never deleted for a job that is active, queued or waiting', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  addJob(t.jobs, 1, { status: 'running', conv: 'live', archived: true, ago: 5 });
  addJob(t.jobs, 2, { status: 'queued', conv: 'queued', archived: true, ago: 5 });
  addJob(t.jobs, 3, { status: 'waiting', conv: 'waiting', archived: true, ago: 5 });
  await t.dispatcher.deleteOld(clock);
  assert.deepEqual(t.deletes, []);
});

test('never deleted while an open ticket has a nudge or a resume pending; a closed ticket is deleted anyway', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  const open = addJob(t.jobs, 1, { ago: 2, conv: 'open-1' });
  addJob(t.jobs, 1, { ago: 3, conv: 'open-0', extra: { nudge_pending: { marker: 'm', tries: 1, used: 1, max: 2 } } });
  const closedJob = addJob(t.jobs, 2, { ago: 2, conv: 'closed-2', extra: { resume_pending: true } });
  addJob(t.jobs, 2, { ago: 9, conv: 'closed-x', archived: false, label: 'ai:changes', extra: { archived_view: true } });
  await t.dispatcher.deleteOld(clock);
  assert.ok(!t.deletes.includes('open-1'), 'open ticket with a nudge pending keeps its conversations');
  assert.equal(open.conversation_deleted, undefined);
  assert.equal(closedJob.conversation_deleted, true, 'a closed ticket is not protected by its pending flag');
});

test('at most 40 deletions per pass; the rest follow on the next pass', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  for (let n = 1; n <= 45; n++) addJob(t.jobs, n, { ago: 3, conv: 'many-' + n });
  await t.dispatcher.deleteOld(clock);
  assert.equal(t.deletes.length, 40);
  assert.equal(await t.dispatcher.deleteOld(clock + HOUR), true);
  assert.equal(t.deletes.length, 45);
  assert.equal(new Set(t.deletes).size, 45);
});

test('the pass runs once an hour, like the archiving', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  addJob(t.jobs, 1, { ago: 3, conv: 'hour-1' });
  await t.dispatcher.deleteOld(clock);
  addJob(t.jobs, 2, { ago: 3, conv: 'hour-2' });
  assert.equal(await t.dispatcher.deleteOld(clock + 1000), false);
  assert.deepEqual(t.deletes, ['hour-1']);
});

test('a dry run deletes nothing and marks nothing', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1', DRY_RUN: '1' });
  const job = addJob(t.jobs, 1, { ago: 3, conv: 'dry-1' });
  assert.equal(await t.dispatcher.deleteOld(clock), false);
  assert.deepEqual(t.deletes, []);
  assert.equal(job.conversation_deleted, undefined);
});

test('a failing delete is logged and tried again on the next pass', async () => {
  const errors = [];
  let fail = true;
  const t = await build({ DELETE_AFTER_DAYS: '1' }, () => (fail ? 500 : 200));
  t.dispatcher.logger = { error: (...args) => errors.push(args.join(' ')) };
  const job = addJob(t.jobs, 1, { ago: 3, conv: 'retry-1' });
  assert.equal(await t.dispatcher.deleteOld(clock), false);
  assert.equal(job.conversation_deleted, undefined);
  assert.ok(errors.some((line) => /could not delete the conversation of owner\/hello#1:ai:ready, trying again on the next pass/.test(line)));
  fail = false;
  assert.equal(await t.dispatcher.deleteOld(clock + HOUR), true);
  assert.equal(job.conversation_deleted, true);
  assert.equal(t.deletes.length, 2);
});

test('the status page shows no conversation link for a deleted conversation, and the job keeps its numbers', async () => {
  const t = await build({ DELETE_AFTER_DAYS: '1' });
  const gone = addJob(t.jobs, 1, { ago: 3, conv: 'status-gone', extra: { result: 'finished', cost: 0.42, tokens_seen: { prompt: 10 } } });
  addJob(t.jobs, 2, { ago: 0.2, conv: 'status-kept' });
  await t.dispatcher.deleteOld(clock);
  const status = buildStatus(t.config, t.jobs, clock);
  const runs = status.issues.flatMap((issue) => issue.runs);
  assert.equal(runs.find((run) => run.conversation === null && run.label === 'ai:ready' && run.cost === 0.42).conversation, null);
  assert.ok(runs.some((run) => run.conversation === 'status-kept'));
  assert.equal(gone.result, 'finished');
  assert.equal(gone.cost, 0.42);
});

test('settings: validated, and DELETE_FAILED_AFTER_DAYS defaults to DELETE_AFTER_DAYS', () => {
  assert.throws(() => loadConfig(env({ DELETE_AFTER_DAYS: '-1' })), /DELETE_AFTER_DAYS must be an integer between 0 and 3650/);
  assert.throws(() => loadConfig(env({ DELETE_AFTER_DAYS: '3651' })), /DELETE_AFTER_DAYS must be an integer between 0 and 3650/);
  assert.throws(() => loadConfig(env({ DELETE_FAILED_AFTER_DAYS: 'x' })), /DELETE_FAILED_AFTER_DAYS must be an integer/);
  assert.throws(() => loadConfig(env({ DELETE_AFTER_DAYS: '10', DELETE_FAILED_AFTER_DAYS: '3' })), /DELETE_FAILED_AFTER_DAYS must not be lower than DELETE_AFTER_DAYS/);
  const off = loadConfig(env());
  assert.equal(off.deleteAfterDays, 0);
  assert.equal(off.deleteFailedAfterDays, 0);
  assert.equal(loadConfig(env({ DELETE_AFTER_DAYS: '10' })).deleteFailedAfterDays, 10);
  assert.equal(loadConfig(env({ DELETE_AFTER_DAYS: '10', DELETE_FAILED_AFTER_DAYS: '30' })).deleteFailedAfterDays, 30);
});
