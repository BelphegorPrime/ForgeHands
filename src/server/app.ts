import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { deliveryId, signPayload, verifyForgejoSignature } from '../webhook/security.ts';
import { normalizeEvent } from '../webhook/events.ts';
import { buildStatus, renderStatus } from './status.ts';
import { isPushEvent } from '../types.ts';
import type { Config, DirectConfig, Fetch, ForgeEvent, Logger } from '../types.ts';
import type { DeliveryStore } from '../store/deliveries.ts';
import type { Dispatcher } from '../agent/dispatch.ts';

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError('Payload too large', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp(config: Config, store: DeliveryStore, send: Fetch = fetch, logger: Logger = console, dispatcher: Dispatcher | null = null): Server {
  if (config.mode === 'direct' && !dispatcher) throw new Error('direct mode needs a dispatcher');
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { status: 'ok' });
    }
    // Read only view of the work in flight (direct mode): /status for people, /status.json for tools.
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/status.json') && dispatcher) {
      const status = buildStatus(config as DirectConfig, dispatcher.jobs);
      if (req.url === '/status.json') return json(res, 200, status);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderStatus(status));
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
    const direct = config.mode === 'direct';
    const previousLabels = direct ? dispatcher!.labelsBefore(body, config.allowedRepos) : null;
    const remember = () => { if (direct) dispatcher!.recordLabels(body, config.allowedRepos); };
    const routeLabels = (kind: string) => [...config.routes].filter(([, route]) => (route.kind || 'issue') === kind).map(([label]) => label);
    const normalized = normalizeEvent(event, body, config.allowedRepos, routeLabels('issue'), { labelEvents: config.mode === 'direct', prLabels: direct ? routeLabels('pull_request') : [],
      ci: direct ? { failure: routeLabels('ci_failure')[0], success: routeLabels('ci_success')[0] } : {},
      approved: direct && config.mergePolicy.size ? config.approvedLabel : '',
      pushes: direct && config.updateBranches });
    if (!normalized) { remember(); return json(res, 202, { status: 'ignored' }); }
    if (direct) normalized.previous_labels = previousLabels;
    if (config.allowedSenders && !config.allowedSenders.has(String(normalized.sender.login || '').toLowerCase())) {
      remember();
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
        const result = normalized.type === 'pull_request.approved' ? { status: await dispatcher!.approve(normalized as ForgeEvent) }
          : normalized.type === 'issues.closed' ? { status: await dispatcher!.onClosed(normalized as ForgeEvent) }
          : isPushEvent(normalized) ? { status: (dispatcher!.closeMergedTickets(normalized).catch((error) => logger.error('closing merged tickets failed:', error.message)), dispatcher!.onMainMoved(normalized)) }
          : await dispatcher!.enqueue(normalized);
        remember();
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
