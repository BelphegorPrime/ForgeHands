import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { DeliveryStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('failed upstream deliveries are retryable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forgehands-failure-'));
  const config = loadConfig({
    FORGEJO_WEBHOOK_SECRET: 'forgejo-test-secret-long-enough',
    OPENHANDS_WEBHOOK_SECRET: 'openhands-test-secret-long-enough',
    OPENHANDS_WEBHOOK_URL: 'http://127.0.0.1:9999/endpoint',
    ALLOWED_REPOS: 'owner/repo',
    DATA_FILE: join(dir, 'deliveries.json')
  });
  const store = new DeliveryStore(config.dataFile);
  let calls = 0;
  const server = createApp(config, store, async () => {
    calls++;
    return { ok: calls > 1, status: calls > 1 ? 202 : 503 };
  }, { error() {} });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/webhooks/forgejo';
    const raw = JSON.stringify({
      action: 'labeled',
      label: { name: 'ai:ready' },
      issue: { number: 1, labels: [{ name: 'ai:ready' }] },
      repository: { full_name: 'owner/repo' }
    });
    const headers = {
      'content-type': 'application/json',
      'x-forgejo-event': 'issues',
      'x-forgejo-signature': createHmac('sha256', config.forgejoSecret).update(raw).digest('hex'),
      'x-gitea-delivery': 'retry-test'
    };
    assert.equal((await fetch(url, { method: 'POST', headers, body: raw })).status, 502);
    assert.equal((await fetch(url, { method: 'POST', headers, body: raw })).status, 202);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
