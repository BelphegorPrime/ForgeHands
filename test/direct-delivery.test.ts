// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// A worker run that ends without delivering: run once more, escalation, comments on the parent, failed rounds and SPLIT_LABEL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { ctx, WORKER, ESCALATE, quiet, env, fakeApi, event, starts, withChanges, prEvent, buildWatched, buildDelivery, DELIVERY_ROUTES, FALLBACK_FREE, FALLBACK_ROUTES, API, issue, verdict, pull, ticket } from './helpers/direct.ts';

test('a worker run that finishes without a pull request or a comment is run once more, then a human is called', async () => {
  const t = await buildDelivery();
  await t.end();
  assert.equal(t.job.delivery_retry, 1);
  assert.equal(t.job.status, 'running', 'queued again and started in the same pass');
  await t.end();
  assert.equal(t.job.status, 'failed');
  assert.equal(t.job.result, 'no_delivery');
  assert.match(t.comments()[0], /^@marcel ForgeHands: the run for ai:ready finished twice without a pull request and without a comment, so nothing was delivered\./);
});

test('an issue run that finishes twice without a delivery starts once more on the escalate_to profile, and the human is called only if that run is empty too', async () => {
  const t = await buildDelivery({ extra: { LABEL_ROUTES: DELIVERY_ROUTES } });
  await t.end();
  assert.equal(t.job.escalated, undefined, 'the first empty run is only run once more, on the same profile');
  assert.equal(starts().at(-1).body.agent_profile_id, WORKER);
  await t.end();
  assert.equal(t.job.escalated, true, 'the second empty run escalates');
  assert.equal(t.job.escalated_after, 'no_delivery');
  assert.equal(t.job.failure_escalation, true);
  assert.equal(t.job.status, 'running', 'a fresh run, started in the same pass');
  assert.equal(t.job.result, undefined);
  assert.equal(t.dispatcher.tierOf(t.job), 'strong', 'the escalated run counts for the tier it runs on');
  assert.equal(starts().length, 3);
  assert.equal(starts().at(-1).body.agent_profile_id, ESCALATE);
  assert.deepEqual(t.comments(), [], 'no notice to the human yet');
  await t.end();
  assert.equal(t.job.status, 'failed');
  assert.equal(t.job.result, 'no_delivery');
  assert.equal(starts().length, 3, 'no third run');
  assert.match(t.comments()[0], /^@marcel ForgeHands: the run for ai:ready finished twice without a pull request and without a comment, and once more after ai:escalate, so nothing was delivered\./);
});

test('a job that fell back to the free route still escalates after two empty runs, and the human is called after the escalated run too', async () => {
  const t = await buildDelivery({ hold: 'cheap', extra: { LABEL_ROUTES: FALLBACK_ROUTES } });
  assert.equal(t.job.fell_back, 'ai:ready-free');
  assert.equal(t.job.label, 'ai:ready', 'the ticket was started with ai:ready, the fallback does not change its label');
  await t.end();
  assert.equal(t.job.delivery_retry, 1);
  assert.equal(starts().at(-1).body.agent_profile_id, FALLBACK_FREE, 'once more on the fallback');
  await t.end();
  assert.equal(t.job.escalated, true, 'the second empty run escalates although it ran on the fallback');
  assert.equal(t.job.escalated_after, 'no_delivery');
  assert.equal(t.job.status, 'running');
  assert.equal(starts().at(-1).body.agent_profile_id, ESCALATE, 'the escalated run uses the profile of ai:escalate');
  assert.equal(t.dispatcher.tierOf(t.job), 'strong');
  assert.deepEqual(t.comments(), [], 'no notice yet');
  await t.end();
  assert.equal(t.job.status, 'failed');
  assert.equal(t.job.result, 'no_delivery');
  assert.equal(starts().length, 3, 'no fourth run');
  assert.match(t.comments()[0], /^@marcel ForgeHands: the run for ai:ready finished twice without a pull request and without a comment, and once more after ai:escalate, so nothing was delivered\./);
});

// A worker that hands its ticket back by a blocker comment escalates at once (handback.ts); when that escalated run is empty too the human is
// called at once, and the notice says that the escalation happened (and that a comment had been written before it).
test('a blocker comment escalates the run, and an empty escalated run calls the human with the escalation named', async () => {
  const blocker = [];
  const t = await buildDelivery({ comments: blocker, extra: { LABEL_ROUTES: DELIVERY_ROUTES } });
  blocker.push({ id: 1, body: 'I am blocked: the API key is missing.', created_at: new Date(ctx.clock).toISOString() });
  await t.end();
  assert.equal(t.job.escalated, true);
  assert.equal(t.job.escalated_after, 'handback');
  assert.equal(starts().at(-1).body.agent_profile_id, ESCALATE);
  await t.end();
  assert.equal(t.job.status, 'failed');
  assert.equal(t.job.result, 'no_delivery');
  assert.equal(starts().length, 2, 'no third run');
  assert.match(t.comments()[0], /^@marcel ForgeHands: the run for ai:ready was handed back by a comment, and the run after it on ai:escalate finished without a pull request and without a comment, so nothing was delivered\./);
});

test('a pull request opened by the escalated run is its delivery', async () => {
  const pulls = [];
  const t = await buildDelivery({ pulls, extra: { LABEL_ROUTES: DELIVERY_ROUTES } });
  await t.end();
  await t.end();
  assert.equal(t.job.escalated, true);
  pulls.push({ number: 5, head: { ref: 'ai/issue-26' }, updated_at: new Date(ctx.clock + 60000).toISOString(), state: 'open', merged: false });
  await t.end();
  assert.equal(t.job.status, 'done');
  assert.equal(t.job.result, 'finished');
  assert.deepEqual(t.comments(), []);
});

test('without FAILURE_ESCALATE=0 an issue run with escalate_to that is empty twice goes to the human at once, and so does a route without escalate_to', async () => {
  const off = await buildDelivery({ extra: { LABEL_ROUTES: DELIVERY_ROUTES, FAILURE_ESCALATE: '0' } });
  await off.end();
  await off.end();
  assert.equal(off.job.result, 'no_delivery');
  assert.equal(off.job.escalated, undefined);
  assert.equal(starts().length, 2, 'two runs, both on the own profile');
  assert.equal(starts().every((call) => call.body.agent_profile_id === WORKER), true);
  ctx.calls = [];
  const plain = await buildDelivery();
  await plain.end();
  await plain.end();
  assert.equal(plain.job.result, 'no_delivery');
  assert.equal(plain.job.escalated, undefined, 'no escalate_to, no escalation');
  assert.equal(starts().length, 2);
  assert.equal(starts().every((call) => call.body.agent_profile_id === WORKER), true);
});

test('a pull request or a comment since the run began, a closed issue or an epic is a delivery or needs none', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString(); // (the clock moves on with every case)
  const cases = () => ({
    'a pull request updated since': { pulls: [{ number: 5, head: { ref: 'ai/issue-26' }, updated_at: at(60000), state: 'open', merged: false }] },
    'a comment since': { comments: [{ created_at: at(60000), body: 'done', user: { login: 'openhands' } }] },
    'the issue was closed': { issueState: 'closed' },
    'a planner run (epic label)': { label: 'ai:plan' }
  });
  for (const name of Object.keys(cases())) {
    const t = await buildDelivery(cases()[name]);
    await t.end();
    assert.equal(t.job.status, 'done', name);
    assert.equal(t.job.delivery_retry, undefined, name);
  }
  const earlier = at(-3600000);
  const stale = await buildDelivery({ pulls: [{ number: 5, head: { ref: 'ai/issue-26' }, updated_at: earlier, state: 'open', merged: false }], comments: [{ created_at: earlier, body: 'old', user: { login: 'openhands' } }] });
  await stale.end();
  assert.equal(stale.job.delivery_retry, 1, 'an old pull request and an old comment are not a delivery');
});

// A comment of the agent on the issue this one blocks (its parent) is no delivery while the ticket is open: the ticket has no pull request and is
// still open. It is a hand-back like a comment on the ticket itself (handback.ts): "done, nothing pushed" asks for the push, a blocker escalates.
test('a comment of the agent on the parent while the ticket stays open is a hand-back: the run is asked to push', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString();
  const logs = [];
  const t = await buildDelivery({
    logger: { error: (...args) => logs.push(args.join(' ')) },
    routes: {
      ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }],
      ['GET ' + API + '/issues/31/comments']: [{ created_at: at(60000), body: 'verification', user: { login: 'openhands' } }]
    }
  });
  await t.end();
  assert.notEqual(t.job.status, 'done', 'not delivered');
  assert.equal(t.job.delivered_on, undefined);
  assert.equal(t.job.handback_retry, true, 'a hand-back: the push is asked for');
  assert.equal(t.job.handback_push, true);
  assert.equal(t.job.status, 'running', 'queued again and started in the same pass');
  assert.ok(logs.includes('owner/hello#26: the run commented on #31 and left the ticket open, a hand-back'), logs.join('\n'));
  assert.ok(!t.forgejo.calls.some((call) => call.method !== 'GET' && call.path.includes('/issues/26') && !call.path.endsWith('/comments')), 'the ticket is not closed by ForgeHands');
});

test('a blocker comment of the agent on the parent escalates the run like a blocker on the ticket', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString();
  const t = await buildDelivery({
    extra: { LABEL_ROUTES: DELIVERY_ROUTES },
    routes: {
      ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }],
      ['GET ' + API + '/issues/31/comments']: [{ created_at: at(60000), body: 'I am blocked: the API key is missing.', user: { login: 'openhands' } }]
    }
  });
  await t.end();
  assert.equal(t.job.escalated, true);
  assert.equal(t.job.escalated_after, 'handback');
  assert.equal(starts().at(-1).body.agent_profile_id, ESCALATE);
});

test('a comment of the agent on the parent after the ticket was closed is a delivery', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString();
  const t = await buildDelivery({
    issueState: 'closed',
    routes: {
      ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }],
      ['GET ' + API + '/issues/31/comments']: [{ created_at: at(60000), body: 'verification', user: { login: 'openhands' } }]
    }
  });
  await t.end();
  assert.equal(t.job.status, 'done');
  assert.equal(t.job.delivery_retry, undefined, 'not run once more');
  assert.equal(t.job.handback_retry, undefined);
});

test('a comment on an unrelated issue, of another user, or older than the run does not deliver for the parent', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString();
  const cases = {
    'an unrelated issue': { ['GET ' + API + '/issues/40/comments']: [{ created_at: at(60000), user: { login: 'openhands' } }] },
    'another user': { ['GET ' + API + '/issues/31/comments']: [{ created_at: at(60000), user: { login: 'marcel' } }] },
    'a comment before the run': { ['GET ' + API + '/issues/31/comments']: [{ created_at: at(-3600000), user: { login: 'openhands' } }] }
  };
  for (const name of Object.keys(cases)) {
    const t = await buildDelivery({ routes: { ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }], ...cases[name] } });
    await t.end();
    assert.equal(t.job.delivery_retry, 1, name);
    await t.end();
    assert.equal(t.job.result, 'no_delivery', name);
    assert.equal(t.job.delivered_on, undefined, name);
  }
});

test('a forge error on blocks, on the parent comments or on the user keeps no_delivery, and nothing is thrown', async () => {
  const at = (ms) => new Date(ctx.clock + ms).toISOString();
  const agentOnParent = { ['GET ' + API + '/issues/31/comments']: [{ created_at: at(60000), user: { login: 'openhands' } }] };
  const cases = {
    'blocks': { ['GET ' + API + '/issues/26/blocks']: { __status: 500 }, ...agentOnParent },
    'the comments of the parent': { ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }], ['GET ' + API + '/issues/31/comments']: { __status: 500 } },
    'the user of the token': { ['GET ' + API + '/issues/26/blocks']: [{ number: 31, state: 'open' }], ...agentOnParent, ['GET /api/v1/user']: { __status: 500 } }
  };
  for (const name of Object.keys(cases)) {
    const logs = [];
    const t = await buildDelivery({ logger: { error: (...args) => logs.push(args.join(' ')) }, routes: cases[name] });
    await t.end();
    assert.equal(t.job.delivery_retry, 1, name);
    await t.end();
    assert.equal(t.job.result, 'no_delivery', name);
    assert.equal(t.job.delivered_on, undefined, name);
    assert.ok(logs.some((line) => /could not read/.test(line)), name);
  }
});

test('a run that ends with an error is started once more after a pause; a second error is reported to the human on the issue', async () => {
  const { jobs, dispatcher, finish, comments } = await buildWatched({ ERROR_RETRIES: '1' });
  await dispatcher.enqueue(event('ai:ready', 26));
  await finish('error');
  const job = jobs.list()[0];
  assert.equal(job.status, 'queued');
  assert.equal(job.error_retry, 1);
  assert.equal(job.next_try, ctx.clock + 60000);
  assert.deepEqual(comments(), [], 'nobody is called for the first error');
  ctx.clock += 61000;
  await finish('error');
  assert.equal(jobs.list()[0].status, 'failed');
  assert.match(comments()[0], /^@marcel ForgeHands: the run for ai:ready ended with "error"\. A human has to look at it\./);
});

test('a failed round on a pull request marks it for the human; a review run leaves that to the verdict check', async () => {
  const { dispatcher, finish, comments, forgejo } = await buildWatched();
  await dispatcher.enqueue(prEvent());
  await finish('error');
  assert.match(comments()[0], /^@marcel ForgeHands: the run for ai:changes on pull request #34 ended with "error"/);
  assert.ok(forgejo.some((c) => c.method === 'POST' && c.path === '/issues/34/labels'), 'blocked label set');
});

test('SPLIT_LABEL: a worker run that ran out of iterations sends the ticket to the planner; without it a human is called; a paused run is resumed, never split', async () => {
  const split = await buildWatched({ SPLIT_LABEL: 'ai:plan' });
  await split.dispatcher.enqueue(event('ai:ready', 57));
  await split.finish('max_iterations');
  assert.match(split.comments()[0], /^ForgeHands: the run for ai:ready ended with "max_iterations", so the ticket is probably too big/);
  assert.ok(split.forgejo.some((c) => c.method === 'DELETE' && c.path === '/issues/57/labels/3'), 'the worker label comes off');
  assert.ok(split.forgejo.some((c) => c.method === 'POST' && c.path === '/issues/57/labels' && c.body.labels[0] === 8), 'the planner label goes on');
  // A pause is an interruption, not a too big ticket: the run goes on on its conversation and nothing is split.
  const paused = await buildWatched({ SPLIT_LABEL: 'ai:plan' });
  await paused.dispatcher.enqueue(event('ai:ready', 61));
  await paused.finish('paused');
  // The newest job: buildWatched ledgers share one file, so the split run above is listed first.
  assert.equal(paused.jobs.list().at(-1).status, 'running');
  assert.equal(paused.jobs.list().at(-1).pause_resumes, 1);
  assert.deepEqual(paused.comments(), []);
  assert.ok(!paused.forgejo.some((c) => c.method === 'DELETE' || (c.method === 'POST' && c.path === '/issues/61/labels')), 'no label changes');
  const plain = await buildWatched();
  await plain.dispatcher.enqueue(event('ai:ready', 58));
  await plain.finish('max_iterations');
  assert.match(plain.comments()[0], /^@marcel ForgeHands: the run for ai:ready ended with "max_iterations"\. A human/);
  assert.ok(!plain.forgejo.some((c) => c.method === 'DELETE'));
  const planner = await buildWatched({ SPLIT_LABEL: 'ai:plan', RESUME_ATTEMPTS: '0' });
  await planner.dispatcher.enqueue(event('ai:plan', 59));
  await planner.finish('stuck');
  assert.match(planner.comments()[0], /^@marcel/, 'the planner itself is never sent to the planner');
  assert.throws(() => loadConfig(env({ ERROR_RETRIES: '-1' })), /ERROR_RETRIES/);
});

test('the human also lifts a block that did not come from used-up rounds (a review without verdict, an untrusted approval)', async () => {
  const forgejo = [];
  const config = loadConfig(env(withChanges({ HUMAN_LOGIN: 'marcel' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    forgejo.push({ method: request.method, path: new URL(url).pathname });
    const body = request.method === 'GET' && new URL(url).pathname.endsWith('/issues/34/labels') ? [{ id: 9, name: 'ai:blocked' }] : request.method === 'GET' ? [] : { id: 77 };
    return { ok: true, status: 200, json: async () => body };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  assert.equal(jobs.list().length, 0, 'no round was ever started');
  await dispatcher.enqueue(prEvent([], { sender: { login: 'openhands' } }));
  assert.ok(!forgejo.some((call) => call.method === 'DELETE'), 'an agent never lifts it');
  await dispatcher.enqueue(prEvent([], { sender: { login: 'marcel' } }));
  assert.ok(forgejo.some((call) => call.method === 'DELETE' && call.path.endsWith('/issues/34/labels/9')), 'the human does');
});
