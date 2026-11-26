// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// CI outcomes that are not acted on at once: cancelled, recovered, stale or kept while an agent works.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEvent } from '../src/webhook/events.ts';
import { buildStatus } from '../src/server/status.ts';
import { ctx, repo, event, starts, prEvent, REVIEWER, CI_ROUTES, runPayload, ciEvent, buildCi, buildCiWithHead, issue, pull } from './helpers/direct.ts';

// ---- CI outcomes that must not start anything
test('a cancelled or skipped run is not a failure, a run of another status is not a success', () => {
  for (const status of ['cancelled', 'skipped', 'running', 'waiting']) {
    assert.equal(normalizeEvent('action_run_failure', runPayload(status), new Set([repo]), [], { ci: CI_ROUTES }), null, status);
  }
  assert.equal(normalizeEvent('action_run_success', runPayload('failure'), new Set([repo]), [], { ci: CI_ROUTES }), null);
  assert.notEqual(ciEvent('failure'), null);
  assert.notEqual(ciEvent('success'), null);
});

test('a failed CI run whose commit is pending or green again starts nothing', async () => {
  for (const state of ['pending', 'success']) {
    const { dispatcher, jobs } = await buildCi({ state, total_count: 1 });
    assert.equal((await dispatcher.enqueue(ciEvent('failure'))).status, 'ci_not_red');
    assert.equal(jobs.list().length, 0);
  }
  const red = await buildCi({ state: 'failure', total_count: 1 });
  assert.equal((await red.dispatcher.enqueue(ciEvent('failure'))).status, 'queued');
  // the commit recovers while the job is queued: dropped right before it starts
  const green = await buildCi({ state: 'success', total_count: 1 });
  const event = ciEvent('failure');
  const job = green.jobs.add({ key: 'owner/hello#26:ci:failure:abcdef01', label: 'ci:failure', event, status: 'queued', created: ctx.clock });
  const before = starts().length;
  await green.dispatcher.startJob(job, ctx.clock);
  assert.equal(starts().length, before);
  assert.equal(green.jobs.list().some((entry) => entry.id === job.id), false);
});

test('a CI outcome of a commit that is no longer the head of the pull request starts nothing', async () => {
  const stale = await buildCiWithHead('ffffffff00000000');
  assert.equal((await stale.dispatcher.enqueue(ciEvent('failure'))).status, 'stale_run');
  assert.equal((await stale.dispatcher.enqueue(ciEvent('success'))).status, 'stale_run');
  assert.equal(starts().length, 0);
  const current = await buildCiWithHead('abcdef0123456789', { state: 'failure', total_count: 1 });
  assert.equal((await current.dispatcher.enqueue(ciEvent('failure'))).status, 'queued');
});

test('a CI outcome that arrives while an agent works on the issue is kept and acted on when that run ends', async () => {
  const { dispatcher, jobs } = await buildCiWithHead('abcdef0123456789', { state: 'success', total_count: 1 });
  assert.equal((await dispatcher.enqueue(event('ai:ready', 26))).status, 'queued');
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'deferred');
  assert.equal(starts().length, 1);
  assert.equal(jobs.list().find((job) => job.waiting_for_run).status, 'waiting');
  assert.equal(buildStatus(dispatcher.config, jobs, ctx.clock).issues[0].state, 'worker running');
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(starts().length, 2);
  assert.equal(starts()[1].body.agent_profile_id, REVIEWER);
  assert.equal(jobs.list().filter((job) => job.waiting_for_run).length, 0);
});

test('a kept CI outcome is dropped when its commit is no longer the head or the status is not green, and a later event can come again', async () => {
  for (const [head, status] of [['ffffffff00000000', { state: 'success', total_count: 1 }], ['abcdef0123456789', { state: 'pending', total_count: 2 }]]) {
    const { dispatcher, jobs } = await buildCiWithHead(head, status);
    await dispatcher.enqueue(event('ai:ready', 26));
    await dispatcher.tick();
    assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'deferred');
    ctx.states[jobs.list('running')[0].conversation_id] = 'finished';
    await dispatcher.tick();
    assert.equal(jobs.list().filter((job) => job.label === 'ci:success').length, 0, head);
    assert.equal(jobs.list(true).length, 0, head);
  }
});

test('a kept fix round respects the round limit when it is released', async () => {
  const { dispatcher, jobs } = await buildCiWithHead('abcdef0123456789');
  dispatcher.config.maxRounds = 1;
  jobs.add({ key: 'owner/hello#26:ai:changes', label: 'ai:changes', status: 'done', started: ctx.clock, created: ctx.clock - 1, event: prEvent() });
  await dispatcher.enqueue(event('ai:ready', 26));
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(ciEvent('failure'))).status, 'deferred');
  ctx.states[jobs.list().find((job) => job.label === 'ai:ready').conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(jobs.list().filter((job) => job.label === 'ci:failure').length, 0);
  assert.equal(starts().length, 1);
});

test('a kept CI outcome does not hold the issue for ever', async () => {
  const { dispatcher, jobs } = await buildCiWithHead('abcdef0123456789');
  await dispatcher.enqueue(event('ai:ready', 26));
  await dispatcher.tick();
  await dispatcher.enqueue(ciEvent('failure'));
  ctx.clock += dispatcher.config.maxRunMs + 1000;
  await dispatcher.tick(); // the worker run times out, the kept outcome is looked at once
  assert.ok(jobs.list().every((job) => job.status !== 'waiting' || !job.waiting_for_run));
});
