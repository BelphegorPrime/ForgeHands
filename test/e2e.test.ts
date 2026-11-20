// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The end-to-end suite (src/e2e) against a fake forge that stands in for ForgeHands: a worker opens a pull request for a ticket with the
// worker label, a reviewer approves it, and the merge lands on the default branch. Covered: pass, fail, timeout, cleanup after a failing
// step, off by default, the version trigger that runs once, the protected endpoint, the gauge, the status section and the notification.
// Also: every ticket of the built-in scenarios passes the real pre-flight, a pre-flight rejection fails a scenario at once, and the cleanup
// of a delivery that happened under another ticket (a sub-issue) closes the sub-issue and takes its file off main.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { parseScenario, type Scenario } from '../src/e2e/format.ts';
import { E2eController } from '../src/e2e/controller.ts';
import { cleanup, runClockOf, runScenario, runSuite, restoreBranch } from '../src/e2e/runner.ts';
import { ledgerOf } from '../src/e2e/controller.ts';
import { runTicketOf } from '../src/e2e/predicates.ts';
import { ForgejoForge } from '../src/forge/forgejo/index.ts';
import { SCENARIO_NAMES, SCENARIOS, selectScenarios } from '../src/e2e/scenarios.ts';
import { PREFLIGHT_REJECTION, ticketViolations } from '../src/agent/preflight.ts';
import { JobStore } from '../src/store/jobs.ts';
import { DeliveryStore } from '../src/store/deliveries.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { createApp } from '../src/server/app.ts';
import { metrics } from '../src/metrics.ts';

const quiet = { error() {}, log() {} };
const UUID = '11111111-1111-4111-8111-111111111111';
const base = {
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: 'owner/hello',
  FORGEJO_URL: 'http://forgejo.test:3000',
  FORGEJO_TOKEN: 't'.repeat(24),
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: UUID, tier: 'free' } }),
};
const withE2e = (extra = {}) => ({ ...base, E2E_REPO: 'owner/hello', ...extra });

const b64 = (text) => Buffer.from(text).toString('base64');
const unb64 = (text) => Buffer.from(text, 'base64').toString('utf8');

// A small Forgejo stand-in: issues and pull requests share one number space, branches point at commits, and each commit keeps a full
// snapshot of its files. `progress` runs before every call, so a test can play ForgeHands (or anything else) between the runner's calls.
class FakeForge {
  constructor() {
    this.issues = new Map();
    this.pulls = new Map();
    this.branches = new Map();
    this.commits = new Map();
    this.statuses = new Map();
    this.calls = [];
    this.number = 100;
    this.commitCount = 0;
    this.progress = () => {};
    this.commit(new Map([['README.md', 'hello']]));
    this.branches.set('main', this.lastCommit);
  }
  tick(name) { this.calls.push(name); this.progress(this, name); }
  commit(snapshot) {
    this.commitCount += 1;
    this.lastCommit = 'c' + this.commitCount;
    this.commits.set(this.lastCommit, snapshot);
    return this.lastCommit;
  }
  snapshotOf(ref) {
    const sha = this.branches.get(ref) ?? ref;
    const snapshot = this.commits.get(sha);
    if (!snapshot) throw new Error('GET ' + ref + ' -> HTTP 404');
    return snapshot;
  }
  // A commit on a new or existing branch made from `base` with some files changed.
  commitOn(branch, from, files) {
    const snapshot = new Map(this.snapshotOf(from));
    for (const [path, text] of Object.entries(files)) snapshot.set(path, text);
    this.branches.set(branch, this.commit(snapshot));
    return this.lastCommit;
  }
  openPull(head, title, issue) {
    const number = this.nextNumber();
    // pull_request is set as Forgejo sets it: its issue endpoint answers for pull requests too.
    const pr = { number, title, body: 'Closes #' + issue, state: 'open', merged: false, merged_at: null, merge_commit_sha: null, pull_request: {},
      head: { ref: head, sha: this.branches.get(head) }, labels: [], comments: [], updated_at: new Date().toISOString() };
    this.pulls.set(number, pr);
    return pr;
  }
  mergePull(number) {
    const pr = this.pulls.get(number);
    const tip = this.branches.get(pr.head.ref);
    this.branches.set('main', tip);
    Object.assign(pr, { state: 'closed', merged: true, merged_at: new Date().toISOString(), merge_commit_sha: tip });
  }
  nextNumber() { this.number += 1; return this.number; }
  entry(number) {
    const entry = this.issues.get(number) ?? this.pulls.get(number);
    if (!entry) throw new Error('GET #' + number + ' -> HTTP 404');
    return entry;
  }

  getRepository() { this.tick('getRepository'); return { default_branch: 'main' }; }
  branchTip(_, branch) { this.tick('branchTip'); return this.branches.get(branch) ?? null; }
  commitStatus(_, sha) { this.tick('commitStatus'); return { state: this.statuses.get(sha) ?? 'success', total_count: 1 }; }
  compare(_, base, head) {
    this.tick('compare');
    const from = this.snapshotOf(base);
    const to = this.snapshotOf(head);
    const paths = new Set([...from.keys(), ...to.keys()]);
    return { files: [...paths].filter((path) => from.get(path) !== to.get(path)).map((filename) => ({ filename })) };
  }
  createIssue(_, title, body) {
    this.tick('createIssue');
    const number = this.nextNumber();
    const issue = { number, title, body, state: 'open', labels: [], comments: [], html_url: null };
    this.issues.set(number, issue);
    return issue;
  }
  getIssue(_, number) { this.tick('getIssue'); return this.entry(number); }
  closeIssue(_, number) { this.tick('closeIssue'); this.entry(number).state = 'closed'; }
  reopenIssue(_, number) { this.tick('reopenIssue'); this.entry(number).state = 'open'; }
  listComments(_, number) { this.tick('listComments'); return this.entry(number).comments.map((body) => ({ body, created_at: '' })); }
  addComment(_, number, body) { this.tick('addComment'); this.entry(number).comments.push(body); }
  findOrCreateLabel(_, name) { this.tick('findOrCreateLabel'); return { id: name, name }; }
  addLabels(_, number, labels) {
    this.tick('addLabels');
    const entry = this.entry(number);
    for (const label of labels) if (!entry.labels.some((known) => known.name === label.name)) entry.labels.push({ id: label.id, name: label.name });
  }
  getPull(_, number) {
    this.tick('getPull');
    const pr = this.pulls.get(number);
    if (!pr) throw new Error('GET #' + number + ' -> HTTP 404');
    return pr;
  }
  listPulls(_, { state, limit, page = 1 }) {
    this.tick('listPulls');
    const all = [...this.pulls.values()].filter((pr) => state === 'all' || pr.state === state).sort((a, b) => b.number - a.number);
    return all.slice((page - 1) * limit, page * limit);
  }
  closePull(_, number) { this.tick('closePull'); this.pulls.get(number).state = 'closed'; }
  listBranches() { this.tick('listBranches'); return [...this.branches].map(([name, sha]) => ({ name, sha })); }
  deleteBranch(_, name) {
    this.tick('deleteBranch');
    if (name === 'main') throw new Error('DELETE main -> HTTP 403');
    this.branches.delete(name);
  }
  readFile(_, path, ref) {
    this.tick('readFile');
    const text = this.snapshotOf(ref).get(path);
    return text === undefined ? null : { sha: 'blob:' + text, content: b64(text) };
  }
  writeFile(_, path, { branch, content, sha }) {
    this.tick('writeFile');
    const snapshot = new Map(this.snapshotOf(branch));
    const current = snapshot.get(path);
    if (sha && (current === undefined || 'blob:' + current !== sha)) throw new Error('PUT ' + path + ' -> HTTP 409');
    if (!sha && current !== undefined) throw new Error('POST ' + path + ' -> HTTP 422');
    snapshot.set(path, unb64(content));
    this.branches.set(branch, this.commit(snapshot));
    return this.lastCommit;
  }
  deleteFile(_, path, { branch, sha }) {
    this.tick('deleteFile');
    const snapshot = new Map(this.snapshotOf(branch));
    if (!snapshot.has(path) || 'blob:' + snapshot.get(path) !== sha) throw new Error('DELETE ' + path + ' -> HTTP 409');
    snapshot.delete(path);
    this.branches.set(branch, this.commit(snapshot));
    return this.lastCommit;
  }
}

// The ForgeHands stand-in: a ticket with the worker label gets a branch and a pull request, the reviewer approves it on the next look, and
// the merge lands on the default branch and closes the ticket.
function forgeHands(text = 'delivered', file = 'e2e/delivery.txt') {
  const stage = new Map();
  return (forge) => {
    for (const issue of forge.issues.values()) {
      if (issue.state !== 'open' || !issue.labels.some((label) => label.name === 'ai:ready')) continue;
      const current = stage.get(issue.number);
      if (!current) {
        const head = 'ai/issue-' + issue.number;
        forge.commitOn(head, 'main', { [file]: text });
        stage.set(issue.number, { pr: forge.openPull(head, 'WIP: ' + issue.title, issue.number).number, stage: 'open' });
      } else if (current.stage === 'open') {
        forge.pulls.get(current.pr).comments.push('Verdict: OK\n' + 'Evidence: the file is there and reads delivered. '.repeat(8));
        current.stage = 'reviewed';
      } else if (current.stage === 'reviewed') {
        forge.mergePull(current.pr);
        issue.state = 'closed';
        current.stage = 'merged';
      }
    }
  };
}

// No real sleeping: the fake answers at once, so a poll or a settle only has to yield.
// The ledger of a test: the runs of the tickets, as the port reports them. `onSync` runs before every read (a test plays ForgeHands there).
class FakeLedger {
  constructor() { this.jobs = []; this.dropped = []; this.onSync = () => {}; }
  runsOf(_, issue, label) {
    return this.runsStateOf(null, issue).filter((run) => (label === undefined || run.label === label) && (run.started !== undefined || ['running', 'done', 'failed'].includes(run.status))).length;
  }
  runsStateOf(_, issue) {
    this.onSync(this);
    return this.jobs.filter((job) => job.issue === issue).map((job) => ({ label: job.label, status: job.status, created: job.created,
      ...(job.started === undefined ? {} : { started: job.started }), ...(job.finished === undefined ? {} : { finished: job.finished }), ahead: 0 }));
  }
  async dropQueued(_, issue) {
    let dropped = 0;
    for (const job of this.jobs) if (job.issue === issue && (job.status === 'queued' || job.status === 'waiting')) { job.status = 'deleted'; dropped += 1; }
    this.dropped.push(issue);
    return dropped;
  }
}

const runOptions = (forge, extra = {}) => ({ repository: 'owner/hello', forge, ledger: new FakeLedger(), timeoutMs: 5000, pollMs: 1, sleep: async () => {}, ...extra });
const scenario = (steps, extra = {}) => parseScenario({ name: 'probe', title: 'Probe', description: 'test', experimental: false, precondition: null, steps, ...extra });
const ticketStep = { do: 'ticket', as: 'ticket', title: 'T', body: 'B', label: 'ai:ready' };

test('a scenario that holds passes, and its cleanup leaves the repository as it was', async () => {
  const forge = new FakeForge();
  forge.progress = forgeHands();
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', as: 'pr', for: { findPull: 'ai/issue-$ticket' } },
    { do: 'wait', for: { pull: '$pr', state: 'merged' } },
    { do: 'assert', that: { pull: '$pr', comment: { contains: 'Verdict: OK' } } },
    { do: 'wait', for: { issue: '$ticket', state: 'closed' } },
  ]), runOptions(forge));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.cleanup, 'ok');
  assert.equal(result.failed_step, null);
  // The merge put the file on main; the cleanup took it off again, and the branch of the ticket is gone.
  assert.equal(forge.readFile(null, 'e2e/delivery.txt', 'main'), null);
  assert.deepEqual([...forge.branches.keys()].filter((name) => name.startsWith('ai/')), []);
});

test('a failing assert fails the scenario at its step, and the cleanup still runs', async () => {
  const forge = new FakeForge();
  forge.progress = forgeHands();
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', as: 'pr', for: { findPull: 'ai/issue-$ticket' } },
    { do: 'assert', that: { issue: '$ticket', hasLabel: 'never' }, message: 'label check' },
  ]), runOptions(forge));
  assert.equal(result.ok, false);
  assert.equal(result.failed_step, 2);
  assert.match(result.reason, /step 3 \(assert issue\): label check: #\d+: no label never/);
  assert.equal(result.cleanup, 'ok');
  assert.equal([...forge.issues.values()][0].state, 'closed');
});

test('a timed out wait fails with the last state it saw, and the cleanup closes the ticket', async () => {
  const forge = new FakeForge();
  const started = Date.now();
  const result = await runScenario(scenario([ticketStep, { do: 'wait', for: { findPull: 'ai/never' } }]), runOptions(forge, { timeoutMs: 120, pollMs: 5 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out; last seen: no pull request from ai\/never/);
  assert.ok(Date.now() - started < 5000, 'the scenario must end near its timeout');
  assert.equal([...forge.issues.values()][0].state, 'closed');
});

test('cleanup after a failing step closes the pull request and the ticket, deletes the branch and resets main', async () => {
  const forge = new FakeForge();
  const sim = forgeHands();
  let strayDone = false;
  forge.progress = (f, name) => {
    sim(f);
    // Someone else moves the default branch while the scenario runs: the cleanup must put it back to the commit of the start.
    if (!strayDone && f.pulls.size && name === 'listPulls') {
      strayDone = true;
      f.commitOn('main', 'main', { 'e2e/stray.txt': 'not ours' });
    }
  };
  const baseline = forge.branches.get('main');
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', for: { findPull: 'ai/issue-$ticket' } },
    { do: 'assert', that: { issue: '$ticket', hasLabel: 'never' } },
  ]), runOptions(forge));
  assert.equal(result.ok, false);
  assert.equal(result.cleanup, 'ok', result.cleanup_reason);
  // restoreBranch changes nothing when main already has the tree of the start.
  assert.equal((await restoreBranch(forge, 'owner/hello', 'main', baseline)).changed, 0, 'main has the tree of the start');
  assert.equal(forge.readFile(null, 'e2e/stray.txt', 'main'), null);
  assert.equal([...forge.pulls.values()].every((pr) => pr.state === 'closed'), true);
  assert.equal([...forge.branches.keys()].filter((name) => name.startsWith('ai/')).length, 0);
});

test('a cleanup that cannot delete a branch fails the cleanup, not the scenario: the steps held and say so', async () => {
  const forge = new FakeForge();
  forge.progress = forgeHands();
  forge.deleteBranch = () => { throw new Error('DELETE branch -> HTTP 500'); };
  const result = await runScenario(scenario([ticketStep, { do: 'wait', for: { findPull: 'ai/issue-$ticket' } }]), runOptions(forge));
  assert.equal(result.reason, null, 'the steps held');
  assert.equal(result.ok, true, 'ok is the steps');
  assert.equal(result.cleanup, 'failed');
  assert.match(result.cleanup_reason, /delete branch ai\/issue-\d+: DELETE branch -> HTTP 500/);
});

test('a run of the suite goes on with the next scenario after a failure', async () => {
  const forge = new FakeForge();
  forge.progress = forgeHands();
  const results = await runSuite([
    scenario([{ do: 'assert', that: { branch: 'default', status: 'failure' } }], { name: 'first' }),
    scenario([{ do: 'assert', that: { branch: 'default', status: 'success' } }], { name: 'second' }),
  ], runOptions(forge));
  assert.deepEqual(results.map((result) => [result.scenario, result.ok]), [['first', false], ['second', true]]);
});

test('the built-in scenarios load, the experimental ones are left out by default, and E2E_SCENARIOS can name them', () => {
  assert.deepEqual(SCENARIO_NAMES, ['normal-delivery', 'revert-on-red', 'empty-runs', 'stuck-pull-request', 'conflict-round']);
  assert.deepEqual(selectScenarios(null).map((entry) => entry.name), ['normal-delivery', 'revert-on-red']);
  assert.deepEqual(selectScenarios(['conflict-round', 'normal-delivery']).map((entry) => entry.name), ['conflict-round', 'normal-delivery']);
});

test('the format rejects a reference to a value no earlier step sets, and an experimental scenario without a precondition', () => {
  assert.throws(() => parseScenario({ name: 'bad', title: 't', description: 'd', steps: [{ do: 'assert', that: { issue: '$ticket', state: 'open' } }] }),
    /refers to \$ticket, which no earlier step sets/);
  assert.throws(() => parseScenario({ name: 'bad', title: 't', description: 'd', experimental: true, steps: [{ do: 'settle', seconds: 1 }] }), /needs a precondition/);
  assert.throws(() => parseScenario({ name: 'bad', title: 't', description: 'd', steps: [{ do: 'wait', as: 'x', for: { issue: '1' } }] }), /only a findPull wait captures/);
  assert.throws(() => parseScenario({ name: 'bad', title: 't', description: 'd', steps: [{ do: 'wait', for: { issue: '1', pull: '2' } }] }), /exactly one of/);
  assert.throws(() => parseScenario({ name: 'Bad Name', title: 't', description: 'd', steps: [{ do: 'settle', seconds: 1 }] }), /lower case/);
});

test('the suite is off by default: no repository, no start, no run at a start, and the endpoint does not exist', async () => {
  const config = loadConfig(base, quiet);
  assert.equal(config.e2e.repository, null);
  assert.equal(config.e2e.onStart, false);
  assert.equal(config.e2e.scenarios, null);
  assert.equal(config.e2e.timeoutMinutes, 90);
  const forge = new FakeForge();
  const jobs = new JobStore(join(await mkdtemp(join(tmpdir(), 'e2e-off-')), 'jobs.json'));
  const controller = new E2eController({ config, forge, jobs, notifier: { wants: () => true, notify() {} }, version: '1.0.0', logger: quiet });
  assert.equal(controller.start('manual').status, 'off');
  assert.equal(controller.onStart().status, 'skipped');
  assert.equal(forge.calls.length, 0, 'nothing was asked of the forge');
  assert.equal(controller.state(), null);
});

test('E2E_* values are validated: a repository outside ALLOWED_REPOS, an unknown scenario, on start without a repository', () => {
  assert.throws(() => loadConfig(withE2e({ E2E_REPO: 'owner/other' }), quiet), /E2E_REPO owner\/other is not in ALLOWED_REPOS/);
  assert.throws(() => loadConfig(withE2e({ E2E_SCENARIOS: 'normal-delivery,nope' }), quiet), /E2E_SCENARIOS: nope is no scenario/);
  assert.throws(() => loadConfig({ ...base, E2E_ON_START: '1' }, quiet), /E2E_ON_START=1 needs E2E_REPO/);
  assert.throws(() => loadConfig(withE2e({ E2E_ON_START: 'yes' }), quiet), /E2E_ON_START must be 0 or 1/);
  assert.throws(() => loadConfig(withE2e({ E2E_TIMEOUT_MINUTES: '0' }), quiet), /E2E_TIMEOUT_MINUTES must be an integer/);
  const config = loadConfig(withE2e({ E2E_ON_START: '1', E2E_SCENARIOS: 'conflict-round', E2E_TIMEOUT_MINUTES: '45' }), quiet);
  assert.deepEqual(config.e2e, { repository: 'owner/hello', onStart: true, scenarios: ['conflict-round'], timeoutMinutes: 45, queueMinutes: 60 });
  assert.equal(loadConfig(withE2e({ E2E_QUEUE_MINUTES: '30' }), quiet).e2e.queueMinutes, 30);
  assert.throws(() => loadConfig(withE2e({ E2E_QUEUE_MINUTES: '0' }), quiet), /E2E_QUEUE_MINUTES must be an integer/);
});

test('every ticket of every built-in scenario passes the real ticket pre-flight, the experimental ones too', async () => {
  // Every file a ticket lists counts as missing here, so a file that is not marked "new" is a violation as well.
  const neverExists = async () => false;
  let tickets = 0;
  for (const entry of SCENARIOS) {
    for (const step of entry.steps) {
      if (step.do !== 'ticket') continue;
      tickets++;
      const violations = await ticketViolations(step.body, neverExists);
      assert.deepEqual(violations, [], entry.name + ', ticket ' + step.as + ': ' + violations.map((v) => 'rule ' + v.rule + ': ' + v.text).join('; '));
    }
  }
  assert.ok(tickets >= 6, 'the scenarios have their tickets: ' + tickets);
});

test('the pre-flight check is live: the bodies of the first version of the scenarios are rejected (no sections, no command)', async () => {
  const oldBody = 'Create the file e2e/delivery.txt with the single line "delivered". Change nothing else.';
  const violations = await ticketViolations(oldBody);
  assert.deepEqual(violations.map((v) => v.rule), [2]);
});

test('a ticket the pre-flight rejects fails the scenario at once with preflight_rejected, and the cleanup still runs', async () => {
  const forge = new FakeForge();
  forge.progress = (fake) => {
    // The bot's comment as ForgeHands writes it: a mention in front when no SPLIT_LABEL is set, then the rule that failed.
    for (const issue of fake.issues.values()) {
      if (!issue.labels.some((label) => label.name === 'ai:ready') || issue.comments.some((body) => body.includes(PREFLIGHT_REJECTION))) continue;
      issue.comments.push('@human ' + PREFLIGHT_REJECTION + ', so no worker starts on it:\n- rule 2: the ticket has no Acceptance section with a fenced command block\n'
        + 'A human has to fix the ticket and set its label again.');
    }
  };
  const started = Date.now();
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', as: 'pr', for: { findPull: 'ai/issue-$ticket' } },
    { do: 'wait', for: { pull: '$pr', state: 'merged' } },
  ]), runOptions(forge, { timeoutMs: 60000 }));
  assert.equal(result.ok, false);
  assert.equal(result.failed_step, 1);
  assert.match(result.reason, /^step 2 \(wait for findPull\): preflight_rejected: ticket #\d+ breaks the pre-flight, so no worker starts on it \(rule 2: the ticket has no Acceptance/);
  assert.ok(Date.now() - started < 5000, 'the scenario ends at once, not at its timeout');
  assert.equal(result.cleanup, 'ok', result.cleanup_reason);
  assert.equal([...forge.issues.values()][0].state, 'closed');
});

test('a wait for a pull request has a default timeout of 20 minutes; the other waits keep the rest of the scenario time', () => {
  const parsed = scenario([
    ticketStep,
    { do: 'wait', as: 'pr', for: { findPull: 'ai/issue-$ticket' } },
    { do: 'wait', as: 'explicit', for: { findPull: 'ai/other' }, timeoutMinutes: 30 },
    { do: 'wait', for: { pull: '$pr', state: 'merged' } },
  ]);
  assert.equal(parsed.steps[1].timeoutMinutes, 20);
  assert.equal(parsed.steps[2].timeoutMinutes, 30);
  assert.equal(parsed.steps[3].timeoutMinutes, undefined);
});

test('the cleanup of a delivery under another ticket closes the sub-issue and its pull request, deletes its branch and takes the file off main', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  // The run's ticket (101) was split by the planner into a sub-issue (102); its pull request (103) merged the file onto main.
  const ticket = forge.createIssue('owner/hello', 'E2E normal delivery', 'B');
  const sub = forge.createIssue('owner/hello', 'E2E normal delivery, part', 'B');
  forge.commitOn('ai/issue-' + sub.number, 'main', { 'e2e/delivery.txt': 'delivered' });
  const pr = forge.openPull('ai/issue-' + sub.number, 'E2E normal delivery, part', sub.number);
  forge.mergePull(pr.number);
  assert.equal(forge.readFile(null, 'e2e/delivery.txt', 'main') !== null, true, 'the delivery is on main');

  const { problem, note } = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline });
  assert.equal(problem, null);
  assert.equal(note, null);
  assert.equal(sub.state, 'closed', 'the sub-issue is closed');
  assert.equal(ticket.state, 'closed', 'the run ticket is closed');
  assert.equal(forge.pulls.get(pr.number).merged, true, 'the merged pull request stays as it is');
  assert.deepEqual([...forge.branches.keys()].filter((name) => name.startsWith('ai/')), [], 'the branch of the sub-issue is deleted');
  assert.equal(forge.readFile(null, 'e2e/delivery.txt', 'main'), null, 'main has the tree of the start again');
  assert.equal((await restoreBranch(forge, 'owner/hello', 'main', baseline)).changed, 0);
});

// A file the fake cannot read as a regular file (a symlink, a submodule): the real Forgejo readFile throws for those.
function linkEntries(forge) {
  const readFile = forge.readFile.bind(forge);
  forge.readFile = (repository, path, ref) => {
    const text = forge.snapshotOf(ref).get(path);
    if (text === '@@link') throw new Error('GET /contents/' + path + ' at ' + ref.slice(0, 8) + ': not a regular file (symlink)');
    return readFile(repository, path, ref);
  };
}

test('restore: a commit that lands while the restore runs is caught by the next pass and put back', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/delivery.txt': 'delivered', 'e2e/red.marker': '' });
  let landed = false;
  // Another commit lands on main while the first write of the restore is on its way: after the compare of the pass.
  forge.progress = (f, name) => {
    if ((name === 'writeFile' || name === 'deleteFile') && !landed) { landed = true; f.commitOn('main', 'main', { 'e2e/late.txt': 'late' }); }
  };
  const touched = new Set(['e2e/delivery.txt', 'e2e/red.marker', 'e2e/late.txt']);
  const result = await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched, sleep: async () => {}, waitMs: 0 });
  assert.equal(landed, true);
  assert.equal(result.changed >= 3, true, 'the delivery, the marker and the late file are restored');
  assert.deepEqual(result.untouched, []);
  assert.equal(forge.readFile(null, 'e2e/late.txt', 'main'), null);
  assert.equal(forge.readFile(null, 'e2e/delivery.txt', 'main'), null);
});

test('restore: a path the restore cannot read is left alone when the run did not touch it, and fails the restore when it did', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/link': '@@link' });
  linkEntries(forge);
  const relaxed = await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(), sleep: async () => {}, waitMs: 0 });
  assert.deepEqual(relaxed.untouched, ['e2e/link'], 'a difference of the run only is the run\'s concern');
  await assert.rejects(restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/link']), sleep: async () => {}, waitMs: 0 }),
    /main still differs from \S+ in 1 file\(s\) of the run: e2e\/link$/);
  // Without a set of the run's paths every difference counts.
  await assert.rejects(restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: null, sleep: async () => {}, waitMs: 0 }), /e2e\/link/);
});

test('restore: a trailing newline, a deleted file and a file that did not exist at the start are all put back, the contents exactly', async () => {
  const forge = new FakeForge();
  forge.commitOn('main', 'main', { 'e2e/keep.txt': 'keep' });
  const baseline = forge.branches.get('main');
  // The run: a trailing newline added to README, the kept file deleted, a new file created.
  forge.commitOn('main', 'main', { 'README.md': 'hello\n' });
  const snapshot = new Map(forge.snapshotOf('main'));
  snapshot.delete('e2e/keep.txt');
  snapshot.set('e2e/new.txt', 'created');
  forge.branches.set('main', forge.commit(snapshot));
  const touched = new Set(['README.md', 'e2e/keep.txt', 'e2e/new.txt']);
  const result = await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched, sleep: async () => {} });
  assert.equal(result.changed, 3);
  assert.equal(forge.readFile(null, 'README.md', 'main').content, b64('hello'), 'the bytes of the start, no newline added or lost');
  assert.equal(forge.readFile(null, 'e2e/keep.txt', 'main').content, b64('keep'), 'the deleted file is written back');
  assert.equal(forge.readFile(null, 'e2e/new.txt', 'main'), null);
  assert.equal((await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched })).changed, 0);
});

test('cleanup: a stray the run did not touch is left alone with a note; the same stray in a path the run touched fails the cleanup and names it', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  const ticket = forge.createIssue('owner/hello', 'E2E normal delivery', 'B');
  // The run's branch changes e2e/delivery.txt; a stray on main has an unreadable entry at e2e/link.
  forge.commitOn('ai/issue-' + ticket.number, 'main', { 'e2e/delivery.txt': 'delivered' });
  forge.commitOn('main', 'main', { 'e2e/link': '@@link' });
  linkEntries(forge);
  const relaxed = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline }, { sleep: async () => {} });
  assert.equal(relaxed.problem, null, 'the cleanup holds');
  assert.match(relaxed.note, /main still differs from \S+ in 1 file\(s\) the run did not touch, left alone: e2e\/link/);

  const again = new FakeForge();
  const base2 = again.branches.get('main');
  const ticket2 = again.createIssue('owner/hello', 'E2E normal delivery', 'B');
  again.commitOn('ai/issue-' + ticket2.number, 'main', { 'e2e/link': '@@link' });
  again.commitOn('main', 'main', { 'e2e/link': '@@link' });
  linkEntries(again);
  const failed = await cleanup('owner/hello', again, { tickets: [ticket2.number], defaultBranch: 'main', baseline: base2 }, { sleep: async () => {} });
  assert.match(failed.problem, /^reset main: main still differs from \S+ in 1 file\(s\) of the run: e2e\/link$/);
  assert.equal(failed.note, null);
});

test('forgejo readFile: a regular file reads, a missing one is null, while a symlink or a file without content throws (never written back as "")', async () => {
  const answer = (entry) => new ForgejoForge(async () => entry);
  const missing = new ForgejoForge(async () => { throw new Error('GET /contents/x -> HTTP 404'); });
  assert.equal(await missing.readFile('owner/hello', 'x', 'main'), null);
  assert.deepEqual(await answer({ type: 'file', sha: 'abc', content: 'aGk=' }).readFile('owner/hello', 'x', 'main'), { sha: 'abc', content: 'aGk=' });
  await assert.rejects(answer({ type: 'symlink', sha: 'abc', content: '' }).readFile('owner/hello', 'x', 'main'), /not a regular file \(symlink\)/);
  await assert.rejects(answer({ type: 'file', sha: 'abc' }).readFile('owner/hello', 'x', 'main'), /no content/);
});

test('forgejo writeFile and deleteFile answer the id of the commit they made (the restore verifies at that commit), null when the answer names none', async () => {
  const methods = [];
  const forge = new ForgejoForge(async (_, method) => { methods.push(method); return { content: null, commit: { sha: 'c9f0e1' } }; });
  assert.equal(await forge.writeFile('owner/hello', 'e2e/a.txt', { message: 'm', branch: 'main', content: 'aGk=' }), 'c9f0e1');
  assert.equal(await forge.writeFile('owner/hello', 'e2e/a.txt', { message: 'm', branch: 'main', content: 'aGk=', sha: 'abc' }), 'c9f0e1');
  assert.equal(await forge.deleteFile('owner/hello', 'e2e/a.txt', { message: 'm', branch: 'main', sha: 'abc' }), 'c9f0e1');
  assert.deepEqual(methods, ['POST', 'PUT', 'DELETE']);
  assert.equal(await new ForgejoForge(async () => ({})).deleteFile('owner/hello', 'e2e/a.txt', { message: 'm', branch: 'main', sha: 'abc' }), null);
});

// A controller over a ledger file of its own, for the trigger tests.
async function controllerFor(env, version, { scenarios, file, sent = [] } = {}) {
  const config = loadConfig(env, quiet);
  const forge = new FakeForge();
  forge.progress = forgeHands();
  const jobs = new JobStore(file);
  await jobs.load();
  const notifier = { wants: () => true, notify: (message, repository) => sent.push({ message, repository }) };
  const controller = new E2eController({ config, forge, jobs, notifier, version, logger: quiet, scenarios, pollMs: 1, sleep: async () => {}, now: () => 1000 });
  return { controller, forge, jobs, sent };
}

test('with E2E_ON_START the suite runs once per version: a restart of the same version runs nothing, a new version runs again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-version-'));
  const file = join(dir, 'jobs.json');
  try {
    const smoke = [scenario([{ do: 'assert', that: { branch: 'default', status: 'success' } }], { name: 'smoke' })];
    const env = withE2e({ E2E_ON_START: '1' });
    const first = await controllerFor(env, '0.9.8', { scenarios: smoke, file });
    const started = first.controller.onStart();
    assert.equal(started.status, 'started');
    await started.done;
    assert.equal(first.jobs.meta.e2e.version, '0.9.8', 'the version is recorded in the ledger');
    assert.equal(first.controller.onStart().status, 'skipped', 'the same process does not start it again for the same version');

    const restarted = await controllerFor(env, '0.9.8', { scenarios: smoke, file });
    assert.equal(restarted.controller.onStart().status, 'skipped', 'a restart of the same version does not run the suite again');

    const upgraded = await controllerFor(env, '0.9.9', { scenarios: smoke, file });
    const again = upgraded.controller.onStart();
    assert.equal(again.status, 'started');
    await again.done;
    assert.equal(upgraded.jobs.meta.e2e.version, '0.9.9');
    assert.equal((await controllerFor(env, '0.9.9', { scenarios: smoke, file })).controller.onStart().status, 'skipped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failing scenario sends a notification of kind failed, and the gauge shows each scenario of the last run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-gauge-'));
  try {
    const sent = [];
    const scenarios = [
      scenario([{ do: 'assert', that: { branch: 'default', status: 'success' } }], { name: 'smoke' }),
      scenario([{ do: 'assert', that: { branch: 'default', status: 'failure' }, message: 'expected red' }], { name: 'broken' }),
    ];
    const { controller, jobs } = await controllerFor(withE2e(), '1.0.0', { scenarios, file: join(dir, 'jobs.json'), sent });
    const started = controller.start('manual');
    await started.done;
    const messages = sent.filter((entry) => entry.message.kind === 'failed');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.subject, '[e2e] broken failed');
    assert.equal(messages[0].repository, 'owner/hello');
    assert.match(messages[0].message.text, /expected red/);
    const samples = controller.gauges();
    assert.deepEqual(samples.filter((sample) => sample.name === 'forgehands_e2e_scenario_ok').map((sample) => [sample.labels.scenario, sample.value]),
      [['smoke', 1], ['broken', 0]]);
    assert.deepEqual(samples.filter((sample) => sample.name === 'forgehands_e2e_cleanup_ok').map((sample) => [sample.labels.scenario, sample.value]),
      [['smoke', 1], ['broken', 1]]);
    const page = metrics.render(samples);
    assert.match(page, /forgehands_e2e_scenario_ok\{scenario="smoke"\} 1/);
    assert.match(page, /forgehands_e2e_scenario_ok\{scenario="broken"\} 0/);
    assert.match(page, /forgehands_e2e_cleanup_ok\{scenario="broken"\} 1/);
    const state = controller.state();
    assert.equal(state.running, null);
    assert.equal(state.last.trigger, 'manual');
    assert.deepEqual(state.last.results.map((result) => [result.scenario, result.ok]), [['smoke', true], ['broken', false]]);
    // The ledger keeps the record: a new controller over the same file shows the same gauge.
    const reloaded = new JobStore(join(dir, 'jobs.json'));
    await reloaded.load();
    assert.equal(reloaded.meta.e2e.results.length, 2);
    assert.equal(jobs.meta.e2e.results[1].ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed cleanup with held steps: scenario_ok stays 1, cleanup_ok is 0, and the notification says the cleanup failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-cleanup-gauge-'));
  try {
    const sent = [];
    // A ticket, so that the cleanup has a branch to delete (and fails to).
    const scenarios = [scenario([ticketStep, { do: 'wait', for: { findPull: 'ai/issue-$ticket' } }], { name: 'smoke' })];
    const { controller, forge } = await controllerFor(withE2e(), '1.0.0', { scenarios, file: join(dir, 'jobs.json'), sent });
    forge.deleteBranch = () => { throw new Error('DELETE branch -> HTTP 500'); };
    await controller.start('manual').done;
    const samples = controller.gauges();
    assert.deepEqual(samples.map((sample) => [sample.name, sample.value]), [['forgehands_e2e_scenario_ok', 1], ['forgehands_e2e_cleanup_ok', 0]]);
    const messages = sent.filter((entry) => entry.message.kind === 'failed');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.subject, '[e2e] smoke: cleanup failed');
    assert.match(messages[0].message.text, /held on owner\/hello .*but its cleanup did not hold: delete branch ai\/issue-\d+: DELETE branch -> HTTP 500/);
    const state = controller.state();
    assert.deepEqual(state.last.results.map((result) => [result.ok, result.cleanup]), [[true, 'failed']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second start while a run is going is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-busy-'));
  try {
    const scenarios = [scenario([{ do: 'settle', seconds: 1 }], { name: 'slow' })];
    const { controller } = await controllerFor(withE2e(), '1.0.0', { scenarios, file: join(dir, 'jobs.json') });
    const first = controller.start('manual');
    assert.equal(first.status, 'started');
    assert.equal(controller.start('manual').status, 'busy');
    await first.done;
    assert.equal(controller.start('manual').status, 'started');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the endpoint /e2e/run needs the STATUS_TOKEN bearer token: 404 without E2E_REPO, 403 without the token, 401 otherwise, 202 with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-endpoint-'));
  const token = 'status-token-of-sixteen-plus-chars';
  const servers = [];
  const serve = async (env) => {
    const config = loadConfig(env, quiet);
    const store = new DeliveryStore(join(dir, 'deliveries.json'));
    const jobs = new JobStore(join(dir, 'jobs-' + servers.length + '.json'));
    await jobs.load();
    const dispatcher = new Dispatcher(config, jobs, async () => { throw new Error('no network'); }, quiet, () => 1000);
    const forge = new FakeForge();
    forge.progress = forgeHands();
    const e2e = config.e2e.repository
      ? new E2eController({ config, forge, jobs, notifier: { wants: () => false, notify() {} }, version: '1.0.0', logger: quiet, pollMs: 1, sleep: async () => {},
          scenarios: [scenario([{ do: 'assert', that: { branch: 'default', status: 'success' } }], { name: 'smoke' })] })
      : null;
    const server = createApp(config, store, async () => { throw new Error('no network'); }, quiet, dispatcher, e2e);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { url: 'http://127.0.0.1:' + server.address().port, e2e };
  };
  try {
    const off = await serve({ ...base, STATUS_TOKEN: token });
    assert.equal((await fetch(off.url + '/e2e/run', { method: 'POST' })).status, 404);

    const noToken = await serve(withE2e());
    assert.equal((await fetch(noToken.url + '/e2e/run', { method: 'POST' })).status, 403);

    const guarded = await serve(withE2e({ STATUS_TOKEN: token }));
    assert.equal((await fetch(guarded.url + '/e2e/run')).status, 404, 'only POST starts a run');
    assert.equal((await fetch(guarded.url + '/e2e/run', { method: 'POST' })).status, 401);
    assert.equal((await fetch(guarded.url + '/e2e/run', { method: 'POST', headers: { authorization: 'Bearer wrong-token-of-sixteen-chars' } })).status, 401);
    // The session cookie of the status page is not enough for a run that changes the test repository.
    assert.equal((await fetch(guarded.url + '/e2e/run', { method: 'POST', headers: { cookie: 'x=1' } })).status, 401);
    const accepted = await fetch(guarded.url + '/e2e/run', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    assert.equal(accepted.status, 202);
    assert.deepEqual((await accepted.json()).scenarios, ['smoke']);
    while (guarded.e2e.state().running) await new Promise((resolve) => setTimeout(resolve, 5));
    const status = await fetch(guarded.url + '/status.json', { headers: { authorization: 'Bearer ' + token } });
    const body = await status.json();
    assert.equal(body.e2e.last.results[0].ok, true);
    assert.equal(body.e2e.last.trigger, 'manual');
    const page = await (await fetch(guarded.url + '/metrics', { headers: { authorization: 'Bearer ' + token } })).text();
    assert.match(page, /forgehands_e2e_scenario_ok\{scenario="smoke"\} 1/);
  } finally {
    for (const server of servers) server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const MIN = 60000;

test('a run that waits 40 minutes in the queue gets its 20 minutes of run time from its start: the pull request it opens at minute 50 is found', async () => {
  const forge = new FakeForge();
  const clock = { t: 0 };
  const ledger = new FakeLedger();
  // The dispatcher: the ticket's run is queued at once, starts at minute 40, and opens its pull request 10 minutes into the run.
  ledger.onSync = () => {
    for (const issue of forge.issues.values()) {
      if (issue.state !== 'open' || !issue.labels.some((label) => label.name === 'ai:ready')) continue;
      let job = ledger.jobs.find((entry) => entry.issue === issue.number);
      if (!job) { job = { issue: issue.number, label: 'ai:ready', status: 'queued', created: clock.t }; ledger.jobs.push(job); }
      if (job.status === 'queued' && clock.t >= 40 * MIN) { job.status = 'running'; job.started = clock.t; }
      if (job.status === 'running' && clock.t >= job.started + 10 * MIN) {
        const head = 'ai/issue-' + issue.number;
        forge.commitOn(head, 'main', { 'e2e/delivery.txt': 'delivered' });
        job.pr = forge.openPull(head, 'WIP', issue.number).number;
        job.status = 'done';
        job.finished = clock.t;
      }
    }
  };
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', as: 'pr', for: { findPull: 'ai/issue-$ticket' } },
  ]), runOptions(forge, { ledger, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, pollMs: MIN, timeoutMs: 10 * 60 * MIN }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.cleanup, 'ok', result.cleanup_reason);
  assert.ok(clock.t >= 50 * MIN && clock.t < 60 * MIN, 'the pull request was found at minute 50, not at the 20 minutes after the ticket: ' + clock.t / MIN);
});

test('a run that is still queued after the queue allowance fails with queued_too_long, not with a timeout', async () => {
  const forge = new FakeForge();
  const clock = { t: 0 };
  const ledger = new FakeLedger();
  ledger.onSync = () => {
    for (const issue of forge.issues.values()) {
      if (issue.state === 'open' && !ledger.jobs.some((job) => job.issue === issue.number)) ledger.jobs.push({ issue: issue.number, label: 'ai:ready', status: 'queued', created: clock.t });
    }
  };
  const result = await runScenario(scenario([
    ticketStep,
    { do: 'wait', for: { findPull: 'ai/issue-$ticket' } },
  ]), runOptions(forge, { ledger, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, pollMs: MIN, queueMs: 60 * MIN, timeoutMs: 10 * 60 * MIN }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /^step 2 \(wait for findPull\): queued_too_long: 0 runs ahead, the run waited more than 60 minutes in the queue; last seen: no pull request/);
  assert.equal(clock.t, 60 * MIN, 'the wait ends when the allowance is used up');
  assert.equal(result.cleanup, 'ok', result.cleanup_reason);
  assert.deepEqual(ledger.dropped, [[...forge.issues.keys()][0]], 'the cleanup dropped the queued run of the ticket');
});

test('runClockOf: a running run counts its time from its start, a queued one its allowance from the queue, and no run the allowance after the last thing', () => {
  const run = (status, extra = {}) => ({ label: 'ai:ready', status, created: 0, ahead: 0, ...extra });
  assert.deepEqual(runClockOf([run('running', { started: 40 * MIN })], 0, 20 * MIN, 60 * MIN), { limit: 60 * MIN, state: 'running', ahead: 0 });
  assert.deepEqual(runClockOf([run('queued', { created: 5 * MIN, ahead: 3 })], 0, 20 * MIN, 60 * MIN), { limit: 65 * MIN, state: 'queued', ahead: 3 });
  assert.deepEqual(runClockOf([run('waiting', { created: 5 * MIN })], 0, 20 * MIN, 60 * MIN).state, 'queued', 'a run waiting for dependencies is queued too');
  assert.deepEqual(runClockOf([], 2 * MIN, 20 * MIN, 60 * MIN), { limit: 62 * MIN, state: 'idle', ahead: 0 }, 'no run: the allowance counts from the ticket');
  assert.deepEqual(runClockOf([run('done', { created: 0, started: 1 * MIN, finished: 30 * MIN })], 0, 20 * MIN, 60 * MIN), { limit: 90 * MIN, state: 'idle', ahead: 0 });
});

test('the runs of a ticket count across the issue routes; a queued run that never started is not a run; the port reads the queue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-ledger-'));
  try {
    const jobs = new JobStore(join(dir, 'jobs.json'));
    jobs.add({ key: 'owner/hello#7:ai:ready', label: 'ai:ready', event: {}, status: 'done', created: 1, started: 2, finished: 3 });
    jobs.add({ key: 'owner/hello#7:ai:escalate', label: 'ai:escalate', event: {}, status: 'running', created: 4, started: 5 });
    jobs.add({ key: 'owner/hello#7:ai:ready', label: 'ai:ready', event: {}, status: 'queued', created: 6 });
    jobs.add({ key: 'owner/hello#8:ai:ready', label: 'ai:ready', event: {}, status: 'running', created: 7, started: 8 });
    jobs.add({ key: 'owner/hello#7:ai:review', label: 'ai:review', event: {}, status: 'done', created: 9, started: 9 });
    const routes = new Map([['ai:ready', { kind: 'issue' }], ['ai:escalate', { kind: 'issue' }], ['ai:review', { kind: 'pull_request' }]]);
    const ledger = ledgerOf(jobs, routes, async () => 0);
    assert.equal(ledger.runsOf('Owner/Hello', 7), 2, 'the first run and the escalated one; the review is not an issue run, the queued one not started');
    assert.equal(ledger.runsOf('owner/hello', 7, 'ai:ready'), 1);
    assert.equal(ledger.runsOf('owner/hello', 7, 'ai:escalate'), 1);
    assert.equal(ledger.runsOf('owner/hello', 8), 1, 'another ticket has its own runs');
    const state = ledger.runsStateOf('owner/hello', 7);
    assert.deepEqual(state.map((run) => run.status), ['done', 'running', 'queued']);
    assert.equal(state[2].ahead, 2, 'the two running runs (of this ticket and of #8) go before the queued one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the dispatcher drops the queued runs of a closed ticket and leaves its running run alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-drop-'));
  try {
    const config = loadConfig(withE2e(), quiet);
    const jobs = new JobStore(join(dir, 'jobs.json'));
    const event = { repository: { full_name: 'owner/hello' }, issue: { number: 5 } };
    jobs.add({ key: 'owner/hello#5:ai:ready', label: 'ai:ready', event, status: 'queued', created: 1 });
    jobs.add({ key: 'owner/hello#5:ai:escalate', label: 'ai:escalate', event, status: 'running', created: 2, started: 2 });
    jobs.add({ key: 'owner/hello#6:ai:ready', label: 'ai:ready', event: { repository: { full_name: 'owner/hello' }, issue: { number: 6 } }, status: 'queued', created: 3 });
    const dispatcher = new Dispatcher(config, jobs, async () => { throw new Error('no network'); }, quiet, () => 1000);
    assert.equal(await dispatcher.dropQueuedOf('owner/hello', 5), 1);
    assert.equal(jobs.list().find((job) => job.key === 'owner/hello#5:ai:ready').status, 'deleted');
    assert.equal(jobs.list().find((job) => job.key === 'owner/hello#5:ai:escalate').status, 'running', 'a running run is left alone');
    assert.equal(jobs.list().find((job) => job.key === 'owner/hello#6:ai:ready').status, 'queued', 'another ticket is left alone');
    assert.equal(await dispatcher.dropQueuedOf('owner/hello', 5), 0, 'nothing is left to drop');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore: the verdict is taken at the commit the restore wrote, so a stale branch read or compare after it is not a difference', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/red.marker': 'red' });
  // After the restore's write the branch read still shows the old tip twice, and the compare shows a difference that is gone.
  const branchTip = forge.branchTip.bind(forge);
  const compare = forge.compare.bind(forge);
  let staleTips = 0;
  let staleCompares = 0;
  let before = null;
  forge.progress = (f, name) => { if (name === 'deleteFile' && !before) { before = f.branches.get('main'); staleTips = 2; staleCompares = 2; } };
  forge.branchTip = (repository, branch) => (staleTips > 0 && before ? (staleTips -= 1, before) : branchTip(repository, branch));
  forge.compare = (repository, from, to) => {
    const answer = compare(repository, from, to);
    if (staleCompares > 0 && answer.files.length === 0 && to !== from) { staleCompares -= 1; return { files: [{ filename: 'e2e/red.marker' }] }; }
    return answer;
  };
  const slept = [];
  const logged = [];
  const result = await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/red.marker']), sleep: async (ms) => { slept.push(ms); },
    waitMs: 0, log: (line) => logged.push(line) });
  assert.deepEqual(result.untouched, []);
  assert.deepEqual(result.moved, [], 'the stale tip is a commit the restore already saw, not one of someone else');
  assert.equal(staleTips, 1, 'the stale tip read after the write was given (the moved check reads the branch once)');
  assert.equal(staleCompares, 1, 'the stale compare answer after the write was given (the verdict reads the compare once)');
  assert.deepEqual(slept, [], 'no settle wait: the commit the restore wrote answers at once');
  assert.deepEqual(logged, []);
  assert.equal(forge.readFile(null, 'e2e/red.marker', 'main'), null);
});

test('restore: stale reads of the commit the restore wrote are looked at again on a later pass, and the third read is the verdict', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/red.marker': 'red' });
  // The forge answers the contents of the commit the restore wrote with the old file for two reads after the write.
  const readFile = forge.readFile.bind(forge);
  let stale = 0;
  forge.progress = (_, name) => { if (name === 'deleteFile') stale = 2; };
  forge.readFile = (repository, path, ref) => {
    if (stale > 0 && path === 'e2e/red.marker' && ref !== baseline) { stale -= 1; return { sha: 'blob:red', content: b64('red') }; }
    return readFile(repository, path, ref);
  };
  const slept = [];
  const result = await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/red.marker']), sleep: async (ms) => { slept.push(ms); }, waitMs: 0 });
  assert.equal(stale, 0, 'both stale reads were given');
  assert.deepEqual(result.untouched, []);
  assert.deepEqual(slept, [0, 0], 'two more passes (the first verdict and the second one saw the stale file), no settle wait');
  assert.equal(forge.readFile(null, 'e2e/red.marker', 'main'), null);
});

test('restore: a difference that stays in a path of the run fails after the settle schedule (2, 4, 8, 16, 30 s), and the cleanup names the path', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/red.marker': 'red' });
  // The forge accepts the write and answers a commit id, but the branch does not change: the difference stays for every look.
  forge.writeFile = (_, __, { branch }) => { forge.tick('writeFile'); return forge.branches.get(branch); };
  forge.deleteFile = (_, __, { branch }) => { forge.tick('deleteFile'); return forge.branches.get(branch); };
  const slept = [];
  await assert.rejects(restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/red.marker']), sleep: async (ms) => { slept.push(ms); }, waitMs: 0 }),
    /main still differs from \S+ in 1 file\(s\) of the run: e2e\/red.marker$/);
  assert.deepEqual(slept, [0, 0, 2000, 4000, 8000, 16000, 30000], 'two passes more, then the settle schedule, about a minute in all');

  const ticket = forge.createIssue('owner/hello', 'E2E red', 'B');
  forge.commitOn('ai/issue-' + ticket.number, 'main', { 'e2e/red.marker': 'red' });
  const failed = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline }, { sleep: async () => {} });
  assert.match(failed.problem, /^reset main: main still differs from \S+ in 1 file\(s\) of the run: e2e\/red.marker$/);
});

test('restore: a path of the run that another commit changes after the restore is a note, not a failure; a commit on an unrelated path is ignored', async () => {
  for (const [file, moved] of [['e2e/delivery.txt', ['e2e/delivery.txt']], ['e2e/other.txt', []]]) {
    const forge = new FakeForge();
    const baseline = forge.branches.get('main');
    const ticket = forge.createIssue('owner/hello', 'E2E normal delivery', 'B');
    forge.commitOn('ai/issue-' + ticket.number, 'main', { 'e2e/delivery.txt': 'delivered' });
    forge.commitOn('main', 'main', { 'e2e/delivery.txt': 'delivered' });
    // Right after the restore's write, another ticket's commit lands on main (the first branch read after it).
    let wrote = false;
    let landed = false;
    forge.progress = (f, name) => {
      if (name === 'deleteFile') wrote = true;
      if (name === 'branchTip' && wrote && !landed) { landed = true; f.commitOn('main', 'main', { [file]: 'foreign' }); }
    };
    const outcome = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline }, { sleep: async () => {} });
    assert.equal(landed, true, 'the foreign commit landed');
    assert.equal(outcome.problem, null, 'the cleanup holds');
    if (moved.length) assert.match(outcome.note, /^main moved on after the restore: a commit of someone else changed 1 file\(s\) of the run, left alone: e2e\/delivery.txt$/);
    else assert.equal(outcome.note, null, 'an unrelated path is not the run\'s concern');
  }
});

test('restore: the retries and the verdicts log path names, never contents', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/red.marker': 'SECRET-CONTENT' });
  // The forge accepts the deletion but the branch does not change, so every look sees the difference.
  forge.deleteFile = (_, __, { branch }) => { forge.tick('deleteFile'); return forge.branches.get(branch); };
  const logged = [];
  await assert.rejects(restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/red.marker']), sleep: async () => {}, waitMs: 0, log: (line) => logged.push(line) }));
  assert.equal(logged.length > 0, true, 'the retries are logged');
  assert.equal(logged.every((line) => line.includes('e2e/red.marker')), true, 'every line names the path');
  assert.equal(logged.some((line) => line.includes('SECRET-CONTENT')), false, 'no contents');
});

test('restore reads each path at the commit the branch has, not at the branch name', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  forge.commitOn('main', 'main', { 'e2e/delivery.txt': 'delivered' });
  const refs = [];
  const readFile = forge.readFile.bind(forge);
  forge.readFile = (repository, path, ref) => { refs.push(ref); return readFile(repository, path, ref); };
  await restoreBranch(forge, 'owner/hello', 'main', baseline, { touched: new Set(['e2e/delivery.txt']), sleep: async () => {} });
  assert.equal(refs.includes('main'), false, 'no read by the branch name');
  assert.equal(refs.some((ref) => /^c\d+$/.test(ref)), true, 'reads by commit id');
  assert.equal(forge.readFile(null, 'e2e/delivery.txt', 'main'), null);
});

test('cleanup waits for a run of its ticket that still goes, and drops the queued ones first', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  const ticket = forge.createIssue('owner/hello', 'E2E normal delivery', 'B');
  const ledger = new FakeLedger();
  // The run is going for three looks, then it has ended (it delivered nothing: the cleanup has nothing to restore).
  ledger.jobs.push({ issue: ticket.number, label: 'ai:ready', status: 'running', created: 0, started: 0 });
  ledger.jobs.push({ issue: ticket.number, label: 'ai:escalate', status: 'queued', created: 1 });
  let looks = 0;
  ledger.onSync = () => {
    looks += 1;
    if (looks === 2) ledger.jobs[0].status = 'done';
  };
  let slept = 0;
  const outcome = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline },
    { sleep: async () => { slept += 1; }, ledger, pollMs: 1000, leftoverMs: 60000 });
  assert.deepEqual(ledger.dropped, [ticket.number], 'the queued run was dropped');
  assert.equal(outcome.problem, null, outcome.problem);
  assert.ok(slept >= 1 && slept <= 3, 'it waited for the running one, not for the full bound: ' + slept);
});

test('cleanup reports a run of its ticket that is still going after the bound, and does not wait for ever', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  const ticket = forge.createIssue('owner/hello', 'E2E normal delivery', 'B');
  const ledger = new FakeLedger();
  ledger.jobs.push({ issue: ticket.number, label: 'ai:ready', status: 'running', created: 0, started: 0 });
  let slept = 0;
  const outcome = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline },
    { sleep: async () => { slept += 1; }, ledger, pollMs: 1000, leftoverMs: 5000 });
  assert.equal(slept, 5);
  assert.match(outcome.problem, /runs of the tickets still going after 5 s: #\d+ running/);
});

test('cleanup takes the pull requests and the stale paths of its own run only: a delivery of an earlier ticket with a higher number is left alone', async () => {
  const forge = new FakeForge();
  const baseline = forge.branches.get('main');
  const earlier = forge.createIssue('owner/hello', 'E2E normal delivery, earlier', 'B');
  const ticket = forge.createIssue('owner/hello', 'E2E revert on red', 'B');
  // The earlier ticket's pull request is opened after the run's ticket, so its number is higher: it is not the run's. Its branch changes a file
  // the cleanup cannot read; a stray of the same kind is on main (it came from elsewhere).
  forge.commitOn('ai/issue-' + earlier.number, 'main', { 'e2e/delivery.txt': 'delivered', 'e2e/link': '@@link' });
  const laterPull = forge.openPull('ai/issue-' + earlier.number, 'earlier', earlier.number);
  forge.commitOn('main', 'main', { 'e2e/link': '@@link' });
  linkEntries(forge);
  const outcome = await cleanup('owner/hello', forge, { tickets: [ticket.number], defaultBranch: 'main', baseline }, { sleep: async () => {} });
  assert.equal(outcome.problem, null, 'the stray of the earlier delivery is not the run\'s concern');
  assert.match(outcome.note, /e2e\/link/);
  assert.equal(laterPull.state, 'open', 'the pull request of the earlier ticket is not closed by this run\'s cleanup');
  assert.equal(earlier.state, 'open', 'its ticket is not closed either');
});

test('runTicketOf: a runs count names its ticket, an ai/issue branch names it, an ai/revert branch names the ticket of the pull request it reverts', async () => {
  const forge = new FakeForge();
  const pr = forge.openPull('ai/issue-7', 'x', 7);
  const probeOf = (vars = new Map([['pr', pr.number]])) => ({ forge, repository: 'owner/hello', defaultBranch: 'main', ledger: new FakeLedger(), vars });
  assert.equal(await runTicketOf({ runs: '$pr', atLeast: 1 }, probeOf()), pr.number);
  assert.equal(await runTicketOf({ findPull: 'ai/issue-42' }, probeOf()), 42);
  assert.equal(await runTicketOf({ findPull: 'ai/revert-' + pr.number }, probeOf()), 7);
  assert.equal(await runTicketOf({ issue: '3', state: 'open' }, probeOf()), null);
});

test('the revert scenario counts its runs across the issue routes, not under one label', () => {
  const revert = SCENARIOS.find((entry) => entry.name === 'revert-on-red');
  const predicates = revert.steps.filter((step) => step.do === 'wait' || step.do === 'assert').map((step) => step.for ?? step.that);
  const runs = predicates.filter((predicate) => 'runs' in predicate);
  assert.equal(runs.length, 2, 'the restart wait and the exact-count assert');
  for (const predicate of runs) assert.equal('label' in predicate, false, 'no label: ' + JSON.stringify(predicate));
});
