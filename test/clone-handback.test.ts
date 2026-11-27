// The clone hand-back classifier: a pure decision on one forge comment. The clock and the comment are plain values, so every window and
// attribution rule is exercised without a forge or a running agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLONE_RETRY_DELAY_MS, CLONE_RETRY_LIMIT, classifyCloneHandback } from '../src/agent/clone-handback.ts';
import type { CloneHandbackInput } from '../src/agent/clone-handback.ts';

const NOW = 1_700_000_000_000;
const STARTED = NOW - 5 * 60_000;
const REPO = 'owner/hello';
const ISSUE = 7;
const CONVERSATION = 'conv-abc-123';
const AGENT = 'forgehands-agent';
const BODY = 'git clone https://forge.example/owner/hello.git failed: fatal: transport error';

const comment = (body: unknown, patch: Partial<CloneHandbackInput['comment']> = {}): CloneHandbackInput['comment'] => ({
  login: AGENT, created_at: new Date(NOW - 3 * 60_000).toISOString(), body, ...patch
});

const input = (body: unknown, patch: Partial<CloneHandbackInput> = {}): CloneHandbackInput => ({
  comment: comment(body), agentLogin: AGENT, runStarted: STARTED, now: NOW, repository: REPO, issue: ISSUE,
  conversation: CONVERSATION, scope: 'ticket', ...patch
});

const accepted = (value: ReturnType<typeof classifyCloneHandback>) => {
  assert.ok(value);
  return value;
};

test('the retry delay and limit are the documented defaults', () => {
  assert.equal(CLONE_RETRY_DELAY_MS, 10 * 60_000);
  assert.equal(CLONE_RETRY_LIMIT, 3);
});

test('accepts a generic failed clone as clone_failed', () => {
  assert.deepEqual(classifyCloneHandback(input(BODY)), { class: 'clone_failed', repository: REPO, conversation: CONVERSATION });
});

test('accepts repository not found as repository_not_found', () => {
  assert.equal(accepted(classifyCloneHandback(input("git clone https://forge.example/o/r.git failed: remote: Repository not found"))).class, 'repository_not_found');
});

test('accepts a doubled host as host_misconfigured', () => {
  assert.equal(accepted(classifyCloneHandback(input('git clone https://forge.example/https://forge.example/o/r.git'))).class, 'host_misconfigured');
});

test('accepts a could-not-resolve host as host_misconfigured', () => {
  assert.equal(accepted(classifyCloneHandback(input('git clone: could not resolve host: forge.example'))).class, 'host_misconfigured');
});

test('accepts authentication failed as auth_failed', () => {
  assert.equal(accepted(classifyCloneHandback(input("git clone https://forge.example/o/r.git: authentication failed for 'https://forge.example/o/r.git'"))).class, 'auth_failed');
});

test('accepts could not read username as auth_failed', () => {
  assert.equal(accepted(classifyCloneHandback(input("git clone failed: fatal: could not read Username for 'https://forge.example': terminal prompts disabled"))).class, 'auth_failed');
});

test('treats a differently cased agent login as the same identity', () => {
  assert.notEqual(classifyCloneHandback(input(BODY, { agentLogin: 'ForgeHands-Agent' })), null);
});

test('rejects a comment from another author', () => {
  assert.equal(classifyCloneHandback(input(BODY, { comment: comment(BODY, { login: 'human-user' }) })), null);
});

test('rejects a report when the agent has no login', () => {
  assert.equal(classifyCloneHandback(input(BODY, { agentLogin: null })), null);
});

test('rejects a report when the comment has no login', () => {
  assert.equal(classifyCloneHandback(input(BODY, { comment: comment(BODY, { login: null }) })), null);
});

test('rejects a report older than the breaker window', () => {
  const stale = comment(BODY, { created_at: new Date(NOW - 11 * 60_000).toISOString() });
  assert.equal(classifyCloneHandback(input(BODY, { comment: stale, runStarted: NOW - 20 * 60_000 })), null);
});

test('rejects a future-dated report', () => {
  const future = comment(BODY, { created_at: new Date(NOW + 60_000).toISOString() });
  assert.equal(classifyCloneHandback(input(BODY, { comment: future })), null);
});

test('rejects a report dated before the run started', () => {
  const early = comment(BODY, { created_at: new Date(STARTED - 2 * 60_000).toISOString() });
  assert.equal(classifyCloneHandback(input(BODY, { comment: early })), null);
});

test('rejects a bare API 404 without clone context', () => {
  assert.equal(classifyCloneHandback(input('HTTP 404')), null);
});

test('rejects 404 text that is not a clone failure', () => {
  assert.equal(classifyCloneHandback(input('GET /api/v1/repos/owner/hello returned 404 not found')), null);
});

test('rejects clone text whose only symptom is a bare 404', () => {
  assert.equal(classifyCloneHandback(input('git clone failed: HTTP 404 not found')), null);
});

test('rejects a parent comment with no attribution', () => {
  assert.equal(classifyCloneHandback(input(BODY, { scope: 'parent' })), null);
});

test('accepts a parent comment attributed by repository and issue', () => {
  assert.notEqual(classifyCloneHandback(input('git clone failed: fatal: x ' + REPO + '#' + ISSUE, { scope: 'parent' })), null);
});

test('accepts a parent comment attributed by conversation id, case-insensitively', () => {
  assert.notEqual(classifyCloneHandback(input('git clone failed: fatal: x ' + CONVERSATION.toUpperCase(), { scope: 'parent' })), null);
});

test('rejects an ambiguous concurrent parent report', () => {
  assert.equal(classifyCloneHandback(input(BODY, { scope: 'parent', concurrentRuns: 2 })), null);
});

test('accepts a report on a pull request by its location alone', () => {
  assert.notEqual(classifyCloneHandback(input(BODY, { scope: 'pull_request', concurrentRuns: 2 })), null);
});

test('returns only class, repository and conversation and never the comment text', () => {
  const marker = 'DISTINCTIVE-TOKEN-42';
  const result = accepted(classifyCloneHandback(input('git clone failed: fatal: ' + marker)));
  assert.deepEqual(Object.keys(result).sort(), ['class', 'conversation', 'repository']);
  assert.equal(JSON.stringify(result).includes(marker), false);
});
