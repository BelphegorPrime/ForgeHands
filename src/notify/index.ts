// Tells the human what cannot be avoided, by a short message of ForgeHands' own (the forge's mail is too much and too loud). The Notifier owns
// the channels, never throws and never blocks its caller: a send that fails is tried again after 1, 5 and 30 minutes (in memory only), then the
// failure is logged and counted. A dry run only logs the subject.
import { metrics, known } from '../metrics.ts';
import { NOTIFY_KINDS } from '../types.ts';
import type { DirectConfig, Fetch, Logger } from '../types.ts';
import { isDry } from '../dry.ts';
import type { Channel, Notification } from './channel.ts';
import { SmtpChannel } from './smtp.ts';
import { WebhookChannel } from './webhook.ts';

export type { Channel, Notification } from './channel.ts';

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_PENDING = 100;
const KINDS = [...NOTIFY_KINDS, 'digest'];

/** What the rest of ForgeHands needs of a notifier: is this kind wanted, and send it (`repository` says whose dry run applies). */
export interface Notify {
  wants(kind: string): boolean;
  notify(message: Notification, repository?: string): void;
}

export const NO_NOTIFY: Notify = { wants: () => false, notify: () => {} };

export function createChannels(config: DirectConfig['notify'], send: Fetch = fetch): Channel[] {
  const channels: Channel[] = [];
  if (config.smtp) channels.push(new SmtpChannel(config.smtp));
  if (config.webhook) channels.push(new WebhookChannel(config.webhook.url, config.webhook.auth, send));
  return channels;
}

export class Notifier implements Notify {
  channels: Channel[];
  immediate: Set<string>;
  dry: (repository?: string) => boolean;
  logger: Logger;
  later: (run: () => void, ms: number) => void;
  /** Sends that wait for a retry; capped so that a dead channel cannot grow the memory. */
  pending = 0;

  constructor(channels: Channel[], immediate: Iterable<string>, dry: (repository?: string) => boolean = () => false, logger: Logger = console,
    later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms).unref(); }) {
    this.channels = channels;
    this.immediate = new Set(immediate);
    this.dry = dry;
    this.logger = logger;
    this.later = later;
  }

  static fromConfig(config: DirectConfig, send: Fetch = fetch, logger: Logger = console, later?: (run: () => void, ms: number) => void): Notifier {
    return new Notifier(createChannels(config.notify, send), config.notify.immediate, (repository) => isDry(config, repository), logger, later);
  }

  // Is a message of this kind to be sent at all? The digest is switched by NOTIFY_DIGEST, the rest by NOTIFY_IMMEDIATE.
  wants(kind: string): boolean {
    return this.channels.length > 0 && (kind === 'digest' || this.immediate.has(kind));
  }

  // Fire and forget: returns at once, never throws.
  notify(message: Notification, repository?: string): void {
    try {
      if (!this.wants(message.kind)) return;
      const kind = known(message.kind, KINDS);
      if (this.dry(repository)) {
        this.logger.error('DRY RUN, not sent: notification "' + message.subject.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 200) + '"');
        for (const channel of this.channels) metrics.inc('forgehands_notifications_total', { channel: channel.name, kind, result: 'dry' });
        return;
      }
      for (const channel of this.channels) this.attempt(channel, message, kind, 0);
    } catch (error) {
      this.logger.error('notification failed:', error?.message);
    }
  }

  private attempt(channel: Channel, message: Notification, kind: string, retry: number): void {
    if (retry === 0 && this.pending >= MAX_PENDING) {
      metrics.inc('forgehands_notifications_total', { channel: channel.name, kind, result: 'failed' });
      this.logger.error('notification dropped, too many are waiting for a retry');
      return;
    }
    let sending: Promise<void>;
    try { sending = Promise.resolve(channel.send(message)); } catch (error) { sending = Promise.reject(error); }
    sending.then(() => {
      if (retry) this.pending -= 1;
      metrics.inc('forgehands_notifications_total', { channel: channel.name, kind, result: 'sent' });
    }, (error) => {
      const delay = RETRY_DELAYS_MS[retry];
      if (delay === undefined) {
        if (retry) this.pending -= 1;
        metrics.inc('forgehands_notifications_total', { channel: channel.name, kind, result: 'failed' });
        this.logger.error('notification by ' + channel.name + ' failed for good:', String(error?.message || error).slice(0, 200));
        return;
      }
      if (!retry) this.pending += 1;
      this.logger.error('notification by ' + channel.name + ' failed, trying again in ' + delay / 60000 + ' min:', String(error?.message || error).slice(0, 200));
      this.later(() => this.attempt(channel, message, kind, retry + 1), delay);
    });
  }
}

// The mention that starts a hand-over comment: "@login " (HUMAN_LOGIN) unless HUMAN_MENTION=0 or no login is set.
export function mentionOf(config: Pick<DirectConfig, 'humanLogin' | 'notify'>): string {
  return config.humanLogin && config.notify.humanMention ? '@' + config.humanLogin + ' ' : '';
}

// Where to look at a pull request: the forge's own address when it gave one, else built from FORGE_URL.
export function pullUrl(config: Pick<DirectConfig, 'forgejo' | 'forge'>, repository: string, number: number, htmlUrl?: unknown): string | undefined {
  if (typeof htmlUrl === 'string' && /^https?:\/\/[^\s\u0000-\u001f]+$/.test(htmlUrl)) return htmlUrl;
  if (!config.forgejo) return undefined;
  return config.forgejo.url + '/' + repository + (config.forge === 'gitlab' ? '/-/merge_requests/' : '/pulls/') + number;
}
