// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// escalate_to and fallback_to: escalated rounds and quota fallbacks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { buildStatus } from '../src/server/status.ts';
import { ctx, WORKER, ESCALATE, quiet, env, fakeApi, build, event, starts, CHANGES, withChanges, prEvent, issue, rateLimitError, escalating, runRounds, FREE, falling } from './helpers/direct.ts';

test('escalate_to has to name another configured route, on a round route', () => {
  assert.equal(loadConfig(env(escalating())).routes.get('ai:changes').escalateTo, 'ai:escalate');
  assert.equal(loadConfig(env(withChanges())).routes.get('ai:changes').escalateTo, null);
  assert.throws(() => loadConfig(env(escalating({}, { escalate_to: 'ai:nope' }))), /escalate_to/);
  assert.throws(() => loadConfig(env(escalating({}, { escalate_to: 'ai:changes' }))), /escalate_to/);
  assert.equal(loadConfig(env(withChanges({ LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, escalate_to: 'ai:escalate' }, 'ai:escalate': { profile: ESCALATE } }) }))).routes.get('ai:ready').escalateTo, 'ai:escalate', 'an issue route may escalate');
  assert.throws(() => loadConfig(env(withChanges({ LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, on: 'main_red', escalate_to: 'ai:escalate' }, 'ai:escalate': { profile: ESCALATE } }) }))), /round/);
  assert.equal(loadConfig(env(escalating())).escalateFromRound, 3);
  assert.equal(loadConfig(env(escalating({ ESCALATE_FROM_ROUND: '2' }))).escalateFromRound, 2);
  assert.throws(() => loadConfig(env(escalating({ ESCALATE_FROM_ROUND: '4' }))), /ESCALATE_FROM_ROUND/);
});

test('only the last round starts with the profile and tier of the escalation target', async () => {
  const { jobs, dispatcher } = await runRounds({}, 3);
  assert.deepEqual(starts().map((c) => c.body.agent_profile_id), [CHANGES, CHANGES, ESCALATE]);
  assert.equal(starts()[2].body.max_iterations, 90, 'the limits of the own route stay');
  assert.deepEqual(jobs.list().map((job) => job.escalated), [undefined, undefined, true]);
  assert.equal(dispatcher.rounds(prEvent()), 3, 'it counts as a round');
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'rounds_exceeded');
});

test('ESCALATE_FROM_ROUND escalates earlier', async () => {
  await runRounds({ ESCALATE_FROM_ROUND: '2' }, 3);
  assert.deepEqual(starts().map((c) => c.body.agent_profile_id), [CHANGES, ESCALATE, ESCALATE]);
});

test('without escalate_to nothing changes', async () => {
  await runRounds({}, 3, { escalate_to: undefined });
  assert.deepEqual(starts().map((c) => c.body.agent_profile_id), [CHANGES, CHANGES, CHANGES]);
});

test('the escalated round waits for room in the tier of the target', async () => {
  const { jobs, dispatcher } = await build(escalating({ MAX_CONCURRENT_PER_TIER: '1', MAX_ROUNDS: '1' }, { escalate_to: 'ai:escalate' }));
  await dispatcher.enqueue(event('ai:escalate', 7)); // an issue worker in the strong tier
  await dispatcher.tick();
  assert.equal(jobs.list()[0].status, 'running');
  await dispatcher.enqueue(prEvent());
  await dispatcher.tick();
  assert.equal(jobs.list()[1].status, 'queued', 'the strong tier is full, although the own tier (free) is not');
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  await dispatcher.tick();
  assert.equal(jobs.list()[1].status, 'running');
  assert.equal(starts().at(-1).body.agent_profile_id, ESCALATE);
});

test('a round reset by the human resets the escalation', async () => {
  const { jobs, dispatcher } = await runRounds({ HUMAN_LOGIN: 'marcel' }, 3);
  assert.equal((await dispatcher.enqueue(prEvent([], { sender: { login: 'openhands' } }))).status, 'rounds_exceeded');
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  await dispatcher.tick();
  assert.equal(starts().at(-1).body.agent_profile_id, CHANGES, 'a fresh budget starts with the own profile');
  assert.equal(jobs.list().at(-1).escalated, undefined);
});

test('/status says that a round was escalated', async () => {
  const { config, jobs, dispatcher } = await build(escalating({ MAX_ROUNDS: '1' }));
  await dispatcher.enqueue(prEvent());
  await dispatcher.tick();
  const status = buildStatus(config, jobs, ctx.clock);
  assert.equal(status.issues[0].runs[0].escalated, 'ai:escalate');
  assert.match(status.issues[0].state, /escalated to ai:escalate/);
});

test('fallback_to has to name another configured route that has no fallback of its own', () => {
  assert.equal(loadConfig(env(falling())).routes.get('ai:ready').fallbackTo, 'ai:ready-free');
  assert.equal(loadConfig(env(falling())).routes.get('ai:escalate').fallbackTo, null);
  assert.throws(() => loadConfig(env(falling({}, { fallback_to: 'ai:nope' }))), /fallback_to/);
  assert.throws(() => loadConfig(env(falling({}, { fallback_to: 'ai:ready' }))), /fallback_to/);
  assert.throws(() => loadConfig(env(falling({}, {}, { fallback_to: 'ai:escalate' }))), /fallback_to/);
});

test('a job whose tier is on hold starts with the profile and tier of the fallback route', async () => {
  const { jobs, dispatcher } = await build(falling());
  dispatcher.cooldowns.set('cheap', ctx.clock + 60000);
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  const job = jobs.list()[0];
  assert.equal(job.status, 'running');
  assert.equal(starts()[0].body.agent_profile_id, FREE);
  assert.equal(starts()[0].body.max_iterations, 70, 'the limits of the own route stay');
  assert.equal(job.fell_back, 'ai:ready-free');
  assert.equal(dispatcher.tierOf(job), 'free');
  const status = buildStatus(dispatcher.config, jobs, ctx.clock);
  assert.equal(status.issues[0].runs[0].fell_back, 'ai:ready-free');
  assert.match(status.issues[0].state, /fallback to ai:ready-free/);
});

test('without a hold the job starts normally; without fallback_to it waits; with the fallback tier on hold too it waits', async () => {
  let { jobs, dispatcher } = await build(falling());
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  assert.equal(starts().at(-1).body.agent_profile_id, WORKER);
  assert.equal(jobs.list()[0].fell_back, undefined);
  assert.equal(dispatcher.tierOf(jobs.list()[0]), 'cheap');

  ctx.calls = [];
  ({ jobs, dispatcher } = await build(falling({}, { fallback_to: undefined })));
  dispatcher.cooldowns.set('cheap', ctx.clock + 60000);
  await dispatcher.enqueue(event('ai:ready', 2));
  await dispatcher.tick();
  assert.equal(jobs.list().at(-1).status, 'queued');
  assert.equal(starts().length, 0);

  ({ jobs, dispatcher } = await build(falling()));
  dispatcher.cooldowns.set('cheap', ctx.clock + 60000);
  dispatcher.cooldowns.set('free', ctx.clock + 60000);
  await dispatcher.enqueue(event('ai:ready', 3));
  await dispatcher.tick();
  assert.equal(jobs.list().at(-1).status, 'queued');
  assert.equal(starts().length, 0);
});

test('the running fallback job counts in the tier of the fallback route', async () => {
  const { jobs, dispatcher } = await build(falling());
  dispatcher.cooldowns.set('cheap', ctx.clock + 60000);
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  assert.equal(jobs.list()[0].fell_back, 'ai:ready-free');
  await dispatcher.enqueue(event('ai:ready', 2));
  await dispatcher.tick();
  assert.equal(jobs.list()[1].status, 'queued', 'the free tier is full (limit 1)');
  assert.equal(starts().length, 1);
});

test('a quota error of a fallback run holds the fallback tier and the job decides afresh', async () => {
  const config = loadConfig(env(falling({ MAX_CONCURRENT_PER_TIER: '2' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => new URL(url).pathname.endsWith('/events/search') ? { ok: true, status: 200, json: async () => ({ items: [rateLimitError(600)] }) } : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  dispatcher.cooldowns.set('cheap', ctx.clock + 60000);
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  const job = jobs.list()[0];
  assert.equal(job.fell_back, 'ai:ready-free');
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.equal(job.status, 'queued');
  assert.equal(job.fell_back, undefined);
  assert.ok(dispatcher.cooldowns.get('free') > ctx.clock, 'the fallback tier is held');
  assert.equal(dispatcher.cooldowns.get('cheap'), ctx.clock + 60000, 'the original tier is not');
  ctx.clock += 61000; // cheap is back, free still on hold
  await dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.fell_back, undefined);
  assert.equal(starts().at(-1).body.agent_profile_id, WORKER);
});

test('the run that hits the quota of its own tier starts again at once on the fallback, not after the hold', async () => {
  const config = loadConfig(env(falling({ MAX_CONCURRENT_PER_TIER: '2' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => new URL(url).pathname.endsWith('/events/search') ? { ok: true, status: 200, json: async () => ({ items: [rateLimitError(18000)] }) } : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  await dispatcher.enqueue(event('ai:ready', 1));
  await dispatcher.tick();
  const job = jobs.list()[0];
  assert.equal(job.fell_back, undefined, 'first run on its own tier');
  ctx.states[job.conversation_id] = 'error';
  await dispatcher.tick();
  assert.ok(dispatcher.cooldowns.get('cheap') > ctx.clock + 17000000, 'its tier is held for the five hours the gateway gave');
  assert.equal(job.status, 'running', 'and the same pass started it again');
  assert.equal(job.fell_back, 'ai:ready-free');
  assert.notEqual(starts().at(-1).body.agent_profile_id, WORKER, 'with the fallback profile');
});

test('an escalated round whose escalation tier is on hold and has no fallback waits; with a fallback it falls back from the target', async () => {
  const routes = (target = {}) => ({ MAX_ROUNDS: '1', LABEL_ROUTES: JSON.stringify({
    'ai:ready': { profile: WORKER, tier: 'free' },
    'ai:changes': { profile: CHANGES, tier: 'free', max_iterations: 90, on: 'pull_request', escalate_to: 'ai:escalate' },
    'ai:escalate': { profile: ESCALATE, tier: 'strong', ...target },
    'ai:escalate-free': { profile: FREE, tier: 'cheap' } }) });
  let { jobs, dispatcher } = await build(routes());
  dispatcher.cooldowns.set('strong', ctx.clock + 60000);
  await dispatcher.enqueue(prEvent());
  await dispatcher.tick();
  assert.equal(jobs.list()[0].status, 'queued');
  assert.equal(starts().length, 0, 'the own tier (free) is not on hold, but the escalation target is');

  ({ jobs, dispatcher } = await build(routes({ fallback_to: 'ai:escalate-free' })));
  dispatcher.cooldowns.set('strong', ctx.clock + 60000);
  await dispatcher.enqueue(prEvent());
  await dispatcher.tick();
  assert.equal(jobs.list()[0].status, 'running');
  assert.equal(jobs.list()[0].escalated, true);
  assert.equal(jobs.list()[0].fell_back, 'ai:escalate-free');
  assert.equal(starts()[0].body.agent_profile_id, FREE);
});
