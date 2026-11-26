import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { E2eRecord, EpicGapRecord, EpicSweepRecord, FiledFinding, FindingRecord, Hold, Job, JobStatus, Json, Logger, MergeRecord, NewJob, OperatorRecord, RerunRecord, RevertRecord, StalledRecord, StuckRecord } from '../types.ts';

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
  /** Epics the epic sweep looked at while they are open ("repo#n"), see EpicSweepRecord and epic-sweep.ts. Dropped when the epic is found closed. */
  epicSweeps = new Map<string, EpicSweepRecord>();
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

  logger: Logger;

  constructor(file: string, logger: Logger = console) {
    this.file = file;
    this.logger = logger;
  }
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const content = migrate(JSON.parse(text), this.file);
    if (!Array.isArray(content?.jobs)) throw Error('Invalid job store');
    const drop = (collection: string, key: string) => this.logger.error('ledger: dropped an invalid entry of ' + collection + ' (' + key + ')');
    content.jobs.forEach((job: Json, index: number) => {
      if (job && typeof job.id === 'string' && job.id) this.jobs.set(job.id, job as Job);
      else drop('jobs', String(index));
    });
    for (const collection of COLLECTIONS) collection.load(this, content?.[collection.file], drop);
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
      // The tickets the ledger still holds a job of: some records are kept only while one is held.
      const held = new Set([...this.jobs.values()].map((job) => job.key.toLowerCase().split(':')[0]));
      const content: Record<string, unknown> = { version: LEDGER_VERSION, jobs: [...this.jobs.values()] };
      for (const collection of COLLECTIONS) {
        collection.prune(this, now, held);
        content[collection.file] = collection.save(this);
      }
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify(content), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writes;
  }
}

// The version of the ledger file this code writes and reads.
export const LEDGER_VERSION = 2;

// The steps from one version of the ledger file to the next: MIGRATIONS[n] turns a version n file into a version n + 1 file. A change to the
// file format bumps LEDGER_VERSION and adds its step here, with a test that loads a file of the old version (test/ledger-file.test.ts).
const MIGRATIONS: Record<number, (content: Json) => Json> = {};

// Brings a parsed ledger file to LEDGER_VERSION. Every object file since v0.2.5 says `version: 2`; one without a version is taken as 2, as it
// was read before versions were checked. A file of a newer ForgeHands stops the start: reading it would drop what this version does not know,
// and the next save would write that loss to disk.
function migrate(content: Json, file: string): Json {
  if (!isObject(content) || Array.isArray(content)) return content;
  let version = content.version ?? LEDGER_VERSION;
  if (!Number.isSafeInteger(version) || version < 1) throw Error('Invalid job store: version ' + JSON.stringify(content.version));
  if (version > LEDGER_VERSION) {
    throw Error('The ledger ' + file + ' was written by a newer ForgeHands (version ' + version + ', this one reads up to ' + LEDGER_VERSION + '). '
      + 'Start the newer release again, or move the file away to start with an empty ledger.');
  }
  while (version < LEDGER_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw Error('Invalid job store: no migration from version ' + version);
    content = step(content);
    version += 1;
  }
  return content;
}

// One collection of the ledger file besides the jobs: how it is read (with what counts as valid), pruned and written.
interface Collection {
  file: string;
  load(store: JobStore, raw: unknown, drop: (collection: string, key: string) => void): void;
  prune(store: JobStore, now: number, held: Set<string>): void;
  save(store: JobStore): unknown;
}
// When a record goes: `age` reads its time and drops it after KEEP_MS, `held` keeps it while a job of its ticket (the key) is in the ledger.
type Keep<T> = { age: (value: T) => number } | 'held' | 'kept';

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

// A collection kept as a map in the store and as an object in the file.
function mapOf<T>(file: string, get: (store: JobStore) => Map<string, T>, valid: (value: Json) => boolean, keep: Keep<T>): Collection {
  return {
    file,
    load(store, raw, drop) {
      if (!isObject(raw)) return;
      for (const [key, value] of Object.entries(raw)) {
        if (valid(value)) get(store).set(key, value as T);
        else drop(file, key);
      }
    },
    prune(store, now, held) {
      if (keep === 'kept') return;
      for (const [key, value] of get(store)) {
        if (keep === 'held' ? !held.has(key) : keep.age(value) < now - KEEP_MS) get(store).delete(key);
      }
    },
    save: (store) => Object.fromEntries(get(store))
  };
}

// A collection kept as a list, in the store and in the file, pruned by age.
function listOf<T>(file: string, get: (store: JobStore) => T[], set: (store: JobStore, list: T[]) => void, valid: (value: Json) => boolean, age: (value: T) => number): Collection {
  return {
    file,
    load(store, raw, drop) {
      if (!Array.isArray(raw)) return;
      set(store, raw.filter((value, index) => valid(value) || (drop(file, String(index)), false)) as T[]);
    },
    prune: (store, now) => set(store, get(store).filter((value) => age(value) >= now - KEEP_MS)),
    save: (store) => get(store)
  };
}

const number = (value: unknown): value is number => typeof value === 'number';
const string = (value: unknown): value is string => typeof value === 'string';

// The meta facts: each one is read only when it has its expected shape, anything else in the file is left out.
const META: Collection = {
  file: 'meta',
  load(store, raw) {
    if (!isObject(raw)) return;
    if (string(raw.digest_sent)) store.meta.digest_sent = raw.digest_sent;
    if (isObject(raw.e2e) && string(raw.e2e.version)) store.meta.e2e = raw.e2e as E2eRecord;
  },
  prune() {},
  save: (store) => store.meta
};

// Every collection of the ledger file, in the order the file lists them. A new collection is one line here (and its field on JobStore).
const COLLECTIONS: Collection[] = [
  mapOf<OperatorRecord>('operator_tickets', (s) => s.operatorTickets, (v) => isObject(v) && number(v.issue) && string(v.title), 'kept'),
  mapOf<SeenLabels>('labels', (s) => s.labels, (v) => isObject(v) && Array.isArray(v.labels), { age: (v) => v.seen }),
  mapOf<number>('deleted_in_forge', (s) => s.deletedInForge, number, 'held'),
  mapOf<number>('gone_checks', (s) => s.goneChecks, number, 'held'),
  META,
  mapOf<number>('dedupe', (s) => s.dedupe, number, { age: (v) => v }),
  mapOf<Hold>('holds', (s) => s.holds, (v) => isObject(v) && string(v.sha), 'kept'),
  mapOf<StuckRecord>('stuck', (s) => s.stuck, (v) => isObject(v) && string(v.sha) && number(v.issue), 'kept'),
  mapOf<EpicGapRecord>('epic_gaps', (s) => s.epicGaps, (v) => isObject(v) && number(v.issue) && number(v.replans), 'kept'),
  mapOf<EpicSweepRecord>('epic_sweeps', (s) => s.epicSweeps, (v) => isObject(v) && number(v.issue) && number(v.last_closed) && Array.isArray(v.open), 'kept'),
  mapOf<StalledRecord>('stalled', (s) => s.stalled, (v) => isObject(v) && number(v.issue) && string(v.run), 'kept'),
  listOf<MergeRecord>('merges', (s) => s.merges, (s, l) => { s.merges = l; }, (v) => isObject(v) && string(v.repository), (v) => v.merged_at),
  listOf<RevertRecord>('reverts', (s) => s.reverts, (s, l) => { s.reverts = l; }, (v) => isObject(v) && string(v.repository), (v) => v.at),
  listOf<RerunRecord>('reruns', (s) => s.reruns, (s, l) => { s.reruns = l; }, (v) => isObject(v) && string(v.repository), (v) => v.at),
  listOf<FindingRecord>('findings', (s) => s.findings, (s, l) => { s.findings = l; }, (v) => isObject(v) && string(v.reason), (v) => v.at),
  mapOf<FiledFinding>('filed_findings', (s) => s.filedFindings, (v) => isObject(v) && number(v.issue), 'kept')
];
