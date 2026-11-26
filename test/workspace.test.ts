// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { Dispatcher } from '../src/agent/dispatch.ts';
import { Workspace, nodeFs } from '../src/agent/workspace.ts';
import { buildPrompt, workspaceName, workspacePath } from '../src/agent/prompt.ts';
import { JobStore } from '../src/store/jobs.ts';
import { buildStatus } from '../src/server/status.ts';
import { gaugeSamples, metrics } from '../src/metrics.ts';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const GB = 1e9;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const WORKER = '22222222-2222-4222-8222-222222222222';
const repo = 'owner/hello';
const quietLog = { error() {} };

// The settings every test starts from (direct mode, no forge calls are made by the cleanup).
const baseEnv = (extra = {}) => ({
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_API_URL: 'http://openhands:8000/',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  ALLOWED_REPOS: repo,
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: WORKER, tier: 'free' } }),
  FORGE_TOKEN: 'tok',
  FORGE_URL: 'https://forge.example',
  ...extra
});

// A fresh cleanup root (a real temp directory) and a ledger, both owned by the test.
async function setup(extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'forgehands-ws-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  const config = loadConfig(baseEnv({ DATA_FILE: join(base, 'deliveries.json'), WORKSPACE_CLEANUP_DIR: root, ...extra }));
  const jobs = new JobStore(join(base, 'jobs.json'));
  await jobs.load();
  const logs = [];
  const logger = { error: (...args) => logs.push(args.join(' ')) };
  return { base, root, config, jobs, logs, logger };
}

const issueEvent = (number, extra = {}) => ({
  type: 'issues.labeled', source: 'forgejo', label: 'ai:ready', delivery_id: 'delivery' + number,
  repository: { full_name: repo, clone_url: null, html_url: null, default_branch: 'main' }, sender: { login: 'marcel' },
  issue: { number, title: 'Task ' + number, body: 'Do it', html_url: null, comments: 0, labels: ['ai:ready'] }, ...extra
});

// A job in the ledger. `ended` is how long before NOW it finished (null: it did not finish).
function addJob(jobs, event, status, { ended = null, created = NOW - 2 * DAY, label = 'ai:ready' } = {}) {
  return jobs.add({ key: repo.toLowerCase() + '#' + event.issue.number + ':' + label, label, event, status, created,
    ...(ended === null ? {} : { finished: NOW - ended }), ...(status === 'running' ? { started: created } : {}) });
}

// A clone directory as OpenHands leaves it: some files, and a modification time `age` before NOW.
async function clone(root, name, age = 2 * DAY, extra = null) {
  const path = join(root, name);
  await mkdir(join(path, 'node_modules'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'big.bin'), 'x'.repeat(64));
  if (extra) await extra(path);
  const when = (NOW - age) / 1000;
  await utimes(path, when, when);
  return path;
}

test('a finished run is deleted after WORKSPACE_KEEP_HOURS, a younger one stays', async () => {
  const s = await setup();
  const old = issueEvent(5);
  const young = issueEvent(6);
  addJob(s.jobs, old, 'done', { ended: 13 * HOUR });
  addJob(s.jobs, young, 'done', { ended: 11 * HOUR });
  const oldDir = await clone(s.root, workspaceName(old));
  const youngDir = await clone(s.root, workspaceName(young));
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(youngDir), true);
});

test('a failed run keeps its directory for WORKSPACE_KEEP_FAILED_HOURS (72 by default)', async () => {
  const s = await setup();
  const twentyHours = issueEvent(7);
  const eightyHours = issueEvent(8);
  addJob(s.jobs, twentyHours, 'failed', { ended: 20 * HOUR });
  addJob(s.jobs, eightyHours, 'failed', { ended: 80 * HOUR });
  const keep = await clone(s.root, workspaceName(twentyHours));
  const gone = await clone(s.root, workspaceName(eightyHours));
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  assert.equal(existsSync(keep), true);
  assert.equal(existsSync(gone), false);
});

test('a directory of a queued, waiting or running job is never deleted, however old', async () => {
  const s = await setup();
  const events = [issueEvent(10), issueEvent(11), issueEvent(12)];
  addJob(s.jobs, events[0], 'running', { created: NOW - 10 * DAY });
  addJob(s.jobs, events[1], 'queued', { created: NOW - 10 * DAY });
  addJob(s.jobs, events[2], 'waiting', { created: NOW - 10 * DAY });
  // A round on the pull request of issue 10: its own directory, held by its own running job.
  const round = { ...issueEvent(10), pull_request: { number: 40, head_ref: 'ai/issue-10', html_url: null }, delivery_id: 'abcdef12' };
  addJob(s.jobs, round, 'running', { created: NOW - 10 * DAY, label: 'ai:changes' });
  const dirs = [];
  for (const event of [...events, round]) dirs.push(await clone(s.root, workspaceName(event), 10 * DAY));
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  for (const dir of dirs) assert.equal(existsSync(dir), true, dir);
});

test('an orphan of the naming scheme older than WORKSPACE_ORPHAN_HOURS is deleted; a younger one and foreign names stay', async () => {
  const s = await setup();
  const orphan = await clone(s.root, 'owner-hello-issue-40', 3 * DAY);
  const recent = await clone(s.root, 'owner-hello-issue-41', 1 * DAY);
  const foreign = await clone(s.root, 'scratch', 30 * DAY);
  const nearMiss = await clone(s.root, 'owner-hello-issue-42-extra', 30 * DAY);
  const hidden = await clone(s.root, '.owner-hello-issue-43', 30 * DAY);
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(foreign), true);
  assert.equal(existsSync(nearMiss), true);
  assert.equal(existsSync(hidden), true);
});

test('an epic without a job is an orphan once old; an epic never has a round suffix, so such a name is never touched', async () => {
  const s = await setup();
  const plain = await clone(s.root, 'owner-hello-epic-31', 3 * DAY);
  const suffixed = await clone(s.root, 'owner-hello-epic-31-round-abc', 3 * DAY);
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  assert.equal(existsSync(plain), false);
  assert.equal(existsSync(suffixed), true);
});

test('a symlink inside the tree that points outside is not followed: the target survives', async () => {
  const s = await setup();
  const outside = join(s.base, 'outside');
  await mkdir(join(outside, 'precious'), { recursive: true });
  await writeFile(join(outside, 'precious', 'keep.txt'), 'keep');
  // A scheme-named symlink to the outside directory, a clone directory that links out from inside, and a foreign symlink.
  await symlink(outside, join(s.root, 'owner-hello-issue-50'));
  await symlink(outside, join(s.root, 'misc'));
  // The link goes in before the age is set: a new entry would make the directory look young again.
  const dir = await clone(s.root, 'owner-hello-issue-51', 3 * DAY, async (path) => symlink(join(outside, 'precious'), join(path, 'link')));
  await new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  assert.equal(existsSync(join(outside, 'precious', 'keep.txt')), true);
  assert.equal(existsSync(dir), false, 'the clone itself is an orphan and goes, its link with it');
  assert.equal(existsSync(join(s.root, 'owner-hello-issue-50')), true, 'a symlink of the scheme is never removed');
  assert.equal(existsSync(join(s.root, 'misc')), true);
});

test('an empty WORKSPACE_CLEANUP_DIR switches the cleanup off; "/", a relative path and a bad switch are start errors', async () => {
  const s = await setup({ WORKSPACE_CLEANUP_DIR: '' });
  assert.equal(s.config.workspaceCleanupDir, null);
  const dir = await clone(s.root, 'owner-hello-issue-60', 30 * DAY);
  const ws = new Workspace(s.config, s.jobs, { now: () => NOW, logger: quietLog });
  assert.equal(ws.enabled, false);
  await ws.run();
  assert.equal(existsSync(dir), true);
  assert.equal(ws.state(), null);
  assert.throws(() => loadConfig(baseEnv({ WORKSPACE_CLEANUP_DIR: '/' })), /root directory/);
  assert.throws(() => loadConfig(baseEnv({ WORKSPACE_CLEANUP_DIR: 'relative/dir' })), /absolute/);
  assert.throws(() => loadConfig(baseEnv({ WORKSPACE_CLEANUP_DIR: '/srv/ws', WORKSPACE_CLEANUP_DRY: 'yes' })), /WORKSPACE_CLEANUP_DRY/);
  assert.equal(loadConfig(baseEnv({ WORKSPACE_CLEANUP_DIR: '/srv/ws/' })).workspaceCleanupDir, '/srv/ws');
  await rm(s.base, { recursive: true, force: true });
});

test('WORKSPACE_CLEANUP_DRY=1 and DRY_RUN=1 log what would be deleted and delete nothing', async () => {
  for (const extra of [{ WORKSPACE_CLEANUP_DRY: '1' }, { DRY_RUN: '1' }]) {
    const s = await setup(extra);
    const orphan = await clone(s.root, 'owner-hello-issue-70', 3 * DAY);
    const job = issueEvent(71);
    addJob(s.jobs, job, 'done', { ended: 30 * HOUR });
    const finished = await clone(s.root, workspaceName(job), 3 * DAY);
    await new Workspace(s.config, s.jobs, { now: () => NOW, logger: s.logger }).run();
    assert.equal(existsSync(orphan), true);
    assert.equal(existsSync(finished), true);
    assert.ok(s.logs.some((line) => line.includes('owner-hello-issue-70: would be cleaned (orphan)')), s.logs.join('\n'));
    assert.ok(s.logs.some((line) => line.includes('dry run')));
    await rm(s.base, { recursive: true, force: true });
  }
});

test('a failing delete is logged, the pass goes on, and the directory is tried again in the next pass', async () => {
  const s = await setup();
  const failing = await clone(s.root, 'owner-hello-issue-80', 3 * DAY);
  const fine = await clone(s.root, 'owner-hello-issue-81', 3 * DAY);
  let refuse = true;
  const fs = { ...nodeFs, rm: async (path, options) => {
    if (refuse && path.endsWith('owner-hello-issue-80')) throw new Error('EACCES: permission denied');
    return nodeFs.rm(path, options);
  } };
  const ws = new Workspace(s.config, s.jobs, { now: () => NOW, logger: s.logger, fs });
  await ws.run();
  assert.equal(existsSync(fine), false);
  assert.equal(existsSync(failing), true);
  assert.ok(s.logs.some((line) => line.includes('could not clean owner-hello-issue-80')));
  refuse = false;
  await ws.run();
  assert.equal(existsSync(failing), false);
});

test('the disk warning is sent once per 24 hours while the usage is at or above DISK_WARN_PERCENT', async () => {
  const s = await setup();
  const sent = [];
  const notifier = { wants: () => true, notify: (message) => sent.push(message) };
  // 90.9 % used.
  const fs = { ...nodeFs, statfs: async () => ({ bsize: 1, blocks: 100, bfree: 10, bavail: 9 }) };
  let clock = NOW;
  const ws = new Workspace(s.config, s.jobs, { now: () => clock, logger: quietLog, fs, notifier });
  await ws.run();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'disk_full');
  assert.ok(sent[0].text.includes('90.9 % used'), sent[0].text);
  clock = NOW + HOUR;
  await ws.run();
  assert.equal(sent.length, 1, 'not again within 24 hours');
  clock = NOW + 25 * HOUR;
  await ws.run();
  assert.equal(sent.length, 2, 'again after 24 hours');
});

test('a statfs failure is logged and does not stop the pass', async () => {
  const s = await setup();
  const dir = await clone(s.root, 'owner-hello-issue-90', 3 * DAY);
  const fs = { ...nodeFs, statfs: async () => { throw new Error('ESTALE'); } };
  const ws = new Workspace(s.config, s.jobs, { now: () => NOW, logger: s.logger, fs });
  await ws.run();
  assert.equal(existsSync(dir), false, 'the cleanup still ran');
  assert.ok(s.logs.some((line) => line.includes('cannot read the usage')));
});

test('below DISK_MIN_FREE_GB no new run starts and the status says why; a cleanup that frees space lifts the hold', async () => {
  const s = await setup();
  const finished = issueEvent(100);
  addJob(s.jobs, finished, 'done', { ended: 30 * HOUR });
  const freed = await clone(s.root, workspaceName(finished), 3 * DAY);
  addJob(s.jobs, issueEvent(101), 'queued', { created: NOW - HOUR });
  // 2 GB free until the directory of the finished run is removed; then 20 GB.
  let free = 2 * GB;
  const fs = { ...nodeFs,
    statfs: async () => ({ bsize: 1, blocks: 100e9, bfree: free, bavail: free }),
    rm: async (path, options) => { await nodeFs.rm(path, options); free = 20 * GB; } };
  const send = async () => { throw new Error('no request expected: nothing may start'); };
  const dispatcher = new Dispatcher(s.config, s.jobs, send, s.logger, () => NOW, { wants: () => false, notify: () => {} });
  dispatcher.workspace.fs = fs;
  await dispatcher.workspace.poll();
  await dispatcher.workspace.run();
  // The hold began, a cleanup pass ran at once, freed the space and lifted the hold.
  assert.equal(existsSync(freed), false);
  assert.equal(dispatcher.workspace.holding, false);
  assert.ok(s.logs.some((line) => line.includes('no new run starts until 3 GB')));
  assert.ok(s.logs.some((line) => line.includes('free space is back above DISK_MIN_FREE_GB')));
  // Now the hold again, with nothing to free: the queued job waits, and the status page says why.
  free = 2 * GB;
  await dispatcher.workspace.poll();
  await dispatcher.workspace.run();
  assert.equal(dispatcher.workspace.holding, true);
  assert.equal(dispatcher.pickNext(NOW, new Set()), null);
  const status = buildStatus(s.config, s.jobs, NOW, undefined, [], dispatcher.workspace.state());
  const issue = status.issues.find((entry) => entry.issue.endsWith('#101'));
  assert.equal(issue.state, 'queued: low disk space (2 GB free)');
  assert.equal(status.workspace.hold, 'low disk space (2 GB free)');
});

test('the name the prompt uses is the name the cleanup matches, for every kind of run', async () => {
  const s = await setup();
  const ci = { run_id: 1, workflow: 'ci', commit_sha: 'abcdef1234567890', status: 'failure', html_url: null };
  const pull = { number: 12, head_ref: 'ai/issue-11', html_url: null };
  const events = [
    ['issue', issueEvent(11)],
    ['round', { ...issueEvent(11), pull_request: pull, delivery_id: 'deliv-42' }],
    ['fix', { ...issueEvent(11), type: 'ci.failure', pull_request: pull, ci, delivery_id: 'x' }],
    ['review', { ...issueEvent(11), type: 'ci.success', pull_request: pull, ci, delivery_id: 'x' }],
    ['security', { ...issueEvent(11), type: 'ci.sensitive', pull_request: pull, ci, protected_files: ['infra/a'], delivery_id: 'x' }],
    ['conflict', { ...issueEvent(11), type: 'pull_request.conflict', pull_request: pull, base_sha: 'feedface00', delivery_id: 'x' }],
    ['epic', { ...issueEvent(11), type: 'epic.done', epic: { children: [] } }],
    ['bot', { ...issueEvent(11), bot: true, pull_request: { number: 77, head_ref: 'renovate/x', html_url: null }, delivery_id: 'x' }]
  ];
  const config = s.config;
  for (const [kind, event] of events) {
    const dir = workspacePath(config, event);
    // The prompt names the directory the run works in.
    assert.ok(buildPrompt(event, config).includes('at ' + dir + '.'), kind + ': the prompt names ' + dir);
    // A clone of that name, of a job that finished long ago: the cleanup removes exactly that directory.
    addJob(s.jobs, event, 'done', { ended: 30 * HOUR, label: 'ai:' + kind });
    await clone(s.root, workspaceName(event), 3 * DAY);
  }
  await new Workspace(config, s.jobs, { now: () => NOW, logger: quietLog }).run();
  for (const [kind, event] of events) {
    assert.equal(existsSync(join(s.root, workspaceName(event))), false, kind + ' was cleaned');
  }
  await rm(s.base, { recursive: true, force: true });
});

test('the disk gauges and the cleanup counter are exported only while the cleanup is on', async () => {
  const s = await setup();
  const samples = gaugeSamples(s.config, s.jobs, new Map(), NOW, { usedPercent: 91.5, freeBytes: 4 * GB });
  const value = (name) => samples.find((sample) => sample.name === name)?.value;
  assert.equal(value('forgehands_workspace_disk_used_percent'), 91.5);
  assert.equal(value('forgehands_workspace_disk_free_bytes'), 4 * GB);
  assert.equal(gaugeSamples(s.config, s.jobs, new Map(), NOW, null).some((sample) => sample.name.startsWith('forgehands_workspace_')), false);
  const text = metrics.render(samples);
  assert.ok(text.includes('# TYPE forgehands_workspace_disk_free_bytes gauge'));
  // The counter lives in the process (earlier tests of this file deleted directories), so only its line shape is checked.
  assert.match(text, /^forgehands_workspace_cleaned_total \d+$/m);
  await rm(s.base, { recursive: true, force: true });
});
