// @ts-nocheck -- fixtures and fakes are deliberately loose; typing them is a follow-up (src/ is checked strictly).
// Two keys: protected files merged with a security review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { env, sensitiveRoutes, withMerge, approvedEvent, commentsOf, pull, TWO_POLICY, securityComment, twoKeyRoutes, twoKeys } from './helpers/direct.ts';

test('two keys: only two_keys files under the deny list plus a security review OK merge', async () => {
  const { merger, forgejo } = await twoKeys(['seed/infra/tests/a.test.ts', 'seed/infra/README.md', 'docs/x.md'], [securityComment('OK')]);
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.ok(forgejo.wrote().includes('POST /pulls/34/merge'));
  assert.match(commentsOf(forgejo).at(-1), /merged: approved by the reviewer and the security review, CI green; the protected paths it touches are configured for two keys\./);
});

test('two keys: one deny file outside two_keys keeps the human, and the hand-over names what would have qualified', async () => {
  const { merger, forgejo } = await twoKeys(['seed/infra/tests/a.test.ts', 'seed/infra/main.ts'], [securityComment('OK')]);
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'));
  assert.match(commentsOf(forgejo).at(-1), /seed\/infra\/tests\/a\.test\.ts would qualify for two keys/);
});

test('two keys: CONCERNS stays with the human, a missing review hands over, a pending one waits', async () => {
  const files = ['seed/infra/tests/a.test.ts'];
  const concerns = await twoKeys(files, [securityComment('CONCERNS')]);
  assert.equal(await concerns.merger.handle(approvedEvent()), 'protected_paths');
  assert.ok(!concerns.forgejo.wrote().includes('POST /pulls/34/merge'));
  const other = await twoKeys(files, [securityComment('OK', '11111111')]);
  assert.equal(await other.merger.handle(approvedEvent()), 'protected_paths', 'a review of another commit is no key');
  const missing = await twoKeys(files, []);
  missing.merger.securityPending = () => true;
  assert.equal(await missing.merger.handle(approvedEvent()), 'awaiting_security_review');
  assert.ok(!missing.forgejo.wrote().includes('POST /pulls/34/merge'));
  missing.merger.securityPending = () => false;
  assert.equal(await missing.merger.handle(approvedEvent()), 'protected_paths');
  assert.ok(!missing.forgejo.wrote().includes('POST /pulls/34/merge'));
});

test('two keys: without a sensitive_review route nothing merges', async () => {
  const { merger, forgejo } = await twoKeys(['seed/infra/tests/a.test.ts'], [securityComment('OK')], { LABEL_ROUTES: env().LABEL_ROUTES });
  assert.equal(await merger.handle(approvedEvent()), 'protected_paths');
  assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'));
});

test('two keys: a security review that arrives after the approval merges when the hand-over is looked at again', async () => {
  const files = ['seed/infra/README.md'];
  const { merger, forgejo, all } = await twoKeys(files, []);
  merger.securityPending = () => true;
  assert.equal(await merger.handle(approvedEvent()), 'awaiting_security_review');
  all.push(securityComment('OK'));
  merger.securityPending = () => false;
  assert.equal(await merger.handle(approvedEvent()), 'merged');
  assert.ok(forgejo.wrote().includes('POST /pulls/34/merge'));
});

test('two keys: the policy is validated, and an entry without two_keys behaves as before', () => {
  const bad = (entry, pattern) => assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: JSON.stringify({ 'owner/hello': entry }), SECURITY_REVIEWERS: 'security-bot' }))), pattern);
  bad({ deny: ['a/**'], two_keys: 'a/x' }, /two_keys of owner\/hello must be a list of patterns/);
  bad({ deny: ['a/**'], two_keys: [''] }, /two_keys of owner\/hello must be a list/);
  bad({ deny: ['a/**'], two_keys: [1] }, /two_keys of owner\/hello must be a list/);
  bad({ two_keys: ['a/x'] }, /needs a deny list/);
  bad({ deny: ['a/**'], two_keys: ['b/**'] }, /not covered by a deny pattern/);
  const rule = (entry) => loadConfig(env(withMerge({ MERGE_POLICY: JSON.stringify({ 'owner/hello': entry }), SECURITY_REVIEWERS: 'security-bot' }))).mergePolicy.get('owner/hello');
  const ok = rule({ deny: ['a/**', 'c.md'], two_keys: ['a/tests/**', 'c.md', 'a/*.md'] });
  assert.deepEqual(ok.twoKeyPatterns, ['a/tests/**', 'c.md', 'a/*.md']);
  assert.ok(ok.twoKeys[0].test('a/tests/x/y.ts'));
  const plain = rule({ deny: ['a/**'] });
  assert.deepEqual([plain.twoKeys, plain.twoKeyPatterns], [[], []]);
});

test('two keys: only the security reviewers named in SECURITY_REVIEWERS count as the second key; two_keys needs the variable', async () => {
  const files = ['seed/infra/tests/a.test.ts'];
  // the same comment written by the author of the pull request (the worker, here "openhands") is no second key
  const forged = await twoKeys(files, [securityComment('OK', 'cafe0000', 'openhands')]);
  assert.equal(await forged.merger.handle(approvedEvent()), 'protected_paths');
  assert.ok(!forged.forgejo.wrote().includes('POST /pulls/34/merge'));
  const genuine = await twoKeys(files, [securityComment('OK')]);
  assert.equal(await genuine.merger.handle(approvedEvent()), 'merged');
  // the latest comment of the reviewer decides, a later forged OK after the reviewer's CONCERNS does not turn it
  const mixed = await twoKeys(files, [securityComment('CONCERNS'), { ...securityComment('OK', 'cafe0000', 'openhands'), created_at: '2026-11-15T11:05:00Z' }]);
  assert.equal(await mixed.merger.handle(approvedEvent()), 'protected_paths');
  assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: TWO_POLICY, LABEL_ROUTES: twoKeyRoutes(), AGENT_SECRETS: 'FORGE_TOKEN,FORGE_URL,SECURITY_TOKEN', SECURITY_TOKEN: 'security-token-value' }))), /two_keys needs SECURITY_REVIEWERS/);
  // two_keys also needs the security route to have a Forgejo user of its own, or the worker could sign as the security reviewer
  assert.throws(() => loadConfig(env(withMerge({ MERGE_POLICY: TWO_POLICY, LABEL_ROUTES: sensitiveRoutes(), SECURITY_REVIEWERS: 'security-bot' }))), /two_keys needs "forgejo_token_secret" on every sensitive_review route/);
  // without two_keys the variable is not needed, and without it every security comment still counts for the advisory line
  assert.doesNotThrow(() => loadConfig(env(withMerge({ MERGE_POLICY: JSON.stringify({ 'owner/hello': { deny: ['compose.yaml'] } }) }))));
});

test('two keys: without TWO_KEYS_HOLD_MINUTES the hold label still stops the merge', async () => {
  const { merger, forgejo } = await twoKeys(['seed/infra/tests/a.test.ts'], [securityComment('OK')]);
  assert.equal(merger.config.twoKeysHoldMinutes, 0, 'no hold period: the two-key gate does not read the label');
  // The pull request carries the approval and the hold label.
  const read = merger.forge.getPull.bind(merger.forge);
  merger.forge.getPull = async (...args) => ({ ...(await read(...args)), labels: [{ name: 'ai:approved' }, { name: 'ai:hold' }] });
  assert.equal(await merger.handle(approvedEvent()), 'held_label');
  assert.ok(!forgejo.wrote().includes('POST /pulls/34/merge'));
});
