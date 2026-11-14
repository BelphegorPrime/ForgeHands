import { createServer } from 'node:http';
import { deliveryId, signPayload, verifyForgejoSignature } from './security.mjs';
import { normalizeEvent } from './events.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp(config, store, send = fetch, logger = console, dispatcher = null) {
  if (config.mode === 'direct' && !dispatcher) throw new Error('direct mode needs a dispatcher');
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { status: 'ok' });
    }
    if (req.method !== 'POST' || req.url !== '/webhooks/forgejo') {
      return json(res, 404, { error: 'not_found' });
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return json(res, 415, { error: 'expected_json' });
    }
    let raw;
    try { raw = await readBody(req, config.maxBodyBytes); }
    catch (error) { return json(res, error.status || 400, { error: 'invalid_body' }); }
    if (!verifyForgejoSignature(config.forgejoSecret, raw, req.headers['x-forgejo-signature'])) {
      return json(res, 401, { error: 'invalid_signature' });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { return json(res, 400, { error: 'invalid_json' }); }
    const event = req.headers['x-forgejo-event'];
    const normalized = normalizeEvent(event, body, config.allowedRepos, config.routes.keys(), { labelEvents: config.mode === 'direct' });
    if (!normalized) return json(res, 202, { status: 'ignored' });
    if (config.allowedSenders && !config.allowedSenders.has(String(normalized.sender.login || '').toLowerCase())) {
      return json(res, 202, { status: 'ignored' });
    }
    const id = deliveryId(req.headers, raw, event);
    const key = normalized.repository.full_name.toLowerCase() + ':' + id;
    const state = store.acquire(key);
    if (state === 'completed') return json(res, 200, { status: 'duplicate', delivery_id: id });
    if (state === 'inflight') return json(res, 503, { error: 'delivery_in_progress' });
    normalized.delivery_id = id;
    if (config.mode === 'direct') {
      try {
        const result = await dispatcher.enqueue(normalized);
        await store.mark(key);
        return json(res, 202, { status: result.status, delivery_id: id });
      } catch (error) {
        logger.error('Enqueue failed:', error.message);
        return json(res, 500, { error: 'enqueue_failed' });
      } finally {
        store.release(key);
      }
    }
    const outgoing = Buffer.from(JSON.stringify(normalized));
    try {
      const response = await send(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Signature-256': signPayload(config.openhandsSecret, outgoing),
          'X-ForgeHands-Delivery': id
        },
        body: outgoing,
        signal: AbortSignal.timeout(config.timeoutMs),
        redirect: 'error'
      });
      if (!response.ok) {
        logger.error('OpenHands webhook returned', response.status);
        return json(res, 502, { error: 'upstream_rejected', status_code: response.status });
      }
      await store.mark(key);
      return json(res, 202, { status: 'forwarded', delivery_id: id });
    } catch (error) {
      logger.error('OpenHands webhook delivery failed:', error.message);
      return json(res, 502, { error: 'upstream_unavailable' });
    } finally {
      store.release(key);
    }
  });
}
