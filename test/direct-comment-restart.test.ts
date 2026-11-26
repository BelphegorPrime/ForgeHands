// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// A comment of HUMAN_LOGIN restarts the failed run of its issue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../src/store/jobs.ts';
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { ctx, PLANNER, WORKER, ESCALATE, repo, env, event, starts, webhook, issue, pull, ticket, buildComments, postComment, endLast } from './helpers/direct.ts';

test('a comment of HUMAN_LOGIN restarts the failed run of its label, as a new label would, and the run reads the comment', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  assert.equal((await endLast(t)).status, 'failed');
  assert.equal(await postComment(t, { id: 501 }), 'queued');
  await t.dispatcher.tick();
  const again = starts().at(-1);
  assert.equal(starts().length, 2);
  assert.equal(again.body.agent_profile_id, WORKER);
  const restarted = t.jobs.list().at(-1);
  assert.equal(restarted.label, 'ai:ready');
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.event.comment.id, '501');
  assert.equal(restarted.event.comment.login, 'marcel');
  assert.match(again.body.initial_message.content[0].text, /This run starts again because marcel commented on the issue \(comment 501\)/);
  assert.match(buildPrompt(restarted.event, t.config), /This run starts again because marcel commented on the issue \(comment 501\)/);
  assert.equal(t.jobs.noted('comment:owner/hello#26#501'), true);
});

test('the same comment delivered twice, or again under a new delivery id, starts nothing the second time', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 502, delivery: 'same' }), 'queued');
  assert.notEqual(await postComment(t, { id: 502, delivery: 'same' }), 'queued', 'the same delivery again is not a second restart');
  await t.dispatcher.tick();
  assert.equal(await postComment(t, { id: 502, delivery: 'other' }), 'duplicate_comment', 'under a new delivery id the ledger keeps the comment id');
  assert.equal(starts().length, 2);
});

test('the restart decision is kept in the ledger across a restart of ForgeHands', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  await postComment(t, { id: 503 });
  const reloaded = new JobStore(t.jobs.file);
  await reloaded.load();
  assert.equal(reloaded.noted('comment:owner/hello#26#503'), true);
  assert.equal(reloaded.list().length, t.jobs.list().length);
});

test('comments of other users, of agents and of ForgeHands itself start nothing; HUMAN_LOGIN is compared case-insensitively', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { login: 'alice', id: 601 }), 'ignored');
  assert.equal(await postComment(t, { login: 'openhands', id: 602 }), 'ignored');
  assert.equal(await postComment(t, { login: 'forgehands', id: 603 }), 'ignored');
  assert.equal(await postComment(t, { login: 'MARCEL', id: 604 }), 'queued', 'the login is case-insensitive');
  assert.equal(starts().length, 2);
});

test('without HUMAN_LOGIN the feature is off: the comment of anybody starts nothing', async () => {
  const t = await buildComments({ HUMAN_LOGIN: undefined });
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 701 }), 'ignored');
  assert.equal(starts().length, 1);
});

test('COMMENT_RESTARTS=0 switches the feature off', async () => {
  const t = await buildComments({ COMMENT_RESTARTS: '0' });
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  // The webhook hands the comment on (PLAN_ANSWER_RESTARTS may need it), and the dispatcher starts nothing.
  assert.equal(await postComment(t, { id: 711 }), 'comment_restarts_off');
  assert.equal(starts().length, 1);
  assert.throws(() => loadConfig(env({ HUMAN_LOGIN: 'marcel', COMMENT_RESTARTS: '-1' })), /COMMENT_RESTARTS must be an integer between 0 and 100/);
});

test('ALLOWED_SENDERS applies to the comment author: a comment of the operator who is not listed starts nothing', async () => {
  const t = await buildComments({ ALLOWED_SENDERS: 'someone-else' });
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 721 }), 'ignored');
  assert.equal(starts().length, 1);
});

test('an issue without a failed run starts nothing: never ran, running, queued, done', async () => {
  const t = await buildComments();
  assert.equal(await postComment(t, { id: 801 }), 'no_failed_run', 'never ran');
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await t.dispatcher.tick();
  assert.equal(await postComment(t, { id: 802 }), 'run_active', 'running');
  ctx.states[t.jobs.list().at(-1).conversation_id] = 'finished';
  await t.dispatcher.tick();
  assert.equal(t.jobs.list().at(-1).status, 'done');
  assert.equal(await postComment(t, { id: 803 }), 'no_failed_run', 'done');
  t.dispatcher.cooldowns.set('strong', ctx.clock + 3600000); // the planner's tier is out of quota: its run stays queued
  await t.dispatcher.enqueue(event('ai:plan', 26));
  assert.equal(await postComment(t, { id: 804 }), 'run_active', 'queued (the planner, the latest run)');
  assert.equal(starts().length, 1, 'nothing started by the comments');
});

test('a label removed from the issue starts nothing, and a closed issue starts nothing', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  t.issue.labels = [];
  assert.equal(await postComment(t, { id: 901 }), 'label_gone');
  t.issue.labels = ['ai:ready'];
  t.issue.state = 'closed';
  assert.equal(await postComment(t, { id: 902 }), 'not_open');
  assert.equal(starts().length, 1);
});

test('a comment on a pull request, and an edited or deleted comment, start nothing', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 911, pull: true }), 'ignored', 'a comment on a pull request is not handled here');
  assert.equal(await postComment(t, { id: 912, action: 'edited' }), 'ignored');
  assert.equal(await postComment(t, { id: 913, action: 'deleted' }), 'ignored');
  assert.equal(starts().length, 1);
});

test('a comment for a repository that is not allowed is ignored', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 921, repo: 'owner/other' }), 'ignored');
  assert.equal(starts().length, 1);
});

test('COMMENT_RESTARTS per issue and label: the limit is one notice on the issue, then nothing more', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  assert.equal(await postComment(t, { id: 1001 }), 'queued');
  await endLast(t);
  assert.equal(await postComment(t, { id: 1002 }), 'queued', 'the second of the two allowed restarts');
  await endLast(t);
  assert.equal(await postComment(t, { id: 1003 }), 'restarts_used_up');
  assert.equal(t.notices(), 1, 'one notice on the issue');
  assert.equal(await postComment(t, { id: 1004 }), 'restarts_used_up');
  assert.equal(t.notices(), 1, 'no second notice');
  assert.equal(starts().length, 3, 'the original run and two restarts, nothing more');
});

test('the restarted run goes through the quota fallback of its route like any new run', async () => {
  const t = await buildComments({ LABEL_ROUTES: JSON.stringify({
    'ai:plan': { profile: PLANNER, tier: 'strong' },
    'ai:ready': { profile: WORKER, tier: 'free', fallback_to: 'ai:ready-cheap' },
    'ai:ready-cheap': { profile: ESCALATE, tier: 'cheap' }
  }) });
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  t.dispatcher.cooldowns.set('free', ctx.clock + 3600000);
  assert.equal(await postComment(t, { id: 1101 }), 'queued');
  await t.dispatcher.tick();
  const again = starts().at(-1);
  assert.equal(again.body.agent_profile_id, ESCALATE, 'started with the fallback route while the tier is out of quota');
  assert.equal(t.jobs.list().at(-1).fell_back, 'ai:ready-cheap');
});

test('a restarted run waits for open dependencies like a new label does', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  await endLast(t);
  t.issue.dependencies = [{ number: 12, state: 'open' }];
  assert.equal(await postComment(t, { id: 1201 }), 'waiting');
  assert.equal(t.jobs.list().at(-1).status, 'waiting');
  assert.equal(starts().length, 1);
});

test('a failed planner run (ai:plan) is restarted by a comment the same way', async () => {
  const t = await buildComments();
  t.issue.labels = ['ai:plan'];
  await t.dispatcher.enqueue(event('ai:plan', 26));
  assert.equal((await endLast(t)).status, 'failed');
  assert.equal(await postComment(t, { id: 1301 }), 'queued');
  await t.dispatcher.tick();
  assert.equal(starts().at(-1).body.agent_profile_id, PLANNER);
  assert.equal(t.jobs.list().at(-1).label, 'ai:plan');
});

test('a run that was handed to the human (blocked mark on its ticket) is restarted by a comment too', async () => {
  const t = await buildComments();
  await t.dispatcher.enqueue(event('ai:ready', 26));
  const job = await endLast(t, 'finished');
  assert.equal(job.status, 'done');
  t.jobs.noteTicket('owner/hello#26', { blocked_at: ctx.clock });
  assert.equal(await postComment(t, { id: 1401 }), 'queued');
});
