import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const base = {
  FORGE_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  ALLOWED_REPOS: 'team/app',
};
const webhook = {
  ...base,
  OPENHANDS_WEBHOOK_SECRET: 'openhands-test-secret-long-enough',
  OPENHANDS_WEBHOOK_URL: 'http://127.0.0.1:9999/v1/events/org/forgehands',
};
const direct = {
  ...base,
  OPENHANDS_API_URL: 'http://openhands:8000',
  OPENHANDS_API_KEY: 'k'.repeat(24),
  LABEL_ROUTES: JSON.stringify({ 'ai:ready': { profile: '22222222-2222-4222-8222-222222222222' } }),
};

function load(overrides: Record<string, string> = {}) {
  return loadConfig({ ...webhook, ...overrides });
}
function release(value: unknown): string {
  return JSON.stringify(value);
}
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

test('an unset RELEASE_REPOS is an empty map in webhook and direct mode', () => {
  assert.deepEqual([...loadConfig(webhook).releaseRepos], []);
  assert.deepEqual([...loadConfig(direct).releaseRepos], []);
});

test('a blank RELEASE_REPOS is an empty map', () => {
  assert.equal(load({ RELEASE_REPOS: '   ' }).releaseRepos.size, 0);
});

test('an empty entry gets the documented defaults and leaves the optional settings absent', () => {
  const config = load({ RELEASE_REPOS: release({ 'Team/App': {} }) });
  assert.deepEqual([...config.releaseRepos.keys()], ['team/app']);
  const repo = config.releaseRepos.get('team/app')!;
  assert.deepEqual(repo, {
    tagPattern: 'v{version}',
    versionFiles: ['package.json', 'package-lock.json'],
    changelogPath: 'CHANGELOG.md',
    prereleaseIdentifier: 'rc',
  });
  assert.equal('upgradeNotesPath' in repo, false);
  assert.equal('artifact' in repo, false);
  assert.equal('deployment' in repo, false);
});

test('a GitLab subgroup key is accepted and normalized', () => {
  const config = load({ RELEASE_REPOS: release({ 'Group/Sub/App': {} }) });
  assert.deepEqual([...config.releaseRepos.keys()], ['group/sub/app']);
});

test('explicit scalars, a container artifact and a deployment override the defaults', () => {
  const config = load({
    RELEASE_REPOS: release({
      'team/app': {
        tag_pattern: 'release-{version}',
        version_files: ['Cargo.toml', 'crates/app/Cargo.toml'],
        changelog_path: 'docs/CHANGES.md',
        prerelease_identifier: 'beta-1',
        upgrade_notes_path: 'docs/UPGRADING.md',
        artifact_check: { kind: 'container', image: 'ghcr.io/team/app', tag_forms: ['v{version}', 'sha-{version}'] },
        deployment: { repository: 'team/infra', file: 'deploy/app.yml', pin_pattern: 'image: team/app:.*' },
      },
    }),
  });
  assert.deepEqual(config.releaseRepos.get('team/app'), {
    tagPattern: 'release-{version}',
    versionFiles: ['Cargo.toml', 'crates/app/Cargo.toml'],
    changelogPath: 'docs/CHANGES.md',
    prereleaseIdentifier: 'beta-1',
    upgradeNotesPath: 'docs/UPGRADING.md',
    artifact: { kind: 'container', image: 'ghcr.io/team/app', tagForms: ['v{version}', 'sha-{version}'] },
    deployment: { repository: 'team/infra', file: 'deploy/app.yml', pinPattern: 'image: team/app:.*' },
  });
});

test('an npm artifact is loaded and a container without tag_forms keeps the key absent', () => {
  const npm = load({
    RELEASE_REPOS: release({
      'team/app': { artifact_check: { kind: 'npm', package: '@team/app', registry: 'https://registry.example' } },
    }),
  }).releaseRepos.get('team/app')!;
  assert.deepEqual(npm.artifact, { kind: 'npm', package: '@team/app', registry: 'https://registry.example' });

  const container = load({
    RELEASE_REPOS: release({ 'team/app': { artifact_check: { kind: 'container', image: 'ghcr.io/team/app' } } }),
  }).releaseRepos.get('team/app')!;
  assert.deepEqual(container.artifact, { kind: 'container', image: 'ghcr.io/team/app' });
  assert.equal('tagForms' in container.artifact!, false);
});

test('direct mode loads the same settings', () => {
  const config = loadConfig({
    ...direct,
    RELEASE_REPOS: release({ 'team/app': { tag_pattern: 'v{version}', version_files: ['Cargo.toml'] } }),
  });
  assert.equal(config.mode, 'direct');
  assert.deepEqual(config.releaseRepos.get('team/app'), {
    tagPattern: 'v{version}',
    versionFiles: ['Cargo.toml'],
    changelogPath: 'CHANGELOG.md',
    prereleaseIdentifier: 'rc',
  });
});

test('malformed JSON is rejected without echoing the payload', () => {
  const message = messageOf(() => load({ RELEASE_REPOS: '{"team/app": {"tag_pattern": "secret-payload-9"}' }));
  assert.match(message, /^RELEASE_REPOS must be a JSON object/);
  assert.ok(!message.includes('secret-payload-9'));
});

test('a non-object root is rejected', () => {
  for (const raw of ['null', '[]', '"x"', '42']) {
    assert.throws(() => load({ RELEASE_REPOS: raw }), /RELEASE_REPOS must be a JSON object/);
  }
});

test('a non-object entry is rejected with its repository key and without the entry value', () => {
  for (const entry of [null, [], 'x', 42]) {
    assert.throws(
      () => load({ RELEASE_REPOS: release({ 'team/app': entry }) }),
      /RELEASE_REPOS\[team\/app\]: must be an object/,
    );
  }
});

test('an invalid repository key is rejected without echoing it', () => {
  const message = messageOf(() => load({ RELEASE_REPOS: release({ 'not a key secret-7': {} }) }));
  assert.match(message, /^RELEASE_REPOS: invalid repository key/);
  assert.ok(!message.includes('secret-7'));
});

test('unsafe version files, changelog and upgrade notes are rejected under their field', () => {
  const unsafe = (field: string) => new RegExp('RELEASE_REPOS\\[team/app\\]\\.' + field + ': must be a safe relative file path');
  for (const file of ['../secret.yml', '/etc/secret', 'C:\\secret', '\\\\secret', '   ']) {
    assert.throws(() => load({ RELEASE_REPOS: release({ 'team/app': { version_files: [file] } }) }), unsafe('version_files'));
    assert.throws(() => load({ RELEASE_REPOS: release({ 'team/app': { changelog_path: file } }) }), unsafe('changelog_path'));
    assert.throws(() => load({ RELEASE_REPOS: release({ 'team/app': { upgrade_notes_path: file } }) }), unsafe('upgrade_notes_path'));
  }
});

test('a path diagnostic names the field and never echoes the rejected path', () => {
  const message = messageOf(() => load({
    RELEASE_REPOS: release({ 'team/app': { changelog_path: '../secret-token-42' } }),
  }));
  assert.match(message, /RELEASE_REPOS\[team\/app\]\.changelog_path: must be a safe relative file path/);
  assert.ok(!message.includes('secret-token-42'));
});

test('a tag pattern with no placeholder or more than one is rejected', () => {
  for (const tag of ['v1.0.0', 'v{version}-{version}', '', 42]) {
    assert.throws(
      () => load({ RELEASE_REPOS: release({ 'team/app': { tag_pattern: tag } }) }),
      /RELEASE_REPOS\[team\/app\]\.tag_pattern: must be a string with exactly one literal \{version\}/,
    );
  }
});

test('one nonempty prerelease identifier without a leading zero is accepted', () => {
  for (const identifier of ['rc', 'beta-1', 'RC', '0', '1', '123']) {
    const config = load({ RELEASE_REPOS: release({ 'team/app': { prerelease_identifier: identifier } }) });
    assert.equal(config.releaseRepos.get('team/app')?.prereleaseIdentifier, identifier);
  }
});

test('an invalid prerelease identifier is rejected', () => {
  for (const identifier of ['01', '00', 'rc.1', 'beta_1', ' rc', 42]) {
    assert.throws(
      () => load({ RELEASE_REPOS: release({ 'team/app': { prerelease_identifier: identifier } }) }),
      /RELEASE_REPOS\[team\/app\]\.prerelease_identifier: must be one SemVer prerelease identifier/,
    );
  }
});

test('an artifact of the wrong shape is rejected under artifact_check', () => {
  for (const artifact of [null, [], 'x', 42]) {
    assert.throws(
      () => load({ RELEASE_REPOS: release({ 'team/app': { artifact_check: artifact } }) }),
      /RELEASE_REPOS\[team\/app\]\.artifact_check: must be an object/,
    );
  }
});

test('a deployment of the wrong shape is rejected under deployment', () => {
  for (const deployment of [null, [], 'x', 42]) {
    assert.throws(
      () => load({ RELEASE_REPOS: release({ 'team/app': { deployment } }) }),
      /RELEASE_REPOS\[team\/app\]\.deployment: must be an object/,
    );
  }
});

test('artifact diagnostics name the field and never echo credentials or the kind', () => {
  const registryMessage = messageOf(() => load({
    RELEASE_REPOS: release({
      'team/app': { artifact_check: { kind: 'npm', package: 'app', registry: 'https://user:pass-secret@registry.example' } },
    }),
  }));
  assert.match(registryMessage, /RELEASE_REPOS\[team\/app\]\.artifact_check\.registry: must be an http\(s\) URL without credentials/);
  assert.ok(!registryMessage.includes('pass-secret'));

  const kindMessage = messageOf(() => load({
    RELEASE_REPOS: release({ 'team/app': { artifact_check: { kind: 'secret-kind-3' } } }),
  }));
  assert.match(kindMessage, /RELEASE_REPOS\[team\/app\]\.artifact_check\.kind: must be "container" or "npm"/);
  assert.ok(!kindMessage.includes('secret-kind-3'));
});

test('deployment diagnostics name the field and never echo the repository key', () => {
  const message = messageOf(() => load({
    RELEASE_REPOS: release({
      'team/app': { deployment: { repository: 'bad secret-8', file: 'deploy/app.yml', pin_pattern: 'x' } },
    }),
  }));
  assert.match(message, /RELEASE_REPOS\[team\/app\]\.deployment\.repository: must be a repository key such as owner\/name/);
  assert.ok(!message.includes('secret-8'));
});
