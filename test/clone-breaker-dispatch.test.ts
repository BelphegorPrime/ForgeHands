// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The dispatcher's slice of the clone breaker: transitions are counted, one hand-over per incident, the claim survives a restart.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { CLONE_BREAKER_HOLD_MS } from '../src/agent/clone-breaker.ts';
import { JobStore } from '../src/store/jobs.ts';
import { Notifier } from '../src/notify/index.ts';
import { immediateMessage } from '../src/notify/texts.ts';
import { metrics } from '../src/metrics.ts';

const WORKER = '22222222-2222-4222-8222-222222222222';
const PLANNER = '11111111-1111-4111-8111-111111111111';
const repo = 'owner/hello';
const quiet = { error() {} };
let dir;
let clock;

const env = () => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  TICKET_PREFLIGHT: '0',
  ALLOWED_REPOS: repo + ',owner/quiet',
  LABEL_ROUTES: JSON.stringify({ 'ai:plan': { profile: PLANNER, tier: 'strong' }, 'ai:ready': { profile: WORKER, tier: 'free' } }),
  ERROR_RETRIES: '1',
  FORGE_URL: 'https://forge.example',
  FORGE_TOKEN: 'tok-secret-value',
  MERGE_POLICY: JSON.stringify({ [repo]: { deny: ['compose.yaml'] } }),
  DATA_FILE: join(dir, 'deliveries.json')
});
// No test path in this slice talks to the forge or OpenHands; a call fails the test instead of escaping to the network.
const noNetwork = async () => { throw new Error('unexpected network call'); };
const recording = () => {
  const sent = [];
  const channel = { name: 'fake', async send(message) { sent.push(message); } };
  return { notifier: new Notifier([channel], ['handover'], () => false, quiet, () => {}), sent };
};
async function build(notifier) {
  const config = loadConfig(env());
  const jobs = new JobStore(join(dir, 'jobs.json'), quiet);
  await jobs.load();
  return { config, jobs, dispatcher: new Dispatcher(config, jobs, noNetwork, quiet, () => clock, notifier) };
}
const report = (conversation, repository = 'owner/a', failureClass = 'clone_failed') => ({ class: failureClass, repository, conversation });
const owner = repo + '#1:ai:ready';
const transition = (from, to) => metrics.read('forgehands_clone_breaker_transitions_total')
  .find((row) => row.labels.from === from && row.labels.to === to)?.value ?? 0;
async function trip(dispatcher) {
  await dispatcher.reportCloneFailure(report('conv-1', 'owner/a'), 'owner/a');
  await dispatcher.reportCloneFailure(report('conv-2', 'owner/a'), 'owner/a');
  return dispatcher.reportCloneFailure(report('conv-3', 'owner/b', 'repository_not_found'), 'owner/b');
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-clone-breaker-dispatch-')); clock = 1_000_000; metrics.reset(); });
afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

test('three reports in two repositories open the breaker: one closed->open transition and one hand-over', async () => {
  const { notifier, sent } = recording();
  const { dispatcher } = await build(notifier);
  assert.equal(await trip(dispatcher), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'open');
  assert.equal(transition('closed', 'open'), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'handover');
  assert.match(sent[0].subject, /new starts are paused/i);
  assert.match(sent[0].text, /resume after one successful trial/i);
});

test('a fourth report does not notify again', async () => {
  const { notifier, sent } = recording();
  const { dispatcher } = await build(notifier);
  await trip(dispatcher);
  assert.equal(await dispatcher.reportCloneFailure(report('conv-4', 'owner/c'), 'owner/c'), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'open');
  assert.equal(transition('closed', 'open'), 1);
  assert.equal(sent.length, 1);
});

test('admit then abandon reopens, counts half_open->open and sends no second message', async () => {
  const { notifier, sent } = recording();
  const { dispatcher } = await build(notifier);
  await trip(dispatcher);
  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(await dispatcher.admitCloneTrial(owner), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'half_open');
  assert.equal(await dispatcher.abandonCloneTrial(owner), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'open');
  assert.equal(transition('half_open', 'open'), 1);
  assert.equal(sent.length, 1);
});

test('a checkout closes the breaker and a later incident notifies again', async () => {
  const { notifier, sent } = recording();
  const { dispatcher } = await build(notifier);
  await trip(dispatcher);
  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(await dispatcher.admitCloneTrial(owner), true);
  assert.equal(await dispatcher.confirmCloneTrial(owner, 'conv-trial'), true);
  assert.equal(await dispatcher.settleCloneTrial('conv-trial', 'checkout'), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'closed');
  assert.equal(transition('half_open', 'closed'), 1);
  assert.equal(sent.length, 1);

  await dispatcher.reportCloneFailure(report('conv-4', 'owner/a'), 'owner/a');
  await dispatcher.reportCloneFailure(report('conv-5', 'owner/a'), 'owner/a');
  assert.equal(await dispatcher.reportCloneFailure(report('conv-6', 'owner/b'), 'owner/b'), true);
  assert.equal(dispatcher.cloneBreaker.state(), 'open');
  assert.equal(transition('closed', 'open'), 2);
  assert.equal(sent.length, 2);
});

test('a restart over the same ledger keeps the single claim and sends nothing on a reopen', async () => {
  const { notifier, sent } = recording();
  const first = await build(notifier);
  await trip(first.dispatcher);
  assert.equal(sent.length, 1);

  const second = await build(notifier);
  await second.dispatcher.pass();
  assert.equal(second.jobs.meta.clone_breaker.notified, true);
  assert.equal(second.dispatcher.cloneBreaker.state(), 'open');

  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(await second.dispatcher.admitCloneTrial(owner), true);
  assert.equal(await second.dispatcher.abandonCloneTrial(owner), true);
  assert.equal(second.dispatcher.cloneBreaker.state(), 'open');
  assert.equal(await second.dispatcher.reportCloneFailure(report('conv-9', 'owner/c'), 'owner/c'), true);
  assert.equal(transition('closed', 'open'), 1);
  assert.equal(sent.length, 1);
});

test('the hand-over holds no URL, no token and no raw evidence', async () => {
  const { notifier, sent } = recording();
  const { dispatcher } = await build(notifier);
  await trip(dispatcher);
  const message = sent[0];
  const all = message.subject + '\n' + message.text + '\n' + (message.html ?? '');
  assert.doesNotMatch(all, /https?:\/\//i);
  assert.doesNotMatch(all, /\btoken\b/i);
  assert.doesNotMatch(all, /conv-|repository_not_found|clone_failed/);
});

test('the fixed clone breaker text exists in English and German', () => {
  for (const [language, word] of [['en', /paused/i], ['de', /pausiert/i]]) {
    const message = immediateMessage(language, 'handover', { repository: repo, number: 0, title: 'ForgeHands: new starts are paused', why: 'clone_breaker' });
    assert.match(message.subject, word);
    assert.match(message.text, word);
    assert.doesNotMatch(message.text, /https?:\/\//i);
  }
});
