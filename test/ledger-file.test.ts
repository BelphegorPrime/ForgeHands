// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// The ledger file: what JobStore reads, keeps, drops and writes. These tests pin the file format, so that a change to how the ledger is
// loaded or saved shows here first.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../src/store/jobs.ts';

const DAY = 86400000;
const NOW = 1_700_000_000_000;
const OLD = NOW - 31 * DAY;
const repo = 'owner/hello';
let dir;

const event = (number) => ({ type: 'issues.labeled', label: 'ai:ready', repository: { full_name: repo }, issue: { number, title: 'T', body: '', labels: [] }, sender: { login: 'marcel' } });
const job = (id, number, over = {}) => ({ id, key: repo + '#' + number + ':ai:ready', label: 'ai:ready', event: event(number), status: 'done', created: NOW - DAY, finished: NOW - DAY, attempts: 0, ...over });

// A version 2 ledger with every collection filled: one entry to keep, one too old (where age counts) and one that is not valid.
function fullLedger() {
  return {
    version: 2,
    jobs: [job('a', 1), job('old', 2, { created: OLD, finished: OLD }), job('active-old', 3, { status: 'waiting', created: OLD, finished: undefined }), { key: 'no id' }],
    operator_tickets: { [repo + '#9']: { repository: repo, issue: 9, title: 'Need a token', at: NOW }, bad: { issue: 'x' } },
    labels: { [repo + '#1']: { labels: ['ai:ready'], seen: NOW }, [repo + '#2']: { labels: [], seen: OLD }, bad: { labels: 'x' } },
    deleted_in_forge: { [repo + '#1']: NOW, [repo + '#77']: NOW, bad: 'x' },
    gone_checks: { [repo + '#3']: 1, [repo + '#78']: 1, bad: null },
    meta: { digest_sent: '2023-11-14', e2e: { version: '0.9.0', trigger: 'start', started: NOW, finished: NOW, error: null }, unknown: 1 },
    dedupe: { 'comment:a': NOW, 'comment:old': OLD, bad: 'x' },
    holds: { [repo + '#pr4']: { repository: repo, number: 4, sha: 'abc', since: NOW, merge_after: null }, bad: { sha: 1 } },
    stuck: { [repo + '#pr5']: { repository: repo, issue: 5, number: 5, sha: 'def', why: 'rounds', blocked: true }, bad: { sha: 'x' } },
    epic_gaps: { [repo + '#6']: { repository: repo, issue: 6, sha: null, at: NOW, replans: 0, human: false }, bad: { issue: 6 } },
    epic_sweeps: { [repo + '#7']: { repository: repo, issue: 7, deps: 2, open: [8], last_closed: NOW, checked_at: NOW }, bad: { issue: 7, last_closed: NOW } },
    stalled: { [repo + '#8']: { repository: repo, issue: 8, run: 'a', restarts: 1, human: false, at: NOW }, bad: { issue: 8 } },
    merges: [{ repository: repo, number: 4, branch: 'ai/issue-4', sha: 'abc', merged_at: NOW, two_keys: false }, { repository: repo, number: 5, branch: 'b', sha: null, merged_at: OLD, two_keys: false }, { number: 1 }],
    reverts: [{ repository: repo, number: 4, issue: 4, sha: 'abc', at: NOW }, { repository: repo, number: 5, issue: 5, sha: 'x', at: OLD }, null],
    reruns: [{ repository: repo, number: 4, sha: 'abc', run_id: 1, at: NOW, state: 'green', event: event(4) }, { repository: repo, number: 5, sha: 'x', run_id: 2, at: OLD, state: 'red', event: event(5) }, {}],
    findings: [{ repository: repo, reason: 'tests', number: 4, sha: 'abc', at: NOW }, { repository: repo, reason: 'old', number: 5, sha: 'x', at: OLD }, { reason: 1 }],
    filed_findings: { [repo + '|tests']: { repository: repo, reason: 'tests', issue: 40, filed_at: NOW }, bad: { issue: 'x' } }
  };
}

async function roundTrip(content) {
  const file = join(dir, 'jobs.json');
  await writeFile(file, JSON.stringify(content));
  const store = new JobStore(file);
  await store.load();
  await store.persist(NOW);
  return { store, saved: JSON.parse(await readFile(file, 'utf8')) };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forgehands-ledger-file-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

test('a version 2 ledger loads every collection, drops invalid and old entries, and is written back in the same shape', async () => {
  const { saved } = await roundTrip(fullLedger());
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.jobs.map((entry) => entry.id), ['a', 'active-old'], 'an old ended job goes, an old waiting one stays, one without id is dropped');
  assert.deepEqual(Object.keys(saved.operator_tickets), [repo + '#9']);
  assert.deepEqual(Object.keys(saved.labels), [repo + '#1'], 'labels seen more than 30 days ago go');
  assert.deepEqual(Object.keys(saved.deleted_in_forge), [repo + '#1'], 'kept only while a job of the ticket is in the ledger');
  assert.deepEqual(Object.keys(saved.gone_checks), [repo + '#3']);
  assert.deepEqual(saved.meta, { digest_sent: '2023-11-14', e2e: { version: '0.9.0', trigger: 'start', started: NOW, finished: NOW, error: null } }, 'unknown meta goes');
  assert.deepEqual(Object.keys(saved.dedupe), ['comment:a']);
  assert.deepEqual(Object.keys(saved.holds), [repo + '#pr4'], 'holds are never pruned by age, only invalid ones go');
  assert.deepEqual(Object.keys(saved.stuck), [repo + '#pr5']);
  assert.deepEqual(Object.keys(saved.epic_gaps), [repo + '#6']);
  assert.deepEqual(Object.keys(saved.epic_sweeps), [repo + '#7']);
  assert.deepEqual(Object.keys(saved.stalled), [repo + '#8']);
  assert.deepEqual(saved.merges.map((entry) => entry.number), [4]);
  assert.deepEqual(saved.reverts.map((entry) => entry.number), [4]);
  assert.deepEqual(saved.reruns.map((entry) => entry.number), [4]);
  assert.deepEqual(saved.findings.map((entry) => entry.reason), ['tests']);
  assert.deepEqual(Object.keys(saved.filed_findings), [repo + '|tests']);
});

test('the ledger file keeps its keys in a fixed order', async () => {
  const { saved } = await roundTrip(fullLedger());
  assert.deepEqual(Object.keys(saved), ['version', 'jobs', 'operator_tickets', 'labels', 'deleted_in_forge', 'gone_checks', 'meta', 'dedupe', 'holds', 'stuck',
    'epic_gaps', 'epic_sweeps', 'stalled', 'merges', 'reverts', 'reruns', 'findings', 'filed_findings']);
});

test('a missing ledger file is an empty ledger, and a file without a job list is refused', async () => {
  const store = new JobStore(join(dir, 'none.json'));
  await store.load();
  assert.equal(store.list().length, 0);
  await writeFile(join(dir, 'broken.json'), JSON.stringify({ version: 2 }));
  await assert.rejects(new JobStore(join(dir, 'broken.json')).load(), /Invalid job store/);
});
