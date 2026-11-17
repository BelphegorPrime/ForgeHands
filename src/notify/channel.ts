// A way to tell the human something. SMTP and a generic webhook exist; Telegram, ntfy and the like can be reached through the webhook or added
// as another file that implements this interface.

/** `kind`: handover, blocked, conflict, failed, reminder (immediate) or digest. `link` is where to look; `text` holds no code and no file contents. */
export type Notification = { subject: string; text: string; link?: string; kind: string; /** An HTML version (a mail sends both); every value in it is escaped, see texts.ts. */ html?: string };

export interface Channel {
  name: string;
  /** Resolves when the message is handed over; rejects with an error whose message holds no secret. */
  send(message: Notification): Promise<void>;
}
