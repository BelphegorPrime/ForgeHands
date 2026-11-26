// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The security review of a green commit that touches a protected path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { ctx, env, starts, SECURITY, sensitiveRoutes, buildSensitive, REVIEWER, ciEvent, buildCi, MERGE, withMerge, API, VERDICT_OK, goodRoutes, mergerFor, approvedEvent, commentsOf, pull } from './helpers/direct.ts';

test('a green commit that changes a protected path also starts a security review, once per commit; it is advisory', async () => {
  const { dispatcher, jobs } = await buildSensitive(['README.md', 'compose.yaml']);
  assert.equal(loadConfig(env(withMerge({ LABEL_ROUTES: sensitiveRoutes() }))).routes.get('sensitive:review').kind, 'sensitive_review');
  assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'queued');
  assert.equal((await dispatcher.enqueue(ciEvent('success'))).status, 'duplicate_job', 'a second workflow of the same commit starts nothing more');
  await dispatcher.tick();
  const bodies = starts().map((call) => call.body);
  assert.deepEqual(bodies.map((body) => body.agent_profile_id).sort(), [REVIEWER, SECURITY].sort());
  const security = bodies.find((body) => body.agent_profile_id === SECURITY);
  const text = security.initial_message.content[0].text;
  assert.match(text, /protected paths: compose\.yaml\./);
  assert.match(text, /## Security review: OK` or `## Security review: CONCERNS/);
  assert.match(text, /set or remove NO label/);
  assert.equal(dispatcher.rounds(ciEvent('success')), 0, 'never a round');
  assert.equal(jobs.list().filter((job) => job.label === 'sensitive:review').length, 1);
});

test('no security review for a pull request without protected files, without the route, or for the same commit twice', async () => {
  const plain = await buildSensitive(['README.md', 'src/a.mjs']);
  await plain.dispatcher.enqueue(ciEvent('success'));
  assert.equal(plain.jobs.list().filter((job) => job.label === 'sensitive:review').length, 0);
  const without = await buildCi({ state: 'success', total_count: 1 }, { MERGE_POLICY: JSON.stringify(MERGE) });
  await without.dispatcher.enqueue(ciEvent('success'));
  assert.ok(!without.forgejo.some((call) => call.path.endsWith('/files')), 'without the route the files are not even read');
});

test('a security review that ended without its comment is run once more, then only logged; a failed run never blocks the pull request', async () => {
  const { dispatcher, jobs, forgejo } = await buildSensitive(['compose.yaml']);
  await dispatcher.enqueue(ciEvent('success'));
  await dispatcher.tick();
  const security = () => jobs.list().find((job) => job.label === 'sensitive:review');
  ctx.states[security().conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(security().verdict_retry, 1, 'run once more');
  assert.equal(security().status, 'running', 'and started again in the same pass');
  ctx.states[security().conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(security().status, 'done');
  assert.ok(!forgejo.calls.some((call) => call.method === 'POST' && call.path.endsWith('/comments')), 'advisory: nobody is called');
  const failing = await buildSensitive(['compose.yaml']);
  await failing.dispatcher.enqueue(ciEvent('success', { sha: 'abcdef0123456789' }));
  await failing.dispatcher.tick();
  ctx.states[failing.jobs.list().find((job) => job.label === 'sensitive:review').conversation_id] = 'error';
  await failing.dispatcher.tick();
  assert.ok(!failing.forgejo.calls.some((call) => call.method === 'POST' && call.path.endsWith('/labels')), 'no blocked label for an advisory run');
});

test('the hand-over to the human says what the security review found for this commit', async () => {
  const review = (word) => [{ created_at: '2026-11-15T11:00:00Z', user: { login: 'openhands' }, body: '## Security review: ' + word + '\nCommit cafe0000: ' + 'evidence '.repeat(40) }, { created_at: '2026-11-15T11:01:00Z', user: { login: 'openhands' }, body: VERDICT_OK }];
  const say = async (comments, extra) => {
    const { merger, forgejo } = await mergerFor(goodRoutes({ ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }], ['GET ' + API + '/issues/34/comments']: comments, ['GET ' + API + '/issues/34/comments?limit=100']: comments }), { HUMAN_LOGIN: 'marcel', ...extra });
    assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
    return commentsOf(forgejo).at(-1);
  };
  const on = { LABEL_ROUTES: sensitiveRoutes() };
  assert.match(await say(review('CONCERNS'), on), /has CONCERNS: read its comment before you merge\.$/);
  assert.match(await say(review('OK'), on), /found no concerns\.$/);
  assert.match(await say([review('OK')[1]], on), /There is no security review of this commit yet\.$/);
  assert.doesNotMatch(await say(review('CONCERNS')), /security review/i, 'without the route the text is as before');
});
