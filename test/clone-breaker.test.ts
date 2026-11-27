// The clone breaker: its transitions, its durable ledger record and the recovery rules. The clock is the test's, so the ten-minute window,
// the hold and the trial deadline are exercised without waiting.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';
import { CLONE_BREAKER_HOLD_MS, CLONE_BREAKER_TRIAL_MS, CLONE_BREAKER_WINDOW_MS, CloneBreaker } from '../src/agent/clone-breaker.ts';
import type { CloneFailureReport } from '../src/agent/clone-breaker.ts';

let dir: string;
let file: string;
let clock: number;
const quiet = { error() {} };

const report = (conversation: string, repository = 'owner/a', failureClass: CloneFailureReport['class'] = 'clone_failed'): CloneFailureReport =>
  ({ class: failureClass, repository, conversation });

async function loaded(): Promise<{ jobs: JobStore; breaker: CloneBreaker }> {
  const jobs = new JobStore(file, quiet);
  await jobs.load();
  return { jobs, breaker: new CloneBreaker(jobs, () => clock, quiet) };
}

async function saved(): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'));
}

// Three distinct conversations across two repositories open the breaker at `clock`.
async function trip(breaker: CloneBreaker): Promise<void> {
  await breaker.reportFailure(report('conv-1', 'owner/a'));
  await breaker.reportFailure(report('conv-2', 'owner/a'));
  await breaker.reportFailure(report('conv-3', 'owner/b', 'repository_not_found'));
  assert.equal(breaker.snapshot().state, 'open');
}

// Open, wait out the hold, claim the one trial and give it its conversation.
async function admitted(breaker: CloneBreaker): Promise<number> {
  await trip(breaker);
  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(await breaker.admitTrial('owner/a#1:ai:ready'), true);
  assert.equal(await breaker.confirmTrial('owner/a#1:ai:ready', 'conv-trial'), true);
  return clock;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forgehands-clone-breaker-'));
  file = join(dir, 'jobs.json');
  clock = 1_700_000_000_000;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('a new breaker is closed and lets starts through', async () => {
  const { breaker } = await loaded();
  assert.equal(breaker.holds(), false);
  assert.equal(breaker.trialReady(), false);
  assert.deepEqual(breaker.snapshot(), { state: 'closed', since: null, retry_at: null, trial_until: null });
});

test('three conversations in one repository do not open the breaker', async () => {
  const { breaker } = await loaded();
  await breaker.reportFailure(report('conv-1', 'owner/a'));
  await breaker.reportFailure(report('conv-2', 'owner/a'));
  await breaker.reportFailure(report('conv-3', 'owner/a'));
  assert.equal(breaker.state(), 'closed');
});

test('three distinct conversations across two repositories open the breaker for the whole deployment', async () => {
  const { breaker } = await loaded();
  await trip(breaker);
  const snapshot = breaker.snapshot();
  assert.equal(snapshot.state, 'open');
  assert.equal(snapshot.since, clock);
  assert.equal(snapshot.retry_at, clock + CLONE_BREAKER_HOLD_MS);
  assert.equal(breaker.holds(), true);
  assert.equal(breaker.trialReady(), false);
});

test('a replayed conversation is counted once while it is eligible', async () => {
  const { breaker } = await loaded();
  assert.equal(await breaker.reportFailure(report('conv-1', 'owner/a')), true);
  assert.equal(await breaker.reportFailure(report('conv-1', 'owner/a')), false, 'the same report changes nothing');
  await breaker.reportFailure(report('conv-2', 'owner/a'));
  assert.equal(breaker.state(), 'closed', 'a replay is not a fourth conversation');
  await breaker.reportFailure(report('conv-3', 'owner/b'));
  assert.equal(breaker.state(), 'open');
});

test('failures older than ten minutes no longer count', async () => {
  const { breaker } = await loaded();
  await breaker.reportFailure(report('conv-1', 'owner/a'));
  clock += CLONE_BREAKER_WINDOW_MS + 1;
  await breaker.reportFailure(report('conv-2', 'owner/a'));
  await breaker.reportFailure(report('conv-3', 'owner/b'));
  assert.equal(breaker.state(), 'closed', 'only two failures are inside the window');
  await breaker.reportFailure(report('conv-4', 'owner/b'));
  assert.equal(breaker.state(), 'open');
});

test('the hold passes before exactly one half-open trial can be claimed', async () => {
  const { breaker } = await loaded();
  await trip(breaker);
  clock += CLONE_BREAKER_HOLD_MS - 1;
  assert.equal(breaker.holds(), true);
  assert.equal(breaker.trialReady(), false);
  assert.equal(await breaker.admitTrial('owner/a#1:ai:ready'), false, 'no trial while the hold lasts');

  clock += 1;
  assert.equal(breaker.trialReady(), true);
  assert.equal(breaker.holds(), true, 'other starts stay held during the trial');
  assert.equal(await breaker.admitTrial('owner/a#1:ai:ready'), true);
  assert.equal(await breaker.admitTrial('owner/a#2:ai:ready'), false, 'only one trial exists');
  assert.equal(await breaker.admitTrial('owner/a#1:ai:ready'), false, 'the claim is not taken twice');
  assert.equal(breaker.snapshot().state, 'half_open');
  assert.equal(breaker.snapshot().trial_until, clock + CLONE_BREAKER_TRIAL_MS);
});

test('only the trial conversation with positive checkout evidence closes and clears the breaker', async () => {
  const { jobs, breaker } = await loaded();
  const started = await admitted(breaker);
  assert.equal(await breaker.confirmTrial('owner/a#1:ai:ready', 'conv-late'), false, 'the trial has its conversation');
  assert.equal(await breaker.settleTrial('conv-1', 'checkout'), false, 'an arbitrary conversation cannot close it');
  assert.equal(breaker.snapshot().state, 'half_open');

  assert.equal(await breaker.settleTrial('conv-trial', 'checkout'), true);
  assert.deepEqual(breaker.snapshot(), { state: 'closed', since: null, retry_at: null, trial_until: null });
  assert.equal(breaker.holds(), false);
  const record = jobs.meta.clone_breaker!;
  assert.equal(record.state, 'closed');
  assert.deepEqual(record.failures, []);
  assert.ok(record.incident > 0, 'the incident counter stays for the next incident');
  assert.equal(started, clock, 'the trial was admitted at the end of the hold');
});

test('a failed or inconclusive trial reopens for the same incident and keeps the one notification claim', async () => {
  const { breaker } = await loaded();
  await trip(breaker);
  assert.equal(await breaker.claimNotification(), true);
  assert.equal(await breaker.claimNotification(), false, 'one notification per incident');

  clock += CLONE_BREAKER_HOLD_MS;
  await breaker.admitTrial('owner/a#1:ai:ready');
  await breaker.confirmTrial('owner/a#1:ai:ready', 'conv-trial');
  assert.equal(await breaker.settleTrial('conv-trial', 'failed'), true);
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().retry_at, clock + CLONE_BREAKER_HOLD_MS);
  assert.equal(await breaker.claimNotification(), false, 'a reopen does not notify again');

  clock += CLONE_BREAKER_HOLD_MS;
  await breaker.admitTrial('owner/a#1:ai:ready');
  await breaker.confirmTrial('owner/a#1:ai:ready', 'conv-trial-2');
  assert.equal(await breaker.settleTrial('conv-trial-2', 'inconclusive'), true);
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(await breaker.claimNotification(), false);
});

test('a trial without evidence by its deadline reopens, and time alone never closes the breaker', async () => {
  const { breaker } = await loaded();
  await trip(breaker);
  clock += CLONE_BREAKER_HOLD_MS;
  await breaker.admitTrial('owner/a#1:ai:ready');
  await breaker.confirmTrial('owner/a#1:ai:ready', 'conv-trial');

  clock += CLONE_BREAKER_TRIAL_MS;
  assert.equal(breaker.snapshot().state, 'open', 'a timed out trial is inconclusive, not a success');
  assert.equal(breaker.snapshot().trial_until, null);
  assert.equal(breaker.snapshot().retry_at, clock + CLONE_BREAKER_HOLD_MS);
  assert.equal(breaker.holds(), true);
  assert.equal(await breaker.settleTrial('conv-trial', 'checkout'), false, 'the expired trial can no longer report');

  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(breaker.trialReady(), true);
});

test('a failed start is abandoned without leaving a second trial behind', async () => {
  const { breaker } = await loaded();
  await trip(breaker);
  clock += CLONE_BREAKER_HOLD_MS;
  assert.equal(await breaker.admitTrial('owner/a#1:ai:ready'), true);
  assert.equal(await breaker.abandonTrial('owner/a#2:ai:ready'), false, 'only the owner releases its claim');
  assert.equal(await breaker.abandonTrial('owner/a#1:ai:ready'), true);
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().trial_until, null);
  assert.equal(breaker.trialReady(), false, 'another hold begins');
  assert.equal(await breaker.admitTrial('owner/a#2:ai:ready'), false);
});

test('a confirmed clone failure from the trial itself reopens instead of counting as checkout', async () => {
  const { breaker } = await loaded();
  await admitted(breaker);
  assert.equal(await breaker.reportFailure(report('conv-trial', 'owner/a')), true);
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().trial_until, null);
});

test('a report that is not normalized is refused', async () => {
  const { jobs, breaker } = await loaded();
  assert.equal(await breaker.reportFailure(report('conv-1', 'https://user:secret@forge.example/owner/a')), false, 'no credential URL');
  assert.equal(await breaker.reportFailure(report('conv-2', 'owner/a b')), false, 'no whitespace');
  assert.equal(await breaker.reportFailure(report('conv\n3', 'owner/a')), false, 'no control characters');
  assert.equal(await breaker.reportFailure({ class: 'raw clone output' as any, repository: 'owner/a', conversation: 'conv-4' }), false);
  assert.equal(jobs.meta.clone_breaker, undefined, 'nothing reaches the ledger');
  assert.equal(breaker.state(), 'closed');
});

test('the ledger keeps only the normalized evidence and no raw output', async () => {
  const { breaker } = await loaded();
  await breaker.reportFailure({ class: 'auth_failed', repository: 'Owner/A', conversation: 'conv-1' });
  const stored = (await saved()).meta.clone_breaker;
  assert.deepEqual(stored.failures, [{ class: 'auth_failed', repository: 'owner/a', conversation: 'conv-1', at: clock }]);
  assert.deepEqual(Object.keys(stored.failures[0]).sort(), ['at', 'class', 'conversation', 'repository']);
  assert.equal(JSON.stringify(stored).includes('clone http'), false);
});

test('a trip and the notification claim are durable without any job status change', async () => {
  const { jobs, breaker } = await loaded();
  assert.equal(jobs.list().length, 0);
  await trip(breaker);
  await breaker.claimNotification();
  const stored = await saved();
  assert.deepEqual(stored.jobs, []);
  assert.equal(stored.meta.clone_breaker.state, 'open');
  assert.equal(stored.meta.clone_breaker.notified, true);
  assert.equal(stored.meta.clone_breaker.failures.length, 3);
});

test('a real store round trip keeps the hold, the claim and the admitted trial', async () => {
  const first = await loaded();
  await trip(first.breaker);
  await first.breaker.claimNotification();
  clock += CLONE_BREAKER_HOLD_MS;
  const owner = 'owner/a#1:ai:ready';
  await first.breaker.admitTrial(owner);
  await first.breaker.confirmTrial(owner, 'conv-trial');
  const until = first.breaker.snapshot().trial_until;

  const second = await loaded();
  assert.equal(await second.breaker.hydrate(), false);
  assert.deepEqual(second.breaker.snapshot(), { state: 'half_open', since: clock - CLONE_BREAKER_HOLD_MS, retry_at: clock, trial_until: until });
  assert.equal(second.breaker.holds(), true);
  assert.equal(await second.breaker.claimNotification(), false, 'the claim survived the restart');

  assert.equal(await second.breaker.settleTrial('conv-trial', 'checkout'), true);
  const third = await loaded();
  assert.deepEqual(third.breaker.snapshot(), { state: 'closed', since: null, retry_at: null, trial_until: null });
});

test('an orphaned trial claim reopens on hydration and holds another trial for a full window', async () => {
  const first = await loaded();
  await trip(first.breaker);
  clock += CLONE_BREAKER_HOLD_MS;
  await first.breaker.admitTrial('owner/a#1:ai:ready');

  const second = await loaded();
  assert.equal(await second.breaker.hydrate(), true);
  assert.equal(second.breaker.snapshot().state, 'open');
  assert.equal(second.breaker.snapshot().retry_at, clock + CLONE_BREAKER_HOLD_MS);
  assert.equal(second.breaker.trialReady(), false);
  assert.equal(await second.breaker.admitTrial('owner/a#2:ai:ready'), false, 'never two trials');
  assert.equal((await saved()).meta.clone_breaker.state, 'open', 'the recovery is written at once');
});

test('an expired trial reopens on hydration instead of closing and never holds forever', async () => {
  const first = await loaded();
  await admitted(first.breaker);
  clock += CLONE_BREAKER_TRIAL_MS;

  const second = await loaded();
  assert.equal(await second.breaker.hydrate(), true);
  assert.equal(second.breaker.snapshot().state, 'open');
  assert.equal(second.breaker.snapshot().trial_until, null);
  assert.equal(second.breaker.snapshot().retry_at, clock + CLONE_BREAKER_HOLD_MS);
});

test('a corrupted trial deadline cannot hold the breaker forever', async () => {
  const first = await loaded();
  await trip(first.breaker);
  clock += CLONE_BREAKER_HOLD_MS;
  await first.breaker.admitTrial('owner/a#1:ai:ready');
  const data = await saved();
  data.meta.clone_breaker.trial.deadline = clock + 10 * 365 * 24 * 60 * 60_000;
  await writeFile(file, JSON.stringify(data));

  const second = await loaded();
  assert.equal(await second.breaker.hydrate(), true);
  assert.equal(second.breaker.snapshot().state, 'open');
  assert.equal(second.breaker.snapshot().retry_at, clock + CLONE_BREAKER_HOLD_MS);
});

test('a recovered incident needs a new trip before it notifies again', async () => {
  const { breaker } = await loaded();
  await admitted(breaker);
  await breaker.settleTrial('conv-trial', 'checkout');
  await trip(breaker);
  assert.equal(await breaker.claimNotification(), true);
  assert.equal(await breaker.claimNotification(), false);
});
