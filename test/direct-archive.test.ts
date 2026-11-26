// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Archiving the conversations of runs that ended (ARCHIVE_AFTER_DAYS).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { ctx, env, withChanges, issue, DAY, buildArchive, endedJob } from './helpers/direct.ts';

test('ARCHIVE_AFTER_DAYS: default one week, 0 switches it off, anything odd is refused', () => {
  assert.equal(loadConfig(env(withChanges())).archiveAfterDays, 7);
  assert.equal(loadConfig(env(withChanges({ ARCHIVE_AFTER_DAYS: '0' }))).archiveAfterDays, 0);
  assert.equal(loadConfig(env(withChanges({ ARCHIVE_AFTER_DAYS: '30' }))).archiveAfterDays, 30);
  for (const bad of ['-1', 'x', '1.5', '99999']) assert.throws(() => loadConfig(env(withChanges({ ARCHIVE_AFTER_DAYS: bad }))), /ARCHIVE_AFTER_DAYS/);
});

test('a run that ended more than the period ago is archived and keeps its other tags; a recent one is left alone', async () => {
  ctx.clock = 100 * DAY;
  const { dispatcher, jobs, patches } = await buildArchive({}, { c1: { tags: { source: 'forgehands', issue: '1', pr: '5' } }, c2: { tags: { source: 'forgehands', issue: '2' } }, c3: { tags: { source: 'forgehands', issue: '3' } } });
  const old = jobs.add(endedJob(1, ctx.clock - 8 * DAY));
  const failed = jobs.add(endedJob(3, ctx.clock - 9 * DAY, 'failed'));
  const recent = jobs.add(endedJob(2, ctx.clock - 6 * DAY));
  await dispatcher.tick();
  assert.deepEqual(patches.map((p) => p.id).sort(), ['c1', 'c3']);
  assert.deepEqual(patches.find((p) => p.id === 'c1').body, { tags: { source: 'forgehands', issue: '1', pr: '5', archived: 'true' } });
  assert.equal(old.archived, true);
  assert.equal(failed.archived, true);
  assert.equal(recent.archived, undefined);
});

test('archiving runs at most once an hour, never twice for one run, and not when switched off', async () => {
  ctx.clock = 100 * DAY;
  const { dispatcher, jobs, patches } = await buildArchive({}, { c1: { tags: {} }, c2: { tags: {} } });
  jobs.add(endedJob(1, ctx.clock - 8 * DAY));
  await dispatcher.tick();
  assert.equal(patches.length, 1);
  jobs.add(endedJob(2, ctx.clock - 8 * DAY));
  await dispatcher.tick();
  assert.equal(patches.length, 1);                        // the hour has not passed
  ctx.clock += 3600000 + 1;
  await dispatcher.tick();
  assert.deepEqual(patches.map((p) => p.id), ['c1', 'c2']); // c1 is not archived a second time
  const off = await buildArchive({ ARCHIVE_AFTER_DAYS: '0' }, { c1: { tags: {} } });
  off.jobs.add(endedJob(1, ctx.clock - 80 * DAY));
  await off.dispatcher.tick();
  assert.equal(off.patches.length, 0);
});

test('a deleted or running conversation, a job that is not over and a failing call are handled without harm', async () => {
  ctx.clock = 100 * DAY;
  const { dispatcher, jobs, patches } = await buildArchive({}, { c1: { status: 'running', tags: {} }, c3: { tags: {}, failPatch: true } });
  const running = jobs.add(endedJob(1, ctx.clock - 8 * DAY));
  const deleted = jobs.add(endedJob(2, ctx.clock - 8 * DAY));          // no such conversation: 404
  const failing = jobs.add(endedJob(3, ctx.clock - 8 * DAY));
  const waiting = jobs.add({ ...endedJob(4, ctx.clock - 8 * DAY), status: 'waiting' });
  const noConversation = jobs.add({ ...endedJob(5, ctx.clock - 8 * DAY), conversation_id: undefined });
  await dispatcher.tick();
  assert.equal(patches.length, 0);
  assert.equal(running.archived, undefined);
  assert.equal(deleted.archived, true);                           // nothing left to archive, do not ask again
  assert.equal(failing.archived, undefined);                      // tried again in the next round
  assert.equal(waiting.archived, undefined);
  assert.equal(noConversation.archived, undefined);
});

test('at most twenty runs are archived in one round', async () => {
  ctx.clock = 100 * DAY;
  const conversations = Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['c' + (i + 1), { tags: {} }]));
  const { dispatcher, jobs, patches } = await buildArchive({}, conversations);
  for (let i = 1; i <= 25; i++) jobs.add(endedJob(i, ctx.clock - 8 * DAY));
  await dispatcher.tick();
  assert.equal(patches.length, 20);
  ctx.clock += 3600000 + 1;
  await dispatcher.tick();
  assert.equal(patches.length, 25);
});
