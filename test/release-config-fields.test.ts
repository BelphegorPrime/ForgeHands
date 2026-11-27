import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseArtifact, parseReleaseFile } from '../src/release-config.ts';

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

const artifactCtx = { source: 'RELEASE_REPOS', repository: 'acme/app', field: 'deployment.artifact' } as const;

test('parseReleaseArtifact accepts a container without tag_forms and omits the key', () => {
  const result = parseReleaseArtifact({ kind: 'container', image: 'ghcr.io/acme/app:1.2.3' }, artifactCtx);
  assert.deepEqual(result, { kind: 'container', image: 'ghcr.io/acme/app:1.2.3' });
  assert.equal('tagForms' in (result as object), false);
});

test('parseReleaseArtifact accepts a container with tag_forms', () => {
  assert.deepEqual(
    parseReleaseArtifact({ kind: 'container', image: 'ghcr.io/acme/app', tag_forms: ['v1.2.3', 'sha-abc'] }, artifactCtx),
    { kind: 'container', image: 'ghcr.io/acme/app', tagForms: ['v1.2.3', 'sha-abc'] },
  );
});

test('parseReleaseArtifact accepts an npm package over http and https', () => {
  assert.deepEqual(
    parseReleaseArtifact({ kind: 'npm', package: '@acme/app', registry: 'https://registry.example' }, artifactCtx),
    { kind: 'npm', package: '@acme/app', registry: 'https://registry.example' },
  );
  assert.deepEqual(
    parseReleaseArtifact({ kind: 'npm', package: '@acme/app', registry: 'http://registry.example/' }, artifactCtx),
    { kind: 'npm', package: '@acme/app', registry: 'http://registry.example/' },
  );
});

test('parseReleaseArtifact preserves an absent artifact', () => {
  assert.equal(parseReleaseArtifact(undefined, artifactCtx), undefined);
});

test('parseReleaseArtifact rejects a non-object', () => {
  const objectError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact: must be an object/;
  assert.throws(() => parseReleaseArtifact(null, artifactCtx), objectError);
  assert.throws(() => parseReleaseArtifact([], artifactCtx), objectError);
  assert.throws(() => parseReleaseArtifact('x', artifactCtx), objectError);
  assert.throws(() => parseReleaseArtifact(42, artifactCtx), objectError);
});

test('parseReleaseArtifact rejects a class instance with valid fields', () => {
  const objectError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact: must be an object/;
  class Artifact {
    kind = 'container';
    image = 'example/app';
  }
  assert.throws(() => parseReleaseArtifact(new Artifact(), artifactCtx), objectError);
});

test('parseReleaseArtifact accepts a null-prototype plain object', () => {
  const input = Object.create(null) as Record<string, unknown>;
  input.kind = 'container';
  input.image = 'example/app';
  assert.deepEqual(parseReleaseArtifact(input, artifactCtx), { kind: 'container', image: 'example/app' });
});

test('parseReleaseArtifact rejects an unknown or missing kind without printing it', () => {
  const kindError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.kind: must be "container" or "npm"/;
  assert.throws(() => parseReleaseArtifact({ kind: 'deb' }, artifactCtx), kindError);
  assert.throws(() => parseReleaseArtifact({ kind: 42 }, artifactCtx), kindError);
  assert.throws(() => parseReleaseArtifact({}, artifactCtx), kindError);
  let message = '';
  try {
    parseReleaseArtifact({ kind: 'secret-kind-123' }, artifactCtx);
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(!message.includes('secret-kind-123'));
});

test('parseReleaseArtifact rejects a blank or non-string container image', () => {
  const imageError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.image: must be a non-empty string/;
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: '' }, artifactCtx), imageError);
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: '   ' }, artifactCtx), imageError);
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: 42 }, artifactCtx), imageError);
});

test('parseReleaseArtifact rejects tag_forms that are not an array of non-blank strings', () => {
  const tagError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.tag_forms: must be an array of non-empty strings/;
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: 'img', tag_forms: 'v1' }, artifactCtx), tagError);
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: 'img', tag_forms: ['a', ''] }, artifactCtx), tagError);
  assert.throws(() => parseReleaseArtifact({ kind: 'container', image: 'img', tag_forms: ['a', 1] }, artifactCtx), tagError);
});

test('parseReleaseArtifact rejects a blank or non-string npm package', () => {
  const packageError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.package: must be a non-empty string/;
  const registry = 'https://registry.example';
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: '', registry }, artifactCtx), packageError);
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: '  ', registry }, artifactCtx), packageError);
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: 42, registry }, artifactCtx), packageError);
});

test('parseReleaseArtifact rejects a registry that is not an http(s) URL', () => {
  const registryError = /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.registry: must be an http\(s\) URL without credentials/;
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: 'pkg', registry: 'ftp://r.example' }, artifactCtx), registryError);
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: 'pkg', registry: 'not a url' }, artifactCtx), registryError);
  assert.throws(() => parseReleaseArtifact({ kind: 'npm', package: 'pkg', registry: 42 }, artifactCtx), registryError);
});

test('parseReleaseArtifact rejects registry credentials without echoing them', () => {
  let message = '';
  try {
    parseReleaseArtifact({ kind: 'npm', package: 'pkg', registry: 'https://user:pass@r.example' }, artifactCtx);
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /RELEASE_REPOS\[acme\/app\]\.deployment\.artifact\.registry: must be an http\(s\) URL without credentials/);
  assert.ok(!message.includes('pass'));
});
