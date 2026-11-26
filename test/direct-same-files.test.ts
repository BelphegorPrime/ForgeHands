// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// WAIT_FOR_SAME_FILES: tickets that declare the same files wait for each other.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { parseDeclaredFiles } from '../src/agent/files.ts';
import { pathsOverlap } from '../src/utils/path-overlap.ts';
import { env, event, starts, API, issue, pull, filesBody, ticket, agentPull, buildSameFiles } from './helpers/direct.ts';

test('declared files: the Exact files section is read, notes are ignored, no section declares nothing', () => {
  assert.deepEqual(parseDeclaredFiles(filesBody('a/b.py', 'seed/x/**') + '- `late.ts`\n'), ['a/b.py', 'seed/x/**']);
  assert.deepEqual(parseDeclaredFiles('## Exact files\n- `a.ts` (new)\n- `dir/**` (new)\n* `c.ts`: note\nplain text\n'), ['a.ts', 'dir/**', 'c.ts']);
  assert.deepEqual(parseDeclaredFiles('Just text with `a.ts`'), []);
  assert.deepEqual(parseDeclaredFiles(undefined), []);
});

test('declared files overlap by equal path or by glob, and not otherwise', () => {
  assert.ok(pathsOverlap('a/b.py', 'a/b.py'));
  assert.ok(pathsOverlap('seed/infra/**', 'seed/infra/homelab/x.py'));
  assert.ok(pathsOverlap('seed/infra/homelab/x.py', 'seed/infra/**'));
  assert.ok(pathsOverlap('seed/**', 'seed/infra/**'));
  assert.ok(pathsOverlap('src/*.ts', 'src/a.ts'));
  assert.ok(!pathsOverlap('a/b.py', 'a/c.py'));
  assert.ok(!pathsOverlap('seed/infra/**', 'docs/x.md'));
  assert.ok(!pathsOverlap('src/*.ts', 'src/sub/a.ts'));
  assert.ok(!pathsOverlap('docs/**', 'src/**'));
});

test('a ticket waits for an older ticket with an open agent pull request on the same files, and starts when that issue closes', async () => {
  let pulls = [agentPull(50, 5)];
  const { jobs, dispatcher, forgejo } = await buildSameFiles({
    ['GET ' + API + '/pulls']: () => pulls,
    ['GET ' + API + '/pulls/50/files']: [{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }],
    ['GET ' + API + '/issues/5/blocks']: []
  });
  assert.equal((await dispatcher.enqueue(ticket('ai:ready', 9, filesBody('src/b.ts')))).status, 'queued');
  await dispatcher.tick();
  assert.equal(starts().length, 0);
  const job = jobs.list(true)[0];
  assert.equal(job.status, 'waiting');
  assert.deepEqual(job.waiting_for_files, [5]);
  pulls = [];
  await dispatcher.onClosed({ type: 'issues.closed', repository: event('x').repository, issue: { number: 5 }, sender: { login: 'marcel' } });
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.equal(jobs.list(true)[0].waiting_for_files, undefined);
});

test('a ticket whose files do not overlap, or that declares none, is not held', async () => {
  const { dispatcher } = await buildSameFiles({
    ['GET ' + API + '/pulls']: [agentPull(50, 5)],
    ['GET ' + API + '/pulls/50/files']: [{ filename: 'src/a.ts' }]
  });
  await dispatcher.enqueue(ticket('ai:ready', 9, filesBody('src/other.ts')));
  await dispatcher.enqueue(ticket('ai:ready', 10, 'No section here, src/a.ts'));
  await dispatcher.tick();
  assert.equal(starts().length, 2);
});

test('a ticket never waits for a newer ticket, and two tickets on the same files cannot wait for each other', async () => {
  const { jobs, dispatcher } = await buildSameFiles({
    ['GET ' + API + '/pulls']: [agentPull(60, 12)],
    ['GET ' + API + '/pulls/60/files']: [{ filename: 'src/a.ts' }],
    ['GET ' + API + '/issues/7']: { number: 7, state: 'open' }
  });
  assert.equal((await dispatcher.enqueue(ticket('ai:ready', 7, filesBody('src/a.ts')))).status, 'queued');
  assert.equal((await dispatcher.enqueue(ticket('ai:ready', 8, filesBody('src/a.ts')))).status, 'queued');
  await dispatcher.tick();
  const [seven, eight] = jobs.list(true).sort((a, b) => a.event.issue.number - b.event.issue.number);
  assert.equal(seven.status, 'running', 'the open pull request of #12 does not hold #7');
  assert.equal(eight.status, 'waiting');
  assert.deepEqual(eight.waiting_for_files, [7]);
  assert.equal(seven.waiting_for_files, undefined);
});

test('WAIT_FOR_SAME_FILES is off by default', async () => {
  const { dispatcher } = await buildSameFiles({
    ['GET ' + API + '/pulls']: [agentPull(50, 5)],
    ['GET ' + API + '/pulls/50/files']: [{ filename: 'src/a.ts' }]
  }, { WAIT_FOR_SAME_FILES: undefined });
  assert.equal(loadConfig(env()).waitForSameFiles, false);
  await dispatcher.enqueue(ticket('ai:ready', 9, filesBody('src/a.ts')));
  await dispatcher.tick();
  assert.equal(starts().length, 1);
  assert.throws(() => loadConfig(env({ WAIT_FOR_SAME_FILES: 'yes' })), /WAIT_FOR_SAME_FILES must be 0 or 1/);
});

test('a forge read error does not hold a ticket that waits for the same files', async () => {
  const { dispatcher } = await buildSameFiles({
    ['GET ' + API + '/pulls']: [agentPull(50, 5)] // the files of the pull request answer 404
  });
  await dispatcher.enqueue(ticket('ai:ready', 9, filesBody('src/a.ts')));
  await dispatcher.tick();
  assert.equal(starts().length, 1);
});
