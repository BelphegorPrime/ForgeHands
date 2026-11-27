// @ts-nocheck -- fixtures and fakes are deliberately loose; typing is a follow-up (src/ is checked strictly).
// A clone failure reported back in a comment: the breaker records it once, the job waits for a later attempt instead of being escalated or
// reported, and anything short of a fresh attributable comment keeps the old delivery flow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { CLONE_RETRY_DELAY_MS, CLONE_RETRY_LIMIT } from '../src/agent/clone-handback.ts';
import { loadConfig } from '../src/config.ts';
import { ctx, quiet, env, fakeApi, fakeForgejo, event, buildDelivery, API } from './helpers/direct.ts';

const MARKER = 'DISTINCTIVE-CLONE-TEXT-47';
const CLONE = 'git clone https://forge.example/owner/hello.git failed: fatal: transport error ' + MARKER;
const comment = (body = CLONE, login = 'openhands', at = ctx.clock) => ({ user: { login }, created_at: new Date(at).toISOString(), body });
const failures = (jobs) => jobs.meta.clone_breaker?.failures ?? [];

// Two tickets that share one parent, started together: the parent comment is where a run that cannot clone may report it.
async function buildTickets({ tickets = [26], comments = {}, blocks = {}, user = { login: 'openhands' }, pulls = [], extra = {}, logger = quiet } = {}) {
  const config = loadConfig(env({ HUMAN_LOGIN: 'marcel', ...extra }));
  const jobs = new JobStore(join(ctx.dir, 'clone-delivery-' + (ctx.deliveryRuns++) + '.json'));
  await jobs.load();
  const routes = { ['GET /api/v1/user']: user, ['GET ' + API + '/pulls']: () => pulls };
  for (const number of new Set([...Object.keys(comments), ...Object.keys(blocks), ...tickets])) {
    routes['GET ' + API + '/issues/' + number + '/comments'] = () => comments[number] ?? [];
    routes['POST ' + API + '/issues/' + number + '/comments'] = {};
  }
  for (const number of tickets) routes['GET ' + API + '/issues/' + number + '/blocks'] = () => blocks[number] ?? [];
  const forgejo = fakeForgejo(routes);
  const api = fakeApi();
  const send = (url, request) => String(url).startsWith('https://forge.example/') ? forgejo.send(url, request) : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, logger, () => ctx.clock);
  for (const number of tickets) await dispatcher.enqueue(event('ai:ready', number));
  await dispatcher.tick();
  const endAll = async () => {
    ctx.clock += 5 * 60000;
    for (const job of jobs.list('running')) ctx.states[job.conversation_id] = 'finished';
    await dispatcher.tick();
  };
  return { jobs, dispatcher, forgejo, endAll };
}

test('a fresh clone handback by the agent is reported once and queues the job without escalation', async () => {
  const logs = [];
  const logger = { error: (...parts) => logs.push(parts.join(' ')) };
  const comments = [];
  const t = await buildDelivery({ comments, logger });
  const started = ctx.clock;
  const conversation = t.job.conversation_id;
  const attempts = t.job.attempts;
  comments.push(comment(CLONE, 'openhands', started));
  await t.end();
  const record = failures(t.jobs);
  assert.equal(record.length, 1);
  assert.equal(record[0].conversation, conversation);
  assert.equal(record[0].class, 'clone_failed');
  assert.equal(t.job.status, 'queued');
  assert.equal(t.job.clone_retries, 1);
  assert.equal(t.job.next_try, ctx.clock + CLONE_RETRY_DELAY_MS);
  assert.equal(t.job.attempts, attempts);
  assert.equal(t.job.escalated, undefined);
  assert.equal(t.job.failure_escalation, undefined);
  assert.equal(t.job.conversation_id, undefined);
  assert.equal(t.job.started, undefined);
  assert.equal(t.forgejo.calls.some((call) => call.method === 'PATCH' || call.method === 'POST'), false);
  const lines = logs.join('\n');
  assert.equal(lines.includes(MARKER), false);
  assert.equal(lines.includes('owner/hello#26'), true);
  const ledger = await readFile(t.jobs.file, 'utf8');
  assert.equal(ledger.includes(MARKER), false);
});

test('the same text by another author keeps the ordinary delivery flow', async () => {
  const comments = [];
  const t = await buildDelivery({ comments });
  comments.push(comment(CLONE, 'marcel', ctx.clock));
  await t.end();
  assert.equal(failures(t.jobs).length, 0);
  assert.equal(t.job.clone_retries, undefined);
  assert.equal(t.job.status, 'done');
});

test('delivery and clone classification share issue, pull and comment reads', async () => {
  const t = await buildTickets({ blocks: { 26: [{ number: 4 }] }, comments: { 4: [] } });
  const job = t.jobs.list()[0];
  Object.assign(job, { status: 'done', finished: ctx.clock });
  t.forgejo.calls.length = 0;
  await t.dispatcher.deliveryCheck.checkDelivery(job);
  for (const path of ['/issues/26', '/pulls', '/issues/26/comments', '/issues/26/blocks', '/issues/4/comments']) {
    assert.equal(t.forgejo.calls.filter((call) => call.method === 'GET' && call.path === API + path).length, 1, path);
  }
  assert.equal(job.delivery_retry, 1);
});

test('with no known agent login nothing is reported', async () => {
  const comments = [];
  const t = await buildDelivery({ comments, routes: { 'GET /api/v1/user': { login: '' } } });
  comments.push(comment(CLONE, 'openhands', ctx.clock));
  await t.end();
  assert.equal(failures(t.jobs).length, 0);
  assert.equal(t.job.clone_retries, undefined);
  assert.equal(t.job.status, 'done');
});

test('the same text in the issue body is no report', async () => {
  const t = await buildDelivery({ routes: { ['GET ' + API + '/issues/26']: { number: 26, state: 'open', body: CLONE, labels: [] } } });
  await t.end();
  assert.equal(failures(t.jobs).length, 0);
  assert.equal(t.job.clone_retries, undefined);
  assert.equal(t.job.delivery_retry, 1);
});

test('a stale comment is no report', async () => {
  const comments = [];
  const t = await buildDelivery({ comments });
  comments.push(comment(CLONE, 'openhands', ctx.clock - 20 * 60000));
  await t.end();
  assert.equal(failures(t.jobs).length, 0);
  assert.equal(t.job.clone_retries, undefined);
  assert.equal(t.job.delivery_retry, 1);
});

test('a bare 404 of the comments keeps the old behaviour', async () => {
  const t = await buildDelivery({ routes: { ['GET ' + API + '/issues/26/comments']: { __status: 404 } } });
  await t.end();
  assert.equal(failures(t.jobs).length, 0);
  assert.equal(t.job.clone_retries, undefined);
  assert.equal(t.job.status, 'done');
});

test('an unattributed parent comment is ignored even with two concurrent runs', async () => {
  const started = ctx.clock;
  const comments = { 4: [comment(CLONE, 'openhands', started)] };
  const blocks = { 26: [{ number: 4 }], 27: [{ number: 4 }] };
  const t = await buildTickets({ tickets: [26, 27], comments, blocks });
  assert.equal(t.jobs.list('running').length, 2);
  await t.endAll();
  assert.equal(failures(t.jobs).length, 0);
  for (const job of t.jobs.list()) assert.equal(job.clone_retries, undefined);
});

test('a parent comment with owner/repo#n attribution is reported once', async () => {
  const started = ctx.clock;
  const attributed = 'git clone https://forge.example/owner/hello.git failed: fatal: owner/hello#26 could not read from remote repository';
  const blocks = { 26: [{ number: 4 }], 27: [{ number: 4 }] };
  const t = await buildTickets({ tickets: [26, 27], comments: { 4: [comment(attributed, 'openhands', started)] }, blocks });
  const conversations = t.jobs.list('running').map((job) => [job.event.issue.number, job.conversation_id]);
  await t.endAll();
  const record = failures(t.jobs);
  assert.equal(record.length, 1);
  assert.equal(record[0].conversation, conversations.find(([number]) => number === 26)[1]);
  const byNumber = (number) => t.jobs.list().find((job) => job.event.issue.number === number);
  assert.equal(byNumber(26).clone_retries, 1);
  assert.equal(byNumber(27).clone_retries, undefined);
});

test('a replay of the same conversation counts once and retries again', async () => {
  const comments = [];
  const t = await buildDelivery({ comments });
  const started = ctx.clock;
  const conversation = t.job.conversation_id;
  comments.push(comment(CLONE, 'openhands', started));
  await t.end();
  assert.equal(failures(t.jobs).length, 1);
  Object.assign(t.job, { status: 'running', started, conversation_id: conversation, finished: undefined, result: undefined });
  await t.dispatcher.tick();
  assert.equal(failures(t.jobs).length, 1);
  assert.equal(t.job.clone_retries, 2);
  assert.equal(t.job.status, 'queued');
});

test('past CLONE_RETRY_LIMIT the ordinary delivery flow runs', async () => {
  const comments = [];
  const logs = [];
  const t = await buildDelivery({ comments, logger: { error: (...parts) => logs.push(parts.join(' ')) } });
  t.job.clone_retries = CLONE_RETRY_LIMIT;
  comments.push(comment(CLONE, 'openhands', ctx.clock));
  await t.end();
  assert.equal(failures(t.jobs).length, 1);
  assert.equal(t.job.clone_retries, CLONE_RETRY_LIMIT);
  assert.equal(t.job.status, 'done');
  assert.equal(logs.some((line) => line.includes('the job is queued again')), false);
});

test('a confirmed clone handback takes precedence over the default error retry', async () => {
  const comments = [];
  const t = await buildDelivery({ comments, extra: { ERROR_RETRIES: undefined } });
  assert.equal(t.dispatcher.config.errorRetries, 1);
  const started = ctx.clock;
  comments.push(comment(CLONE, 'openhands', started));
  ctx.clock += 5 * 60000;
  ctx.states[t.job.conversation_id] = 'error';
  await t.dispatcher.tick();
  assert.equal(failures(t.jobs).length, 1);
  assert.equal(t.job.status, 'queued');
  assert.equal(t.job.clone_retries, 1);
  assert.equal(t.job.error_retry ?? 0, 0);
  assert.equal(t.job.result, undefined);
  assert.equal(t.comments().some((body) => body.includes('ended with')), false);
});
