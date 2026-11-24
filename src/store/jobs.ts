import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { E2eRecord, EpicGapRecord, FiledFinding, FindingRecord, Hold, Job, JobStatus, MergeRecord, NewJob, OperatorRecord, RerunRecord, RevertRecord, StalledRecord, StuckRecord } from '../types.ts';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// `waiting`: the issue depends on issues that are still open; it starts when the last one closes.
export const ACTIVE = new Set<JobStatus>(['waiting', 'queued', 'running']);

interface SeenLabels { labels: string[]; seen: number }

// Persistent issue ledger: one record per started or queued run (repo#issue:label -> conversation).
export class JobStore {
  file: string;
  jobs = new Map<string, Job>();
  labels = new Map<string, SeenLabels>(); // repo#issue -> { labels, seen }: the labels seen on the last event of an issue
  /** Small facts that must outlive a restart and belong to no job: the date of the last digest (`digest_sent`, YYYY-MM-DD in NOTIFY_TIMEZONE). */
  meta: { digest_sent?: string; e2e?: E2eRecord } = {};
  /** Keys of things already done, kept 30 days: a human comment that restarted a run (`comment:<repo>#<n>#<id>`), a notice sent once (`limit:<repo>#<n>:<label>`). */
  dedupe = new Map<string, number>();
  /** Two-key merges on hold (TWO_KEYS_HOLD_MINUTES), per pull request ("repo#pr<n>"). Held until merged, cleared or the pull request changes; never pruned by age. */
  holds = new Map<string, Hold>();
  /** Blocked agent pull requests ("repo#pr<n>"), see StuckRecord and stuck.ts. Kept until the pull request is closed or unblocked. */
  stuck = new Map<string, StuckRecord>();
  /** Epics the epic review found still open ("repo#n"), see EpicGapRecord and epic-gaps.ts. Kept until the epic is found closed. */
  epicGaps = new Map<string, EpicGapRecord>();
  /** Tickets the ticket watchdog found stalled ("repo#n"), see StalledRecord and review-sweep.ts. Kept until the ticket is closed, or the human took its label off. */
  stalled = new Map<string, StalledRecord>();
  /** Tickets labelled OPERATOR_LABEL that ForgeHands has seen ("repo#n", lower case), kept until the ticket is closed (see OperatorRecord). */
  operatorTickets = new Map<string, OperatorRecord>();
  /** What ForgeHands merged, kept 30 days (see Merger.recordMerge): the daily limit and REVERT_ON_RED read it. */
  merges: MergeRecord[] = [];
  /** Reverts of merges that turned the default branch red (REVERT_RETRIES), kept 30 days. */
  reverts: RevertRecord[] = [];
  /** Reruns of a failed run that was green before its merge (RERUN_TIMEOUT_MINUTES), kept 30 days: one per commit. */
  reruns: RerunRecord[] = [];
  /** NOT OK points with a normalized reason, kept 30 days (RECURRING_REASON_MIN counts the last 14 of them, see recurring.ts). */
  findings: FindingRecord[] = [];
  /** The ticket filed for a recurring reason, per "repo|reason". Kept: a reason has one ticket while it is open. */
  filedFindings = new Map<string, FiledFinding>();
  /** Issues ("repo#n", lower case) the forge answered 404 for on two passes of the ledger sync, with the time they were marked (see LedgerSync). */
  deletedInForge = new Map<string, number>();
  /** Passes of the ledger sync that found an issue missing (404, confirmed by ticketGone), by "repo#n" (lower case). Reset by a read that finds it. */
  goneChecks = new Map<string, number>();
  writes: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }
  async load(): Promise<void> {
    try {
      const content = JSON.parse(await readFile(this.file, 'utf8'));
      const jobs = content?.jobs;
      if (!Array.isArray(jobs)) throw Error('Invalid job store');
      for (const job of jobs) if (job && job.id) this.jobs.set(job.id, job);
      if (typeof content?.meta?.digest_sent === 'string') this.meta.digest_sent = content.meta.digest_sent;
      if (content?.meta?.e2e && typeof content.meta.e2e.version === 'string') this.meta.e2e = content.meta.e2e;
      for (const [key, value] of Object.entries((content?.dedupe || {}) as Record<string, number>)) {
        if (typeof value === 'number') this.dedupe.set(key, value);
      }
      if (Array.isArray(content?.reverts)) this.reverts = content.reverts.filter((entry: RevertRecord) => entry && typeof entry.repository === 'string');
      if (Array.isArray(content?.reruns)) this.reruns = content.reruns.filter((entry: RerunRecord) => entry && typeof entry.repository === 'string');
      if (Array.isArray(content?.merges)) this.merges = content.merges.filter((entry: MergeRecord) => entry && typeof entry.repository === 'string');
      if (Array.isArray(content?.findings)) this.findings = content.findings.filter((entry: FindingRecord) => entry && typeof entry.reason === 'string');
      for (const [key, value] of Object.entries((content?.filed_findings || {}) as Record<string, FiledFinding>)) {
        if (value && typeof value.issue === 'number') this.filedFindings.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.holds || {}) as Record<string, Hold>)) {
        if (value && typeof value.sha === 'string') this.holds.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.stuck || {}) as Record<string, StuckRecord>)) {
        if (value && typeof value.sha === 'string' && typeof value.issue === 'number') this.stuck.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.stalled || {}) as Record<string, StalledRecord>)) {
        if (value && typeof value.issue === 'number' && typeof value.run === 'string') this.stalled.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.epic_gaps || {}) as Record<string, EpicGapRecord>)) {
        if (value && typeof value.issue === 'number' && typeof value.replans === 'number') this.epicGaps.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.operator_tickets || {}) as Record<string, OperatorRecord>)) {
        if (value && typeof value.issue === 'number' && typeof value.title === 'string') this.operatorTickets.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.labels || {}) as Record<string, SeenLabels>)) {
        if (value && Array.isArray(value.labels)) this.labels.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.deleted_in_forge || {}) as Record<string, number>)) {
        if (typeof value === 'number') this.deletedInForge.set(key, value);
      }
      for (const [key, value] of Object.entries((content?.gone_checks || {}) as Record<string, number>)) {
        if (typeof value === 'number') this.goneChecks.set(key, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  list(status?: JobStatus | true): Job[] {
    const all = [...this.jobs.values()].sort((a, b) => a.created - b.created);
    return status ? all.filter((job) => ACTIVE.has(job.status) && (status === true || job.status === status)) : all;
  }
  getLabels(issueKey: string): string[] | null {
    return this.labels.get(issueKey)?.labels ?? null;
  }
  setLabels(issueKey: string, labels: string[], now = Date.now()): boolean {
    const previous = this.getLabels(issueKey);
    const changed = !previous || previous.length !== labels.length || previous.some((name: string, i: number) => name !== labels[i]);
    this.labels.set(issueKey, { labels, seen: now });
    return changed;
  }
  noted(key: string): boolean {
    return this.dedupe.has(key);
  }
  note(key: string, now = Date.now()): void {
    this.dedupe.set(key, now);
  }
  activeByKey(key: string): Job | undefined {
    return this.list(true).find((job) => job.key === key);
  }
  // A fact about a ticket (merged, blocked, split) is kept on its newest job; the summary on the status page reads it from there.
  // `ticket` is the ledger key without the label: "repo#issue", or "repo!pr<n>" for a dependency bot's pull request.
  noteTicket(ticket: string, patch: Partial<Pick<Job, 'merged_at' | 'merged_by' | 'blocked_at' | 'split_at'>>): boolean {
    const prefix = ticket + ':';
    const jobsOfTicket = this.list().filter((job) => job.key.startsWith(prefix));
    const newest = jobsOfTicket.at(-1);
    if (!newest) return false;
    // A merge ForgeHands did itself is not taken for a human's when the push event of that very merge arrives first.
    if (patch.merged_by === 'human' && jobsOfTicket.some((job) => job.merged_at)) return false;
    Object.assign(newest, patch);
    return true;
  }
  // The issue (ledger key without the label) is closed in the forge: mark its jobs for the status page. Jobs that run or are queued keep
  // their state, so work that is still going on is never hidden. Returns whether something changed.
  markClosed(ticket: string): boolean {
    let changed = false;
    for (const job of this.list().filter((entry) => entry.key.startsWith(ticket + ':') && entry.status !== 'running' && entry.status !== 'queued' && !entry.archived_view)) {
      job.archived_view = true;
      changed = true;
    }
    return changed;
  }
  // The ledger sync asked the forge about this ticket at `now`: every job of the ticket keeps it (the oldest-checked ticket is asked first).
  noteChecked(ticket: string, now: number): void {
    for (const job of this.list().filter((entry) => entry.key.startsWith(ticket + ':'))) job.synced_at = now;
  }
  // The issue ("repo#n") is deleted in the forge (see LedgerSync): it leaves the status page's open list, as closed.
  isDeletedInForge(ticket: string): boolean {
    return this.deletedInForge.has(ticket.toLowerCase());
  }
  // Marks an issue deleted in the forge: its waiting and queued jobs end as `deleted` (no comment, no hand-over), its other jobs are closed for the
  // status page, and the jobs that wait for it are released from it (a deleted issue cannot be waited for). Returns the number of jobs dropped.
  markDeletedInForge(ticket: string, now: number): number {
    const name = ticket.toLowerCase();
    const number = Number(name.slice(name.lastIndexOf('#') + 1));
    const repository = name.slice(0, name.lastIndexOf('#'));
    this.deletedInForge.set(name, now);
    this.goneChecks.delete(name);
    let dropped = 0;
    for (const job of this.jobs.values()) {
      if (job.key.toLowerCase().split(':')[0] !== name || (job.status !== 'waiting' && job.status !== 'queued')) continue;
      Object.assign(job, { status: 'deleted', finished: now, result: 'deleted' });
      delete job.waiting_for; delete job.waiting_for_files;
      dropped += 1;
    }
    this.markClosed(ticket);
    for (const job of this.jobs.values()) {
      if (job.status !== 'waiting' || job.waiting_for_run || job.event?.repository?.full_name?.toLowerCase() !== repository) continue;
      const waitingFor = job.waiting_for ?? [];
      const waitingFiles = job.waiting_for_files ?? [];
      if (!waitingFor.includes(number) && !waitingFiles.includes(number)) continue;
      const left = waitingFor.filter((n) => n !== number);
      const leftFiles = waitingFiles.filter((n) => n !== number);
      if (left.length) job.waiting_for = left; else delete job.waiting_for;
      if (leftFiles.length) job.waiting_for_files = leftFiles; else delete job.waiting_for_files;
      if (!left.length && !leftFiles.length) job.status = 'queued';
    }
    return dropped;
  }
  add(job: NewJob): Job {
    const record: Job = { id: randomUUID(), attempts: 0, ...job };
    this.jobs.set(record.id, record);
    return record;
  }
  remove(id: string): void {
    this.jobs.delete(id);
  }
  persist(now = Date.now()): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(async () => {
      for (const [id, job] of this.jobs) {
        if (!ACTIVE.has(job.status) && (job.finished || job.created) < now - KEEP_MS) this.jobs.delete(id);
      }
      // A deleted issue and a missing-issue count are kept while the ledger still holds a job of the issue.
      const held = new Set([...this.jobs.values()].map((job) => job.key.toLowerCase().split(':')[0]));
      for (const ticket of this.deletedInForge.keys()) if (!held.has(ticket)) this.deletedInForge.delete(ticket);
      for (const ticket of this.goneChecks.keys()) if (!held.has(ticket)) this.goneChecks.delete(ticket);
      for (const [key, value] of this.labels) if (value.seen < now - KEEP_MS) this.labels.delete(key);
      for (const [key, seen] of this.dedupe) if (seen < now - KEEP_MS) this.dedupe.delete(key);
      this.merges = this.merges.filter((entry) => entry.merged_at >= now - KEEP_MS);
      this.reverts = this.reverts.filter((entry) => entry.at >= now - KEEP_MS);
      this.reruns = this.reruns.filter((entry) => entry.at >= now - KEEP_MS);
      this.findings = this.findings.filter((entry) => entry.at >= now - KEEP_MS);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify({ version: 2, jobs: [...this.jobs.values()], operator_tickets: Object.fromEntries(this.operatorTickets), labels: Object.fromEntries(this.labels), deleted_in_forge: Object.fromEntries(this.deletedInForge), gone_checks: Object.fromEntries(this.goneChecks), meta: this.meta, dedupe: Object.fromEntries(this.dedupe), holds: Object.fromEntries(this.holds), stuck: Object.fromEntries(this.stuck), epic_gaps: Object.fromEntries(this.epicGaps), stalled: Object.fromEntries(this.stalled), merges: this.merges, reverts: this.reverts, reruns: this.reruns, findings: this.findings, filed_findings: Object.fromEntries(this.filedFindings) }), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writes;
  }
}
