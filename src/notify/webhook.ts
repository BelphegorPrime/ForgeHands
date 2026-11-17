// A generic channel: POST {subject, text, link, kind} as JSON to NOTIFY_WEBHOOK_URL. ntfy, Telegram, Slack-style endpoints and the like
// can sit behind it. The error messages never contain the URL (a token may be part of its path) or the Authorization header.
import type { Fetch } from '../types.ts';
import type { Channel, Notification } from './channel.ts';

export class WebhookChannel implements Channel {
  name = 'webhook';
  url: string;
  auth: string | null;
  send_: Fetch;
  timeoutMs: number;

  constructor(url: string, auth: string | null, send: Fetch = fetch, timeoutMs = 10000) {
    this.url = url;
    this.auth = auth;
    this.send_ = send;
    this.timeoutMs = timeoutMs;
  }

  async send(message: Notification): Promise<void> {
    let response: Response;
    try {
      response = await this.send_(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.auth ? { Authorization: this.auth } : {}) },
        body: JSON.stringify({ subject: message.subject, text: message.text, link: message.link ?? null, kind: message.kind }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error'
      });
    } catch {
      throw new Error('the notification webhook could not be reached');
    }
    if (!response.ok) throw new Error('the notification webhook answered HTTP ' + response.status);
  }
}
