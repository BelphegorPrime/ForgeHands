// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The end-to-end suite (src/e2e) against a fake forge that stands in for ForgeHands: a worker opens a pull request for a ticket with the
// worker label, a reviewer approves it, and the merge lands on the default branch. Covered: pass, fail, timeout, cleanup after a failing
// step, off by default, the version trigger that runs once, the protected endpoint, the gauge, the status section and the notification.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { parseScenario, type Scenario } from '../src/e2e/format.ts';
import { E2eController } from '../src/e2e/controller.ts';
import { runScenario, runSuite, restoreBranch } from '../src/e2e/runner.ts';
import { SCENARIO_NAMES, selectScenarios } from '../src/e2e/scenarios.ts';
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
    const pr = { number, title, body: 'Closes #' + issue, state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
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
  }
  deleteFile(_, path, { branch, sha }) {
    this.tick('deleteFile');
    const snapshot = new Map(this.snapshotOf(branch));
    if (!snapshot.has(path) || 'blob:' + snapshot.get(path) !== sha) throw new Error('DELETE ' + path + ' -> HTTP 409');
    snapshot.delete(path);
    this.branches.set(branch, this.commit(snapshot));
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
const runOptions = (forge, extra = {}) => ({ repository: 'owner/hello', forge, ledger: { runsOf: () => 0 }, timeoutMs: 5000, pollMs: 1, sleep: async () => {}, ...extra });
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
  assert.equal(await restoreBranch(forge, 'owner/hello', 'main', baseline), 0, 'main has the tree of the start');
  assert.equal(forge.readFile(null, 'e2e/stray.txt', 'main'), null);
  assert.equal([...forge.pulls.values()].every((pr) => pr.state === 'closed'), true);
  assert.equal([...forge.branches.keys()].filter((name) => name.startsWith('ai/')).length, 0);
});

test('a cleanup that cannot delete a branch makes the scenario fail, even when its steps held', async () => {
  const forge = new FakeForge();
  forge.progress = forgeHands();
  forge.deleteBranch = () => { throw new Error('DELETE branch -> HTTP 500'); };
  const result = await runScenario(scenario([ticketStep, { do: 'wait', for: { findPull: 'ai/issue-$ticket' } }]), runOptions(forge));
  assert.equal(result.reason, null, 'the steps held');
  assert.equal(result.ok, false);
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
  assert.deepEqual(config.e2e, { repository: 'owner/hello', onStart: true, scenarios: ['conflict-round'], timeoutMinutes: 45 });
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
    assert.deepEqual(samples.map((sample) => [sample.labels.scenario, sample.value]), [['smoke', 1], ['broken', 0]]);
    const page = metrics.render(samples);
    assert.match(page, /forgehands_e2e_scenario_ok\{scenario="smoke"\} 1/);
    assert.match(page, /forgehands_e2e_scenario_ok\{scenario="broken"\} 0/);
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
