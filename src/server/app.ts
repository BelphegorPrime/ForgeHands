import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signPayload } from '../webhook/security.ts';
import { createForge, createTransport } from '../forge/index.ts';
import { buildStatus, renderStatus } from './status.ts';
import { hasStatusSession, hasToken, statusSessionCookie } from './auth.ts';
import { attachWebSocket } from './websocket.ts';
import { gaugeSamples, known, metrics, WEBHOOK_EVENTS } from '../metrics.ts';
import { isBranchPush, isPushEvent } from '../types.ts';
import { DryLog, isDry } from '../dry.ts';
import type { Config, DirectConfig, Fetch, ForgeEvent, Logger } from '../types.ts';
import type { DeliveryStore } from '../store/deliveries.ts';
import type { Dispatcher } from '../agent/dispatch.ts';

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const dashboardDirectory = fileURLToPath(new URL('../../dist/dashboard/', import.meta.url));
const assetTypes: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

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
  // Only the webhook half of the forge is used here: the signature check and the event normalization.
  const forge = createForge(config, createTransport(config, send));
  const status = () => buildStatus(config as DirectConfig, dispatcher!.jobs, Date.now(), dispatcher!.dry, [...dispatcher!.reminder.waiting.values()]);
  const authenticateStatus = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!config.statusToken) return true;
    const authorized = hasToken(req.headers.authorization, config.statusToken);
    if (!authorized && !hasStatusSession(req.headers.cookie, config.statusToken)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'www-authenticate': 'Basic realm="ForgeHands", charset="UTF-8"' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    }
    if (authorized) {
      const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
      res.setHeader('set-cookie', statusSessionCookie(config.statusToken, Date.now(), secure));
    }
    return true;
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { status: 'ok' });
    }
    const pathname = req.url?.split('?')[0];
    if (dispatcher && req.method === 'GET' && (pathname === '/' || pathname === '/api/dashboard' || pathname?.startsWith('/assets/'))) {
      if (!authenticateStatus(req, res)) return;
      if (pathname === '/api/dashboard') return json(res, 200, status());
      const asset = pathname === '/' ? 'index.html' : /^\/assets\/([\w.-]+)$/.exec(pathname)?.[1];
      if (!asset) return json(res, 404, { error: 'not_found' });
      try {
        const body = await readFile(asset === 'index.html' ? join(dashboardDirectory, asset) : join(dashboardDirectory, 'assets', asset));
        res.writeHead(200, { 'content-type': asset === 'index.html' ? 'text/html; charset=utf-8' : assetTypes[asset.slice(asset.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': asset === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
        return res.end(body);
      } catch {
        return json(res, 404, { error: 'not_found' });
      }
    }
    // Read only views of the work in flight (direct mode): /status for people, /status.json for tools, /metrics for Prometheus.
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/status.json' || req.url === '/metrics') && dispatcher) {
      // With STATUS_TOKEN: `Authorization: Bearer <token>`, or basic auth with the token as password (so that a browser can open it).
      if (!authenticateStatus(req, res)) return;
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(metrics.render(gaugeSamples(config as DirectConfig, dispatcher.jobs, dispatcher.cooldowns, Date.now())));
      }
      const snapshot = status();
      if (req.url === '/status.json') return json(res, 200, snapshot);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderStatus(snapshot));
    }
    if (req.method !== 'POST' || req.url !== forge.webhookPath) {
      return json(res, 404, { error: 'not_found' });
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return json(res, 415, { error: 'expected_json' });
    }
    const delivered = (result: string) => metrics.inc('forgehands_webhook_deliveries_total', { event: known(forge.eventName(req.headers), WEBHOOK_EVENTS), result });
    let raw;
    try { raw = await readBody(req, config.maxBodyBytes); }
    catch (error) { return json(res, error.status || 400, { error: 'invalid_body' }); }
    if (!forge.verifyWebhook(config.forgejoSecret, raw, req.headers)) {
      delivered('rejected_signature');
      return json(res, 401, { error: 'invalid_signature' });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { return json(res, 400, { error: 'invalid_json' }); }
    const event = forge.eventName(req.headers);
    const direct = config.mode === 'direct';
    // A comment is no label event: the label memory of the issue is left alone (a comment on a pull request carries the pull request's labels).
    const isComment = event === 'issue_comment';
    const previousLabels = direct && !isComment ? dispatcher!.labelsBefore(body, config.allowedRepos) : null;
    const remember = () => { if (direct && !isComment) dispatcher!.recordLabels(body, config.allowedRepos); };
    const routeLabels = (kind: string) => [...config.routes].filter(([, route]) => (route.kind || 'issue') === kind).map(([label]) => label);
    const normalized = forge.normalizeEvent(event, body, config.allowedRepos, routeLabels('issue'), { labelEvents: config.mode === 'direct', prLabels: direct ? routeLabels('pull_request') : [],
      ci: direct ? { failure: routeLabels('ci_failure')[0], success: routeLabels('ci_success')[0] } : {},
      approved: direct && config.mergePolicy.size ? config.approvedLabel : '',
      pushes: direct && config.updateBranches,
      branchPushes: direct && config.reviewWithoutCi && !!config.forgejo && [...config.routes.values()].some((route) => route.kind === 'ci_success'),
      reviews: direct && config.verdictSource !== 'comment',
      bots: direct ? { authors: config.botAuthors, prefixes: config.botBranchPrefixes, repos: config.botRepos, fixRounds: config.botFixRounds } : undefined,
      comments: direct && config.humanLogin && config.commentRestarts ? { human: config.humanLogin } : undefined });
    if (!normalized) { remember(); delivered('ignored'); return json(res, 202, { status: 'ignored' }); }
    if (direct) normalized.previous_labels = previousLabels;
    // The CI outcome of a bot's pull request is let in by BOT_AUTHORS (the operator's own list), not by who triggered the run. Labels still need an allowed sender.
    // An approval needs no sender check: it only asks the merger to read the reviews, which decide. A rejection starts a round, so its author must be allowed.
    if (config.allowedSenders && normalized.type !== 'pull_request.review_approved' && !((normalized as ForgeEvent).bot && normalized.type.startsWith('ci.')) && !isBranchPush(normalized) && !config.allowedSenders.has(String(normalized.sender.login || '').toLowerCase())) {
      remember();
      delivered('ignored');
      return json(res, 202, { status: 'ignored' });
    }
    const id = forge.deliveryId(req.headers, raw, event);
    const key = normalized.repository.full_name.toLowerCase() + ':' + id;
    const state = store.acquire(key);
    if (state === 'completed') { delivered('duplicate'); return json(res, 200, { status: 'duplicate', delivery_id: id }); }
    if (state === 'inflight') { delivered('failed'); return json(res, 503, { error: 'delivery_in_progress' }); }
    normalized.delivery_id = id;
    if (config.mode === 'direct') {
      try {
        const result = normalized.type === 'pull_request.review_approved' || normalized.type === 'pull_request.review_rejected'
          ? { status: await dispatcher!.onReview(normalized as ForgeEvent, normalized.type === 'pull_request.review_approved') }
          : normalized.type === 'pull_request.approved' ? { status: await dispatcher!.approve(normalized as ForgeEvent) }
          : normalized.type === 'issues.closed' ? { status: await dispatcher!.onClosed(normalized as ForgeEvent) }
          : normalized.type === 'issues.commented' ? { status: await dispatcher!.onComment(normalized as ForgeEvent) }
          : isBranchPush(normalized) ? { status: await dispatcher!.onBranchPush(normalized) }
          : isPushEvent(normalized) ? { status: (dispatcher!.closeMergedTickets(normalized).catch((error) => logger.error('closing merged tickets failed:', error.message)), dispatcher!.onMainMoved(normalized)) }
          : await dispatcher!.enqueue(normalized);
        remember();
        await store.mark(key);
        delivered('accepted');
        return json(res, 202, { status: result.status, delivery_id: id });
      } catch (error) {
        delivered('failed');
        logger.error('Enqueue failed:', error.message);
        return json(res, 500, { error: 'enqueue_failed' });
      } finally {
        store.release(key);
      }
    }
    const outgoing = Buffer.from(JSON.stringify(normalized));
    // A dry run does not forward: the call is logged and the delivery counts as handled.
    if (isDry(config, normalized.repository.full_name)) {
      new DryLog(logger).record('OpenHands webhook', 'POST', '', normalized);
      await store.mark(key);
      store.release(key);
      return json(res, 202, { status: 'dry_run', delivery_id: id });
    }
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
        delivered('failed');
        logger.error('OpenHands webhook returned', response.status);
        return json(res, 502, { error: 'upstream_rejected', status_code: response.status });
      }
      await store.mark(key);
      delivered('accepted');
      return json(res, 202, { status: 'forwarded', delivery_id: id });
    } catch (error) {
      delivered('failed');
      logger.error('OpenHands webhook delivery failed:', error.message);
      return json(res, 502, { error: 'upstream_unavailable' });
    } finally {
      store.release(key);
    }
  });
  if (dispatcher) attachWebSocket(server, '/dashboard/ws', (req) => !config.statusToken || hasToken(req.headers.authorization, config.statusToken) || hasStatusSession(req.headers.cookie, config.statusToken), () => JSON.stringify(status()));
  return server;
}
