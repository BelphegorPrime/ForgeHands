// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Comment mode: an approval needs a review comment with a verdict.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { buildPrompt } from '../src/agent/prompt.ts';
import { env, starts, sensitiveRoutes, withCi, ciEvent, withMerge, API, VERDICT_OK, goodRoutes, mergerFor, approvedEvent, commentsOf, commentsRoute, verdict, blockRoutes } from './helpers/direct.ts';

test('an approval without a review comment is not trusted: nothing is merged, the label comes off, the human is called', async () => {
  const { merger, forgejo } = await mergerFor(goodRoutes({ ...commentsRoute([]), ...blockRoutes }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await merger.handle(approvedEvent()), 'no_valid_review');
  assert.deepEqual(forgejo.wrote(), ['DELETE /issues/34/labels/5', 'POST /issues/34/comments', 'POST /issues/34/labels']);
  const text = commentsOf(forgejo)[0];
  assert.match(text, /^@marcel ForgeHands: the label ai:approved was set, but there is no review comment for commit cafe0000 that starts with "Verdict: OK"/);
  assert.match(text, /The approval is not trusted and was taken off/);
  assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'));
});

test('an approval label that arrives before the verdict comment is checked again after the grace time, not taken off at once', async () => {
  const timers = [];
  const later = (run, ms) => timers.push({ run, ms });
  const routes = goodRoutes({ ...commentsRoute([]), ...blockRoutes });
  const waiting = await mergerFor(routes, { APPROVAL_GRACE_SECONDS: '90', HUMAN_LOGIN: 'marcel' }, later);
  assert.equal(await waiting.merger.handle(approvedEvent()), 'awaiting_review');
  assert.deepEqual(waiting.forgejo.wrote(), [], 'nothing is touched while waiting');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 90000);
  // The verdict arrived meanwhile: the second look merges.
  const merged = await mergerFor(goodRoutes(commentsRoute([verdict(VERDICT_OK, '2026-11-15T11:00:00Z')])), { APPROVAL_GRACE_SECONDS: '90' }, later);
  assert.equal(await merged.merger.handle(approvedEvent(), true), 'merged');
  // Still no verdict at the second look: the approval is taken off as before, and there is no third wait.
  const still = await mergerFor(routes, { APPROVAL_GRACE_SECONDS: '90', HUMAN_LOGIN: 'marcel' }, later);
  assert.equal(await still.merger.handle(approvedEvent(), true), 'no_valid_review');
  assert.equal(timers.length, 1);
  assert.throws(() => loadConfig(env(withMerge({ APPROVAL_GRACE_SECONDS: '-1' }))), /APPROVAL_GRACE_SECONDS/);
});

test('the hand-over names why a human is needed (MERGE_POLICY reasons) and waits for a security review still under way', async () => {
  const policy = JSON.stringify({ 'owner/hello': { deny: ['compose.yaml', '.github/**'], reasons: { 'compose.yaml': 'it deploys the stack' } } });
  const routes = goodRoutes({ ['GET ' + API + '/pulls/34/files']: [{ filename: 'compose.yaml' }, { filename: '.github/workflows/a.yaml' }] });
  const { merger, forgejo } = await mergerFor(routes, { MERGE_POLICY: policy, HUMAN_LOGIN: 'marcel' });
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  const text = commentsOf(forgejo).at(-1);
  assert.match(text, /- `compose\.yaml`: it deploys the stack \(compose\.yaml\)/);
  assert.match(text, /- `\.github\/\*\*` \(\.github\/workflows\/a\.yaml\)/);
  const waiting = await mergerFor(routes, { MERGE_POLICY: policy, LABEL_ROUTES: sensitiveRoutes() });
  waiting.merger.securityPending = () => true;
  assert.equal(await waiting.merger.handle(approvedEvent()), 'awaiting_security_review');
  assert.ok(!waiting.forgejo.wrote().includes('POST /issues/34/comments'), 'no hand-over while the security review runs');
  waiting.merger.securityPending = () => false;
  assert.equal(await waiting.merger.handle(approvedEvent()), 'protected_paths');
  assert.match(commentsOf(waiting.forgejo).at(-1), /There is no security review of this commit yet\./);
  for (const bad of [{ deny: ['a'], reasons: { b: 'x' } }, { deny: ['a'], reasons: { a: '' } }, { deny: ['a'], reasons: ['x'] }]) {
    assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: JSON.stringify({ 'owner/hello': bad }) }))), /reasons of owner\/hello/);
  }
});

test('what does not count as a review: too short, no verdict line, a verdict deep in the text, older than the commit', async () => {
  const cases = {
    'too short': [verdict('## Verdict: OK looks fine')],
    'no verdict line': [verdict('The change looks good to me and I checked it. '.repeat(12))],
    'verdict beyond the first 300 characters': [verdict('x'.repeat(320) + ' Verdict: OK ' + 'e'.repeat(60))],
    'older than the commit': [verdict(VERDICT_OK, '2026-11-15T09:00:00Z')],
    'another word': [verdict('## Verdict: maybe\n' + 'evidence '.repeat(50))]
  };
  for (const [name, comments] of Object.entries(cases)) {
    const { merger, forgejo } = await mergerFor(goodRoutes({ ...commentsRoute(comments), ...blockRoutes }));
    assert.equal(await merger.handle(approvedEvent()), 'no_valid_review', name);
    assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'), name);
  }
});

test('a NOT OK review, also when it is the latest after an OK, stops the merge; a later OK lets it through', async () => {
  const notOk = '## Verdict: NOT OK\n' + 'evidence at src/a.mjs line 3 and the failing command. '.repeat(8);
  const stopped = await mergerFor(goodRoutes({ ...commentsRoute([verdict(VERDICT_OK, '2026-11-15T11:00:00Z'), verdict(notOk, '2026-11-15T11:30:00Z')]), ...blockRoutes }), { HUMAN_LOGIN: 'marcel' });
  assert.equal(await stopped.merger.handle(approvedEvent()), 'no_valid_review');
  assert.match(commentsOf(stopped.forgejo)[0], /says NOT OK/);
  const fixed = await mergerFor(goodRoutes(commentsRoute([verdict(notOk, '2026-11-15T11:00:00Z'), verdict(VERDICT_OK, '2026-11-15T11:30:00Z')])));
  assert.equal(await fixed.merger.handle(approvedEvent()), 'merged');
});

test('a real review comment lets the merge through; the reviewer or a human may have written it; a markdown heading and bold are fine', async () => {
  for (const body of [VERDICT_OK, '**Verdict: OK**\n' + 'evidence '.repeat(50), 'verdict: ok - ' + 'evidence '.repeat(50)]) {
    const { merger } = await mergerFor(goodRoutes(commentsRoute([verdict(body, '2026-11-15T11:00:00Z', 'marcel')])));
    assert.equal(await merger.handle(approvedEvent()), 'merged');
  }
});

test('MIN_REVIEW_CHARS is configurable; an unreadable commit time counts every review comment; a failing read is a failed merge, not a pass', async () => {
  const short = '## Verdict: OK\n' + 'e'.repeat(120);
  const strict = await mergerFor(goodRoutes({ ...commentsRoute([verdict(short)]), ...blockRoutes }), { MIN_REVIEW_CHARS: '500' });
  assert.equal(await strict.merger.handle(approvedEvent()), 'no_valid_review');
  const lenient = await mergerFor(goodRoutes(commentsRoute([verdict(short)])), { MIN_REVIEW_CHARS: '100' });
  assert.equal(await lenient.merger.handle(approvedEvent()), 'merged');
  const noTime = await mergerFor(goodRoutes({ ['GET ' + API + '/git/commits/cafe0000cafe']: undefined, ...commentsRoute([verdict(VERDICT_OK, '2026-01-01T00:00:00Z')]) }));
  assert.equal(await noTime.merger.handle(approvedEvent()), 'merged');
  const failing = await mergerFor(goodRoutes({ ['GET ' + API + '/issues/34/comments']: undefined }));
  assert.equal(await failing.merger.handle(approvedEvent()), 'merge_failed');
  assert.ok(!failing.forgejo.wrote().includes('POST /pulls/34/merge'));
  assert.throws(() => loadConfig(env(withMerge({ MIN_REVIEW_CHARS: '0' }))), /MIN_REVIEW_CHARS/);
});

test('the review prompt asks for the verdict line and for reading each output before judging', () => {
  const text = buildPrompt(ciEvent('success'), loadConfig(env(withCi())));
  assert.match(text, /BEGINS with the line `## Verdict: OK` or `## Verdict: NOT OK`/);
  assert.match(text, /Do not send the commands of several steps in one turn/);
  assert.match(text, /Also check against reality/);
  assert.match(text, /a test with a fake proves nothing/);
  assert.match(text, /character by character/);
});
