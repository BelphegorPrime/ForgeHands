// Closes the tickets the ledger holds as open but the forge has closed (LEDGER_SYNC_HOURS). A close event can be lost (closed by a human, a merge
// before this was kept, or while ForgeHands was down), and then the status page shows dead entries. Every LEDGER_SYNC_HOURS, and once about a
// minute after the start, at most LEDGER_SYNC_BUDGET forge reads are made: one per ticket, the ones checked longest ago first. A ticket whose
// read fails is left as it is. Tickets with waiting or queued jobs are read too (running ones are not: their run decides when it ends); a 404 on
// the ticket's own read means it was deleted in the forge, and its waiting and queued jobs are dropped (see the `deleted` callback). Reads go to
// the forge only, so a dry run reads, but marks nothing (markClosed does nothing in a dry run).
import { isDry } from '../dry.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DirectConfig, Job, Logger } from '../types.ts';
import { metrics } from '../metrics.ts';

const HOUR_MS = 3600000;
const FIRST_PASS_MS = 60000;
export const LEDGER_SYNC_BUDGET = 60;

// The part of the forge the sync reads: one issue or one pull request.
export interface SyncReads {
  getIssue(repository: string, number: number): Promise<{ state: string; merged?: boolean }>;
  getPull(repository: string, number: number): Promise<{ state: string; merged?: boolean }>;
}

const errText = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200);

export class LedgerSync {
  config: DirectConfig;
  jobs: JobStore;
  forge: SyncReads;
  logger: Logger;
  now: () => number;
  /** Marks a ticket closed (the dispatcher's markClosed); true when something changed. */
  close: (ticket: string) => Promise<boolean>;
  /** Drops the waiting and queued jobs of a ticket that the forge reports deleted (404); true when something changed. */
  deleted: (ticket: string) => Promise<boolean>;
  running: Promise<number> | null = null;
  timer: NodeJS.Timeout | undefined;
  firstTimer: NodeJS.Timeout | undefined;

  constructor(config: DirectConfig, jobs: JobStore, forge: SyncReads, logger: Logger, close: (ticket: string) => Promise<boolean>, now: () => number = Date.now,
    deleted: (ticket: string) => Promise<boolean> = async () => false) {
    this.config = config;
    this.jobs = jobs;
    this.forge = forge;
    this.logger = logger;
    this.close = close;
    this.now = now;
    this.deleted = deleted;
  }

  // Needs the forge's access (FORGEJO_URL and FORGEJO_TOKEN): without it there is nothing to read.
  get enabled(): boolean {
    return this.config.ledgerSyncHours > 0 && this.config.forgejo !== null;
  }

  start(): void {
    if (!this.enabled) return;
    this.firstTimer = setTimeout(() => { void this.run(); }, FIRST_PASS_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.run(); }, this.config.ledgerSyncHours * HOUR_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  // One pass at a time; a call during a pass gets that pass. Never rejects: an error is logged and ends the pass.
  run(): Promise<number> {
    if (!this.enabled) return Promise.resolve(0);
    if (!this.running) {
      this.running = this.pass()
        .catch((error) => { this.logger.error('ledger sync failed:', errText(error)); return 0; })
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  // The tickets the ledger holds as not closed: issue tickets ("repo#n") and dependency bot pull requests ("repo!pr<n>") of the allowed repositories.
  candidates(): [string, Job[]][] {
    const tickets = new Map<string, Job[]>();
    for (const job of this.jobs.list()) {
      const ticket = job.key.split(':')[0];
      tickets.set(ticket, [...(tickets.get(ticket) || []), job]);
    }
    return [...tickets].filter(([ticket, list]) => {
      const repository = ticket.split(/[#!]/)[0];
      if (!this.config.allowedRepos.has(repository) || isDry(this.config, repository)) return false;
      if (list.every((job) => job.archived_view)) return false;
      // A running ticket is left to its run, which decides when it ends. Waiting and queued jobs are read: a deleted ticket must leave the queue.
      return !list.some((job) => job.status === 'running');
    }).sort(([, a], [, b]) => lastSync(a) - lastSync(b));
  }

  async pass(): Promise<number> {
    const now = this.now();
    let closed = 0;
    let changed = false;
    for (const [ticket, list] of this.candidates().slice(0, LEDGER_SYNC_BUDGET)) {
      const match = /^(.+?)([#!])(?:pr)?(\d+)$/.exec(ticket);
      if (!match) continue;
      const pull = match[2] === '!';
      const number = Number(match[3]);
      const repository = list[0].event?.repository?.full_name || match[1];
      let done: boolean;
      try {
        const item = pull ? await this.forge.getPull(repository, number) : await this.forge.getIssue(repository, number);
        done = pull ? item.state === 'closed' || item.merged === true : item.state === 'closed';
      } catch (error) {
        // A 404 on the ticket itself: it was deleted in the forge, so its waiting and queued jobs go (once; they are no longer waiting after that).
        if (/HTTP 404\b/.test(errText(error))) {
          if (await this.deleted(ticket)) changed = true;
          this.jobs.noteChecked(ticket, now);
          continue;
        }
        // Unknown is not closed: the ticket stays as it is, and it goes to the back of the queue.
        this.logger.error('ledger sync could not read ' + repository + (pull ? ' pull request ' : ' #') + number + ':', errText(error));
        this.jobs.noteChecked(ticket, now);
        changed = true;
        continue;
      }
      this.jobs.noteChecked(ticket, now);
      changed = true;
      // A pull request of an open ticket that its waiting or queued job names: a 404 on it means the pull request was deleted; its jobs are dropped.
      if (!pull && !done) {
        for (const number of pullsNamed(list)) {
          try {
            await this.forge.getPull(repository, number);
          } catch (error) {
            if (/HTTP 404\b/.test(errText(error)) && await this.deleted(match[1] + '!pr' + number)) changed = true;
          }
        }
      }
      if (done && await this.close(ticket)) {
        closed += 1;
        metrics.inc('forgehands_ledger_sync_closed_total');
      }
    }
    if (changed) await this.jobs.persist(now);
    if (closed) this.logger.error('ledger sync: ' + closed + ' ticket(s) closed in the forge are marked closed on the status page');
    return closed;
  }
}

// The pull requests that waiting or queued jobs of a ticket name (their rounds, reviews and fixes), each once.
function pullsNamed(list: Job[]): number[] {
  return [...new Set(list.filter((job) => (job.status === 'waiting' || job.status === 'queued') && job.event?.pull_request?.number)
    .map((job) => job.event.pull_request!.number as number))];
}

// When a ticket was last asked about by the sync (0 = never).
function lastSync(list: Job[]): number {
  return Math.max(0, ...list.map((job) => job.synced_at || 0));
}
