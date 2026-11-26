// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Paused runs, issue dependencies, the epic review and the status page per issue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { normalizeEvent } from '../src/webhook/events.ts';
import { buildStatus, renderStatus } from '../src/server/status.ts';
import { ctx, WORKER, repo, quiet, env, fakeApi, build, event, starts, webhook, withChanges, prEvent, REVIEWER, API, withEpic, buildEpic, issue, closedEvent, ticket } from './helpers/direct.ts';

test('a paused conversation is resumed on its conversation and keeps its slot until the run ends', async () => {
  const config = loadConfig(env(withChanges()));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  // The forge answers the open ticket with its trigger label (the check a paused run goes through before it is resumed).
  const send = async (url, request) => String(url).startsWith('https://forge.example/')
    ? { ok: true, status: 200, json: async () => ({ number: 26, state: 'open', labels: [{ id: 3, name: 'ai:ready' }] }) } : api(url, request);
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  assert.equal((await dispatcher.enqueue(event('ai:ready', 26))).status, 'queued');
  await dispatcher.tick();
  const job = jobs.list()[0];
  assert.equal(job.status, 'running');
  ctx.states[job.conversation_id] = 'paused';
  await dispatcher.tick();
  assert.equal(job.status, 'running');
  assert.equal(job.pause_resumes, 1);
  assert.equal(jobs.list(true).length, 1, 'the run goes on, so the slot stays taken');
  ctx.states[job.conversation_id] = 'finished';
  await dispatcher.tick();
  assert.equal(job.status, 'done');
  assert.equal(jobs.list(true).length, 0);
});

test('a closed issue becomes an event, unless the repository is not allowed', () => {
  assert.equal(closedEvent(7).type, 'issues.closed');
  assert.equal(closedEvent(7).issue.number, 7);
  assert.equal(normalizeEvent('issues', { action: 'closed', repository: { full_name: 'other/repo' }, issue: { number: 7 } }, new Set([repo]), ['ai:ready'], {}), null);
  assert.equal(normalizeEvent('issues', { action: 'closed', repository: { full_name: repo }, issue: {} }, new Set([repo]), ['ai:ready'], {}), null);
});

test('an issue with open dependencies waits instead of starting', async () => {
  const { dispatcher, jobs } = await buildEpic({ ['GET ' + API + '/issues/2/dependencies']: [issue(1, 'open'), issue(9, 'closed')] });
  assert.deepEqual(await dispatcher.enqueue(event('ai:ready', 2)), { status: 'waiting' });
  await dispatcher.tick();
  assert.equal(starts().length, 0);
  assert.equal(jobs.list()[0].status, 'waiting');
  assert.deepEqual(jobs.list()[0].waiting_for, [1]);
  assert.equal((await dispatcher.enqueue(event('ai:ready', 2))).status, 'duplicate_job');
});

test('an issue without open dependencies starts as before', async () => {
  const { dispatcher } = await buildEpic({ ['GET ' + API + '/issues/2/dependencies']: [issue(1, 'closed')] });
  assert.equal((await dispatcher.enqueue(event('ai:ready', 2))).status, 'queued');
  await dispatcher.tick();
  assert.equal(starts().length, 1);
});

test('the last dependency closing starts the waiting issue; another open one keeps it waiting', async () => {
  let still = [issue(1, 'closed'), issue(3, 'open')];
  const routes = {
    ['GET ' + API + '/issues/2/dependencies']: () => still,
    ['GET ' + API + '/issues/1/blocks']: [issue(2, 'open')]
  };
  const { dispatcher, jobs } = await buildEpic(routes);
  jobs.add({ key: 'owner/hello#2:ai:ready', label: 'ai:ready', event: { ...event('ai:ready', 2), label: 'ai:ready' }, status: 'waiting', waiting_for: [1, 3], created: ctx.clock });
  assert.equal(await dispatcher.onClosed(closedEvent(1)), 'nothing_ready');
  assert.equal(jobs.list()[0].status, 'waiting');
  still = [issue(1, 'closed'), issue(3, 'closed')];
  assert.equal(await dispatcher.onClosed(closedEvent(1)), 'started #2');
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.equal(starts()[0].body.agent_profile_id, WORKER);
});

test('an epic is reviewed when its last dependency closes, once, with its sub-issues in the prompt', async () => {
  const epic = issue(10, 'open', { title: 'Epic', body: 'Make X work', labels: [{ name: 'ai:plan' }], html_url: 'https://forge.example/owner/hello/issues/10' });
  const routes = {
    ['GET ' + API + '/issues/11/blocks']: [epic],
    ['GET ' + API + '/issues/10/dependencies']: [issue(11, 'closed', { title: 'Part one' }), issue(12, 'closed', { title: 'Part two' })]
  };
  const { dispatcher, jobs } = await buildEpic(routes);
  assert.equal(await dispatcher.onClosed(closedEvent(11)), 'epic #10 review');
  await dispatcher.tick();
  const { body } = starts()[0];
  assert.equal(body.agent_profile_id, REVIEWER);
  assert.equal(body.max_iterations, 40);
  assert.deepEqual(body.tags, { source: 'forgehands', issue: '10', epic: 'done' });
  const text = body.initial_message.content[0].text;
  assert.match(text, /epic #10/);
  assert.match(text, /Every sub-issue is closed: #11 Part one; #12 Part two/);
  assert.match(text, /You do not change code and you do not create issues/);
  assert.match(text, /close the epic/);
  assert.match(text, /Make X work/);
  assert.match(text, /write exactly ONE comment on the epic/);
  assert.match(text, /do not post drafts, do not delete or rewrite comments afterwards, and finish right after the comment/);
  assert.equal(jobs.list()[0].key, 'owner/hello#10:epic:done');
  assert.equal(await dispatcher.onClosed(closedEvent(11)), 'nothing_ready'); // the review is already queued or running
});

test('epic review needs a route, the epic label, an open epic and Forgejo access', async () => {
  const epic = issue(10, 'open', { labels: [{ name: 'ai:plan' }] });
  const base = { ['GET ' + API + '/issues/11/blocks']: [epic], ['GET ' + API + '/issues/10/dependencies']: [issue(11, 'closed')] };
  const noLabel = await buildEpic({ ...base, ['GET ' + API + '/issues/11/blocks']: [issue(10, 'open', { labels: [{ name: 'bug' }] })] });
  assert.equal(await noLabel.dispatcher.onClosed(closedEvent(11)), 'nothing_ready');
  const closed = await buildEpic({ ...base, ['GET ' + API + '/issues/11/blocks']: [issue(10, 'closed', { labels: [{ name: 'ai:plan' }] })] });
  assert.equal(await closed.dispatcher.onClosed(closedEvent(11)), 'nothing_ready');
  const noRoute = await buildEpic(base);
  noRoute.config.routes.delete('epic:done');
  assert.equal(await noRoute.dispatcher.onClosed(closedEvent(11)), 'nothing_ready');
  const noAccess = await buildEpic(base);
  noAccess.config.forgejo = null;
  assert.equal(await noAccess.dispatcher.onClosed(closedEvent(11)), 'no_forgejo_access');
  const failing = await buildEpic({});
  assert.equal(await failing.dispatcher.onClosed(closedEvent(11)), 'blocks_unknown');
  assert.equal(starts().length, 0);
});

test('the webhook turns a closed issue into the start of what waited for it', async () => {
  const routes = { ['GET ' + API + '/issues/1/blocks']: [issue(2, 'open')], ['GET ' + API + '/issues/2/dependencies']: [issue(1, 'closed')] };
  const { config, jobs, dispatcher } = await buildEpic(routes);
  jobs.add({ key: 'owner/hello#2:ai:ready', label: 'ai:ready', event: { ...event('ai:ready', 2), label: 'ai:ready' }, status: 'waiting', waiting_for: [1], created: ctx.clock });
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = Buffer.from(JSON.stringify({ action: 'closed', repository: { full_name: repo }, issue: { number: 1 }, sender: { login: 'marcel' } }));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/forgejo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forgejo-event': 'issues', 'x-forgejo-delivery': 'd-closed-1',
        'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex') },
      body: raw
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'started #2');
    await dispatcher.tick();
    assert.equal(starts().length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the status says per issue what runs and what it waits for, without event text', async () => {
  const { config, jobs } = await build(withChanges({ MAX_ROUNDS: "2" }));
  const add = (key, label, status, extra = {}, ev = {}) => jobs.add({ key, label, status, created: ctx.clock++, event: { ...event(label, Number(key.match(/#(\d+)/)[1])), ...ev }, ...extra });
  add('owner/hello#2:ai:ready', 'ai:ready', 'waiting', { waiting_for: [1] }, { issue: { number: 2, title: 'Second <b>', body: 'SECRET BODY', labels: [] } });
  add('owner/hello#3:ai:ready', 'ai:ready', 'running', { started: ctx.clock, conversation_id: 'c3', cost: 0.12345 });
  add('owner/hello#4:ai:ready', 'ai:ready', 'done', { started: ctx.clock, finished: ctx.clock });
  add('owner/hello#5:ai:ready', 'ai:ready', 'failed', { result: 'timeout', started: ctx.clock });
  const status = buildStatus(config, jobs, ctx.clock);
  const byIssue = Object.fromEntries(status.issues.map((issue) => [issue.issue, issue]));
  assert.equal(byIssue['owner/hello#2'].state, 'waiting for #1');
  assert.equal(byIssue['owner/hello#3'].state, 'worker running');
  assert.equal(byIssue['owner/hello#4'].state, 'worker done, waiting for the next event');
  assert.equal(byIssue['owner/hello#5'].state, 'worker failed (timeout)');
  assert.equal(byIssue['owner/hello#3'].runs[0].cost, 0.123);
  assert.equal(byIssue['owner/hello#3'].runs[0].conversation, 'c3');
  assert.equal(status.limits.running, 1);
  assert.doesNotMatch(JSON.stringify(status), /SECRET BODY/);
  const html = renderStatus(status);
  assert.match(html, /Second &lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('rounds are counted per issue and shown as used up', async () => {
  const { config, jobs } = await build(withChanges({ MAX_ROUNDS: '2' }));
  for (const [i, label] of ['ai:changes', 'ai:changes'].entries()) {
    jobs.add({ key: 'owner/hello#26:' + label + ':' + i, label, status: 'done', started: ctx.clock, created: ctx.clock + i, event: { ...prEvent(), label } });
  }
  const [issue] = buildStatus(config, jobs, ctx.clock).issues;
  assert.equal(issue.rounds, 2);
  assert.equal(issue.pr, 34);
  assert.equal(issue.state, 'rounds used up (2/2)');
});

test('/status and /status.json are served in direct mode and show no secrets', async () => {
  const { config, jobs, dispatcher } = await build(withChanges());
  jobs.add({ key: 'owner/hello#3:ai:ready', label: 'ai:ready', status: 'running', started: ctx.clock, created: ctx.clock, conversation_id: 'c3', event: event('ai:ready', 3) });
  const store = new DeliveryStore(config.dataFile);
  await store.load();
  const server = createApp(config, store, undefined, quiet, dispatcher);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const data = await (await fetch(base + '/status.json')).json();
    assert.equal(data.issues[0].issue, 'owner/hello#3');
    const page = await fetch(base + '/status');
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /worker running/);
    assert.doesNotMatch(html + JSON.stringify(data), /tok-secret-value|k{24}/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- ai:close: an issue that only wants the closing review, without a planner run
test('ai:close asks for the closing review like ai:plan and starts no run of its own', async () => {
  const closing = issue(10, 'open', { title: 'Old ticket', body: 'Criteria', labels: [{ name: 'ai:close' }] });
  const routes = {
    ['GET ' + API + '/issues/11/blocks']: [closing],
    ['GET ' + API + '/issues/10/dependencies']: [issue(11, 'closed', { title: 'Part' })]
  };
  const { dispatcher, jobs, config } = await buildEpic(routes);
  assert.deepEqual([...config.epicLabels], ['ai:plan', 'ai:close']);
  // the label itself starts nothing: it has no route
  assert.equal(normalizeEvent('issues', { action: 'labeled', repository: { full_name: repo }, label: { name: 'ai:close' }, issue: { number: 10, labels: [{ name: 'ai:close' }] }, sender: { login: 'marcel' } },
    new Set([repo]), [...config.routes.keys()], {}), null);
  assert.equal(await dispatcher.onClosed(closedEvent(11)), 'epic #10 review');
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.equal(starts()[0].body.agent_profile_id, REVIEWER);
  assert.match(starts()[0].body.initial_message.content[0].text, /Every sub-issue is closed: #11 Part/);
  assert.equal(jobs.list().filter((job) => job.label === 'ai:plan').length, 0);
});

test('only a dependency that is still open holds the ai:close review back, and EPIC_LABEL is a list', async () => {
  const closing = issue(10, 'open', { labels: [{ name: 'ai:close' }] });
  const routes = { ['GET ' + API + '/issues/11/blocks']: [closing], ['GET ' + API + '/issues/10/dependencies']: [issue(11, 'closed'), issue(12, 'open')] };
  const { dispatcher } = await buildEpic(routes);
  assert.equal(await dispatcher.onClosed(closedEvent(11)), 'nothing_ready');
  assert.equal(starts().length, 0);
  assert.deepEqual([...loadConfig(env(withEpic({ EPIC_LABEL: ' ai:x , ai:y ' }))).epicLabels], ['ai:x', 'ai:y']);
  const other = await buildEpic({ ['GET ' + API + '/issues/11/blocks']: [closing], ['GET ' + API + '/issues/10/dependencies']: [issue(11, 'closed')] }, { EPIC_LABEL: 'ai:plan' });
  assert.equal(await other.dispatcher.onClosed(closedEvent(11)), 'nothing_ready');
});
