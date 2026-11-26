import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseFile } from '../src/release-config.ts';

const ctx = { source: 'RELEASE_REPOS', repository: 'acme/app', field: 'deployment.file' } as const;
const unsafe = /must be a safe relative file path/;

test('parseReleaseFile accepts a plain file name', () => {
  assert.equal(parseReleaseFile('compose.yaml', ctx), 'compose.yaml');
});

test('parseReleaseFile accepts a nested relative path', () => {
  assert.equal(parseReleaseFile('deploy/app.yml', ctx), 'deploy/app.yml');
});

test('parseReleaseFile accepts dot-dot inside a segment but not a whole segment', () => {
  assert.equal(parseReleaseFile('a..b', ctx), 'a..b');
  assert.equal(parseReleaseFile('..foo', ctx), '..foo');
});

test('parseReleaseFile accepts a dot segment and a backslash path', () => {
  assert.equal(parseReleaseFile('./x', ctx), './x');
  assert.equal(parseReleaseFile('.\\x', ctx), '.\\x');
});

test('parseReleaseFile rejects non-strings', () => {
  assert.throws(() => parseReleaseFile(42, ctx), unsafe);
  assert.throws(() => parseReleaseFile(null, ctx), unsafe);
});

test('parseReleaseFile rejects blank and whitespace-only values', () => {
  assert.throws(() => parseReleaseFile('', ctx), unsafe);
  assert.throws(() => parseReleaseFile('   ', ctx), unsafe);
});

test('parseReleaseFile rejects POSIX absolute paths', () => {
  assert.throws(() => parseReleaseFile('/etc/x', ctx), unsafe);
});

test('parseReleaseFile rejects Windows rooted paths', () => {
  assert.throws(() => parseReleaseFile('\\srv\\x', ctx), unsafe);
  assert.throws(() => parseReleaseFile('\\x', ctx), unsafe);
});

test('parseReleaseFile rejects Windows drive-qualified paths', () => {
  assert.throws(() => parseReleaseFile('C:file', ctx), unsafe);
  assert.throws(() => parseReleaseFile('C:\\x', ctx), unsafe);
  assert.throws(() => parseReleaseFile('C:/x', ctx), unsafe);
});

test('parseReleaseFile rejects a parent segment on either separator', () => {
  assert.throws(() => parseReleaseFile('../x', ctx), unsafe);
  assert.throws(() => parseReleaseFile('a/../b', ctx), unsafe);
  assert.throws(() => parseReleaseFile('a\\..\\b', ctx), unsafe);
  assert.throws(() => parseReleaseFile('..', ctx), unsafe);
});

test('parseReleaseFile error names the field and not the rejected input', () => {
  let message = '';
  try {
    parseReleaseFile('../secret-token-123', ctx);
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /RELEASE_REPOS\[acme\/app\]\.deployment\.file: /);
  assert.ok(!message.includes('../secret-token-123'));
});
