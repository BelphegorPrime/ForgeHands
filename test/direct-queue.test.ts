// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The queue: dependencies added later, the order within a repository and REPO_WEIGHTS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { loadConfig } from '../src/config.ts';
import { ctx, repo, quiet, env, fakeApi, event, starts, buildQueue, startOrder, withCi, ciEvent, ticket } from './helpers/direct.ts';

test('a queued ticket whose dependencies were added afterwards waits instead of starting', async () => {
  const forgejo = [];
  const config = loadConfig(env({}));
  const jobs = new JobStore(join(ctx.dir, 'jobs.json'));
  await jobs.load();
  const api = fakeApi();
  let asked = 0;
  const open = [{ number: 130, state: 'open' }, { number: 131, state: 'closed' }];
  const send = async (url, request) => {
    if (!String(url).startsWith('https://forge.example/')) return api(url, request);
    const path = new URL(url).pathname;
    forgejo.push(request.method + ' ' + path);
    // The first look (when the ticket is queued) finds no dependency; the edges are added after that.
    return { ok: true, status: 200, json: async () => path.endsWith('/dependencies') ? (asked++ === 0 ? [] : open) : [] };
  };
  const dispatcher = new Dispatcher(config, jobs, send, quiet, () => ctx.clock);
  assert.equal((await dispatcher.enqueue(event('ai:ready', 132))).status, 'queued');
  await dispatcher.tick();
  assert.equal(starts().length, 0, 'nothing started');
  const job = jobs.list(true)[0];
  assert.equal(job.status, 'waiting');
  assert.deepEqual(job.waiting_for, [130]);
});

test('within a repository the oldest ticket that can start goes first, not the one queued first', async () => {
  const { jobs, dispatcher } = await buildQueue({ ALLOWED_REPOS: 'o/a' }, [['o/a', 9], ['o/a', 3], ['o/a', 5], ['o/a', 4]]);
  assert.deepEqual(await startOrder(dispatcher, jobs, 4), ['o/a#3', 'o/a#4', 'o/a#5', 'o/a#9']);
});

test('within a repository a ticket that has begun (a review, a round) goes before a new ticket', async () => {
  const { jobs, dispatcher } = await buildQueue({ ALLOWED_REPOS: repo, LABEL_ROUTES: withCi().LABEL_ROUTES }, [[repo, 3], [repo, 5]], 'begun.json');
  jobs.add({ key: repo + '#26:ci:success:abcdef01', label: 'ci:success', event: ciEvent('success'), status: 'queued', created: ctx.clock + 100 });
  assert.deepEqual(await startOrder(dispatcher, jobs, 3), [repo + '#26', repo + '#3', repo + '#5'], 'the review of ticket 26 first, then the new tickets from the lowest number');
});

test('REPO_WEIGHTS: weights 2, 1 and 5 give 2 of 8, 1 of 8 and 5 of 8 of the starts; an unlisted repository has weight 1', async () => {
  const tickets = [];
  for (let n = 1; n <= 24; n++) for (const full of ['o/a', 'o/b', 'o/c']) tickets.push([full, n]);
  const { jobs, dispatcher } = await buildQueue({ ALLOWED_REPOS: 'o/a,o/b,o/c', REPO_WEIGHTS: JSON.stringify({ 'o/a': 2, 'O/C': 5 }) }, tickets);
  const order = await startOrder(dispatcher, jobs, 24);
  const share = (list, repo) => list.filter((entry) => entry.startsWith(repo + '#')).length;
  assert.deepEqual([share(order.slice(0, 8), 'o/a'), share(order.slice(0, 8), 'o/b'), share(order.slice(0, 8), 'o/c')], [2, 1, 5], 'the first eight');
  assert.deepEqual([share(order, 'o/a'), share(order, 'o/b'), share(order, 'o/c')], [6, 3, 15], 'all 24 starts');
  // each repository still works its tickets from the oldest
  for (const repo of ['o/a', 'o/b', 'o/c']) {
    const numbers = order.filter((entry) => entry.startsWith(repo + '#')).map((entry) => Number(entry.split('#')[1]));
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  }
});

test('a repository with nothing to start gives its share away; equal weights alternate', async () => {
  const idle = await buildQueue({ ALLOWED_REPOS: 'o/a,o/b', REPO_WEIGHTS: JSON.stringify({ 'o/a': 5 }) }, [['o/b', 1], ['o/b', 2], ['o/b', 3]]);
  assert.deepEqual(await startOrder(idle.dispatcher, idle.jobs, 3), ['o/b#1', 'o/b#2', 'o/b#3']);
  const equal = await buildQueue({ ALLOWED_REPOS: 'o/a,o/b' }, [['o/a', 1], ['o/a', 2], ['o/a', 3], ['o/b', 1], ['o/b', 2], ['o/b', 3]], 'equal.json');
  const order = await startOrder(equal.dispatcher, equal.jobs, 6);
  assert.deepEqual(order.map((entry) => entry.slice(0, 3)), ['o/a', 'o/b', 'o/a', 'o/b', 'o/a', 'o/b']);
});

test('REPO_WEIGHTS is validated', () => {
  const base = { ALLOWED_REPOS: 'o/a' };
  assert.equal(loadConfig(env({ ...base })).repoWeights.size, 0);
  assert.equal(loadConfig(env({ ...base, REPO_WEIGHTS: '{"O/A": 2.5}' })).repoWeights.get('o/a'), 2.5);
  for (const bad of ['not json', '[1]', '{"o/a": 0}', '{"o/a": -1}', '{"o/a": "2"}', '{"o/a": 5000}', '{"no-slash": 1}']) {
    assert.throws(() => loadConfig(env({ ...base, REPO_WEIGHTS: bad })), /REPO_WEIGHTS/, bad);
  }
});
