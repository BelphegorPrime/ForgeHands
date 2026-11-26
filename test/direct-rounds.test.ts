// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Rounds on a pull request: route kinds, label events of a pull request, and the human taking over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { ctx, repo, quiet, env, fakeApi, build, event, starts, CHANGES, withChanges, prPayload, prEvent, issue, pull } from './helpers/direct.ts';

test('route kind: only "on": "pull_request" makes a pull request route', () => {
  const routes = loadConfig(env(withChanges())).routes;
  assert.equal(routes.get('ai:changes').kind, 'pull_request');
  assert.equal(routes.get('ai:ready').kind, 'issue');
});

test('a label on the pull request of ai/issue-<n> becomes an event for that issue', () => {
  const e = prEvent();
  assert.equal(e.issue.number, 26);
  assert.equal(e.pull_request.number, 34);
  assert.equal(e.pull_request.head_ref, 'ai/issue-26');
  assert.equal(e.label, 'ai:changes');
  assert.equal(e.label_event, true);
  assert.equal(e.issue.comments, 2);
});

test('pull request events that must not start a round are ignored', () => {
  const norm = (payload, prLabels = ['ai:changes']) => normalizeEvent('pull_request', payload, new Set([repo]), [], { labelEvents: true, prLabels });
  assert.equal(norm(prPayload(['ai:changes'], { ref: 'feature/x' })), null);
  assert.equal(norm(prPayload(['ai:changes'], { state: 'closed' })), null);
  assert.equal(norm(prPayload(['ai:changes'], { merged: true })), null);
  assert.equal(norm(prPayload(['bug'])), null);
  assert.equal(norm(prPayload(['ai:changes'], { action: 'opened' })), null);
  assert.equal(norm(prPayload(['ai:changes']), []), null);
  assert.equal(normalizeEvent('pull_request', prPayload(['ai:changes']), new Set(['other/repo']), [], { prLabels: ['ai:changes'] }), null);
});

test('labels of a pull request are tracked apart from the issue with the same number', async () => {
  const { dispatcher, jobs } = await build(withChanges());
  const allowed = new Set([repo]);
  dispatcher.recordLabels(prPayload(['ai:changes'], { number: 26 }), allowed);
  await jobs.persist(ctx.clock); // recordLabels saves in the background; do not leave it running into the cleanup
  assert.deepEqual(dispatcher.labelsBefore(prPayload(['ai:changes'], { number: 26 }), allowed), ['ai:changes']);
  assert.equal(dispatcher.labelsBefore({ repository: { full_name: repo }, issue: { number: 26, labels: [] } }, allowed), null);
});

test('a round starts the pull request route on the same branch and says so in its prompt', async () => {
  const { dispatcher, jobs } = await build(withChanges());
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  await dispatcher.tick();
  const { body } = starts()[0];
  assert.equal(body.agent_profile_id, CHANGES);
  assert.equal(body.max_iterations, 90);
  assert.deepEqual(body.tags, { source: 'forgehands', issue: '26', pr: '34' });
  const text = body.initial_message.content[0].text;
  assert.match(text, /pull request #34/);
  assert.match(text, /Check out the branch ai\/issue-26/);
  assert.match(text, /pulls\/34\/reviews/);
  assert.match(text, /issues\/34\/comments/);
  assert.match(text, /Never open another pull request/);
  assert.match(text, /remove the label ai:changes/);
  assert.match(text, /written by marcel/);
  assert.equal(jobs.list()[0].key, 'owner/hello#26:ai:changes');
});

test('the same label while a round runs starts no second round, a re-label after it ended does', async () => {
  const { dispatcher, jobs } = await build(withChanges());
  await dispatcher.enqueue(prEvent());
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'duplicate_job');
  ctx.states[jobs.list()[0].conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
});

test('an action of the human on the pull request starts the rounds again and lifts the block; an agent does not', async () => {
  const forgejo = [];
  const config = loadConfig(env(withChanges({ MAX_ROUNDS: '1', HUMAN_LOGIN: 'marcel' })));
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
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  await dispatcher.tick();
  ctx.states[jobs.list().at(-1).conversation_id] = 'finished';
  await dispatcher.tick();
  const agent = (login) => prEvent([], { sender: { login } });
  forgejo.length = 0; // the first round was started by the human too
  assert.equal((await dispatcher.enqueue(agent('openhands'))).status, 'rounds_exceeded', 'an agent does not reset the budget');
  assert.ok(!forgejo.some((call) => call.method === 'DELETE' && call.path.endsWith('/labels/9')));
  assert.equal((await dispatcher.enqueue(agent('Marcel'))).status, 'queued', 'the human starts a fresh budget');
  assert.ok(forgejo.some((call) => call.method === 'DELETE' && call.path === '/api/v1/repos/owner/hello/issues/34/labels/9'), 'the block comes off');
  assert.equal(dispatcher.rounds(prEvent()), 1, 'only the new round counts');
});
