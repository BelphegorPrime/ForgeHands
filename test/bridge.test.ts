import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { DeliveryStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { normalizeEvent } from '../src/events.mjs';
import { verifyForgejoSignature } from '../src/security.mjs';

let server;
let base;
let directory;
let store;
const outbound = [];
const repo = 'owner/hello-world';
const config = loadConfig({
  FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
  OPENHANDS_WEBHOOK_SECRET: 'openhands-test-secret-long-enough',
  OPENHANDS_WEBHOOK_URL: 'http://127.0.0.1:9999/v1/events/org/forgehands',
  ALLOWED_REPOS: repo,
  DATA_FILE: join(tmpdir(), 'forgehands-fixture-placeholder.json')
});
config.timeoutMs = 500;
function fixture(overrides = {}) {
  return {
    action: 'labeled',
    label: { name: 'ai:ready' },
    repository: { full_name: repo, clone_url: 'https://forge.example/owner/hello-world.git' },
    issue: { number: 12, title: 'Add greeting', body: 'Implement hello', labels: [{ name: 'ai:ready' }] },
    sender: { login: 'tester' },
    ...overrides
  };
}
async function post(body, opts = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', config.forgejoSecret).update(raw).digest('hex');
  return fetch(base + '/webhooks/forgejo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forgejo-event': opts.event || 'issues',
      'x-forgejo-signature': opts.signature ?? signature,
      'x-gitea-delivery': opts.delivery || 'delivery-001'
    },
    body: raw
  });
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forgehands-'));
  config.dataFile = join(directory, 'deliveries.json');
  store = new DeliveryStore(config.dataFile);
  await store.load();
  server = createApp(config, store, async (url, request) => {
    outbound.push({ url, request });
    return { ok: true, status: 202 };
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});
test('forwards signed, allowed label event', async () => {
  const response = await post(fixture());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'forwarded');
  assert.equal(outbound.length, 1);
  const { request } = outbound[0];
  const digest = createHmac('sha256', config.openhandsSecret).update(request.body).digest('hex');
  assert.equal(request.headers['X-Signature-256'], digest);
  const payload = JSON.parse(request.body.toString());
  assert.equal(payload.type, 'issues.labeled');
  assert.equal(payload.issue.number, 12);
});
test('drops repeated delivery and survives store reload', async () => {
  const response = await post(fixture());
  assert.equal(response.status, 200);
  assert.equal(outbound.length, 1);
  const reload = new DeliveryStore(config.dataFile);
  await reload.load();
  assert.equal(reload.has('owner/hello-world:delivery-001'), true);
});
test('rejects forged signature', async () => {
  const response = await post(fixture(), { signature: '0'.repeat(64), delivery: 'delivery-002' });
  assert.equal(response.status, 401);
  assert.equal(outbound.length, 1);
});
test('rejects malformed signature without throwing', () => {
  assert.equal(verifyForgejoSignature(config.forgejoSecret, Buffer.from('{}'), 'sha256=123'), false);
});
test('ignores repositories not on allowlist', async () => {
  const response = await post(fixture({ repository: { full_name: 'other/repo' } }), { delivery: 'delivery-003' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'ignored');
});
test('ignores unrelated label, other event kinds and non-issues', async () => {
  const response = await post(fixture({ label: { name: 'bug' } }), { delivery: 'delivery-004' });
  assert.equal((await response.json()).status, 'ignored');
  assert.equal(normalizeEvent('push', fixture(), config.allowedRepos), null);
  assert.equal(normalizeEvent('issues', fixture({ action: 'edited' }), config.allowedRepos), null);
  assert.equal(normalizeEvent('issues', fixture({ issue: { number: 2, labels: [] } }), config.allowedRepos), null);
});
test('open with already-applied label is accepted', async () => {
  const response = await post(fixture({ action: 'opened', label: undefined }), { delivery: 'delivery-005' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'forwarded');
});
test('health check is available', async () => {
  const response = await fetch(base + '/healthz');
  assert.equal(response.status, 200);
});
