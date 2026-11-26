// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// CI outcomes: fix rounds on a red commit and the review of a green one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { ctx, repo, quiet, env, event, starts, webhook, CHANGES, prEvent, REVIEWER, withCi, CI_ROUTES, runPayload, ciEvent, buildCi, issue, pull } from './helpers/direct.ts';

test('CI runs: route kinds, event shape and everything that is ignored', () => {
  const routes = loadConfig(env(withCi())).routes;
  assert.equal(routes.get('ci:failure').kind, 'ci_failure');
  assert.equal(routes.get('ci:success').kind, 'ci_success');
  const failed = ciEvent('failure');
  assert.equal(failed.type, 'ci.failure');
  assert.equal(failed.label, 'ci:failure');
  assert.equal(failed.issue.number, 26);
  assert.deepEqual(failed.pull_request, { number: 34, head_ref: 'ai/issue-26', html_url: null });
  assert.equal(failed.ci.commit_sha, 'abcdef0123456789');
  assert.equal(ciEvent('success').label, 'ci:success');
  assert.equal(ciEvent('failure', { ref: 'feature/x' }), null);
  assert.equal(ciEvent('failure', { state: 'closed' }), null);
  assert.equal(ciEvent('failure', { merged: true }), null);
  assert.equal(ciEvent('failure', { event: 'push' }), null);
  assert.equal(normalizeEvent('action_run_failure', runPayload('failure'), new Set([repo]), [], { ci: { success: 'ci:success' } }), null);
  assert.equal(normalizeEvent('action_run_failure', runPayload('failure'), new Set(['other/repo']), [], { ci: CI_ROUTES }), null);
  assert.equal(normalizeEvent('action_run_failure', { run: { ...runPayload('failure').run, event_payload: 'not json' } }, new Set([repo]), [], { ci: CI_ROUTES }), null);
});

test('a failed CI run starts a fix round on the same branch, once per commit', async () => {
  const { dispatcher, jobs } = await buildCi({});
  assert.equal((await dispatcher.enqueue(ciEvent('failure'))).status, 'queued');
  await dispatcher.tick();
  const { body } = starts()[0];
  assert.equal(body.agent_profile_id, CHANGES);
  assert.equal(body.max_iterations, 100);
  assert.deepEqual(body.tags, { source: 'forgehands', issue: '26', pr: '34', ci: 'failure' });
  const text = body.initial_message.content[0].text;
  assert.match(text, /Its CI failed: workflow ci\.yaml/);
  assert.match(text, /commit abcdef01/);
  assert.match(text, /Push to the SAME branch ai\/issue-26/);
  assert.doesNotMatch(text, /remove the label/);
  assert.equal(jobs.list()[0].key, 'owner/hello#26:ci:failure:abcdef01');
  assert.equal((await dispatcher.enqueue(ciEvent('failure', { sha: 'abcdef0123456789' }))).status, 'duplicate_job');
  // another commit is kept until the run of the first one is over, then it starts
  assert.equal((await dispatcher.enqueue(ciEvent('failure', { sha: 'ffffff0123456789' }))).status, 'deferred');
  assert.equal(starts().length, 1);
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(starts().length, 2);
  assert.equal((await dispatcher.enqueue(ciEvent('failure', { sha: 'ffffff0123456789' }))).status, 'duplicate_job');
});

test('a green commit starts the review; it needs all workflows green and never counts as a round', async () => {
  const green = await buildCi({ state: 'success', total_count: 2 });
  assert.equal((await green.dispatcher.enqueue(ciEvent('success'))).status, 'queued');
  await green.dispatcher.tick();
  const { body } = starts()[0];
  assert.equal(body.agent_profile_id, REVIEWER);
  assert.equal(body.max_iterations, 60);
  const text = body.initial_message.content[0].text;
  assert.match(text, /Its CI is green/);
  assert.match(text, /You do not change code/);
  assert.match(text, /add the label ai:approved/);
  assert.match(text, /add the label ai:changes instead/);
  assert.match(text, /at most 25 tool calls/);
  assert.ok(green.forgejo.some((call) => /\/commits\/abcdef0123456789\/status$/.test(call.path)));
  assert.equal(green.dispatcher.rounds(ciEvent('success')), 0);
});

test('no review while another workflow is pending or failed, on an unknown status or without Forgejo access', async () => {
  for (const status of [{ state: 'pending', total_count: 2 }, { state: 'failure', total_count: 2 }, { state: 'success', total_count: 0 }, 'error']) {
    const { dispatcher } = await buildCi(status);
    assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'ci_not_green');
  }
  const noAccess = await buildCi({ state: 'success', total_count: 1 });
  noAccess.config.forgejo = null;
  assert.equal((await noAccess.dispatcher.enqueue(ciEvent('success'))).status, 'ci_not_green');
  assert.equal(starts().length, 0);
});

test('fix rounds share the round limit with label rounds', async () => {
  const { dispatcher, jobs } = await buildCi({}, { MAX_ROUNDS: '2' });
  const finish = async () => { await dispatcher.tick(); ctx.states[jobs.list().at(-1).conversation_id] = 'finished'; await dispatcher.tick(); };
  assert.equal((await dispatcher.enqueue(ciEvent('failure', { sha: '1111111100' }))).status, 'queued');
  await finish();
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  await finish();
  assert.equal((await dispatcher.enqueue(ciEvent('failure', { sha: '2222222200' }))).status, 'rounds_exceeded');
});

test('the webhook delivers a CI outcome of an agent pull request', async () => {
  const { config, jobs, dispatcher } = await buildCi({});
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify(runPayload('failure')));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'action_run_failure', 'x-forgejo-delivery': 'd-ci-1',
        'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') },
      body: raw
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'queued');
    assert.equal(jobs.list()[0].key, 'owner/hello#26:ci:failure:abcdef01');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
