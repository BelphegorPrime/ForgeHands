// Closes the tickets the ledger holds as open but the forge has closed (LEDGER_SYNC_HOURS). A close event can be lost (closed by a human, a merge
// before this was kept, or while ForgeHands was down), and then the status page shows dead entries. Every LEDGER_SYNC_HOURS, and once about a
// minute after the start, at most LEDGER_SYNC_BUDGET forge reads are made: one per ticket, the ones checked longest ago first. A ticket whose
// read fails is left as it is. Reads go to the forge only, so a dry run reads, but marks nothing (markClosed does nothing in a dry run).
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
  running: Promise<number> | null = null;
  timer: NodeJS.Timeout | undefined;
  firstTimer: NodeJS.Timeout | undefined;

  constructor(config: DirectConfig, jobs: JobStore, forge: SyncReads, logger: Logger, close: (ticket: string) => Promise<boolean>, now: () => number = Date.now) {
    this.config = config;
    this.jobs = jobs;
    this.forge = forge;
    this.logger = logger;
    this.close = close;
    this.now = now;
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
      // Work that is running or queued is not marked by markClosed anyway: no read is spent on it.
      return !list.some((job) => job.status === 'running' || job.status === 'queued');
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
        // Unknown is not closed: the ticket stays as it is, and it goes to the back of the queue.
        this.logger.error('ledger sync could not read ' + repository + (pull ? ' pull request ' : ' #') + number + ':', errText(error));
        this.jobs.noteChecked(ticket, now);
        changed = true;
        continue;
      }
      this.jobs.noteChecked(ticket, now);
      changed = true;
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

// When a ticket was last asked about by the sync (0 = never).
function lastSync(list: Job[]): number {
  return Math.max(0, ...list.map((job) => job.synced_at || 0));
}
