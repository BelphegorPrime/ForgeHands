// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Round limits per issue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { ctx, quiet, env, fakeApi, build, event, starts, webhook, withChanges, prPayload, prEvent, issue, pull } from './helpers/direct.ts';

test('rounds are limited per issue; the pull request is told and marked when they are used up', async () => {
  const forgejo = [];
  const config = loadConfig(env(withChanges({ MAX_ROUNDS: '2' })));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    forgejo.push({ method: request.method, path: new URL(url).pathname, body: request.body && JSON.parse(request.body), auth: request.headers.authorization });
    const body = request.method === 'GET' ? [] : { id: 77 };
    return { ok: true, status: 200, json: async () => body };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  for (let round = 0; round < 2; round++) {
    assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
    await dispatcher.tick();
    ctx.states[jobs.list().at(-1).conversation_id] = 'finished';
    await dispatcher.tick();
  }
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'rounds_exceeded');
  assert.equal(starts().length, 2);
  // every started round first looks whether an earlier approval has to be taken back
  // (after every run the branch is looked at once, see checkBranchAfterRun, and a finished round reads its pull request once, see checkRoundsAfterRun:
  // those reads are not part of the marking)
  // The agent login is read once after each finished run to judge a clone hand-back, then the comments and the pull request (delivery.ts).
  const marking = forgejo.filter((call) => !(call.method === 'GET' && (call.path.endsWith('/issues/34/labels') || call.path.endsWith('/pulls/34') || call.path.includes('/branches/') || call.path === '/api/v1/user')));
  const paths = marking.map((call) => call.method + ' ' + call.path);
  assert.deepEqual(paths, [
    'POST /api/v1/repos/owner/hello/issues/34/comments',
    'GET /api/v1/repos/owner/hello/labels',
    'POST /api/v1/repos/owner/hello/labels',
    'POST /api/v1/repos/owner/hello/issues/34/labels'
  ]);
  assert.match(marking[0].body.body, /2 follow-up rounds for issue #26/);
  assert.equal(marking[2].body.name, 'ai:blocked');
  assert.deepEqual(marking[3].body, { labels: [77] });
  assert.equal(marking[0].auth, 'token tok-secret-value');
});

test('rounds of another issue do not count', async () => {
  const { dispatcher } = await build(withChanges({ MAX_ROUNDS: '1' }));
  const other = prEvent();
  other.issue = { ...other.issue, number: 27 };
  assert.equal((await dispatcher.enqueue(prEvent())).status, 'queued');
  assert.equal((await dispatcher.enqueue(other)).status, 'queued');
});

test('the webhook delivers a label on a pull request to a round', async () => {
  const config = loadConfig(env(withChanges()));
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const dispatcher = new Dispatcher(config, jobs, fakeApi(), quiet, () => ctx.clock);
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify(prPayload(['ai:changes'])));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'pull_request', 'x-forgejo-delivery': 'd-pr-1',
        'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') },
      body: raw
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'queued');
    assert.equal(jobs.list()[0].key, 'owner/hello#26:ai:changes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
