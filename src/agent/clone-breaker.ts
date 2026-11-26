// The clone breaker: one shared sandbox outage must not turn into a failure per ticket. Three confirmed clone failures in three distinct
// conversations across at least two repositories within ten minutes open it, and an open breaker holds every new start. After the hold one
// half-open trial may start; only positive checkout evidence from that trial closes the breaker again. Time alone never closes it.
//
// The durable record holds only the normalized failure class, the repository, the time and the conversation: never raw clone output, a clone
// URL, or a secret. It lives in the ledger (meta.clone_breaker), so a restart keeps the hold, the single-trial claim and the one notification.
import type { JobStore } from '../store/jobs.ts';
import { CLONE_FAILURE_CLASSES } from '../types.ts';
import type { CloneBreakerRecord, CloneBreakerSnapshot, CloneBreakerState, CloneFailureClass, CloneFailureRecord, Logger } from '../types.ts';

/** The window in which confirmed failures count toward the threshold. */
export const CLONE_BREAKER_WINDOW_MS = 10 * 60_000;
/** How long an open breaker holds new starts before one half-open trial may be admitted. A failed trial reopens for the same time. */
export const CLONE_BREAKER_HOLD_MS = 10 * 60_000;
/** How long an admitted trial may take to show a checkout. Without that evidence it is inconclusive and the breaker reopens. */
export const CLONE_BREAKER_TRIAL_MS = 10 * 60_000;
export const CLONE_BREAKER_MIN_CONVERSATIONS = 3;
export const CLONE_BREAKER_MIN_REPOSITORIES = 2;

/** What a caller may report: the time is taken from the injected clock, never from the forge comment. */
export type CloneFailureReport = Omit<CloneFailureRecord, 'at'>;
/** The outcome of the half-open trial: only `checkout` closes the breaker; `failed` and `inconclusive` reopen it. */
export type CloneTrialOutcome = 'checkout' | 'failed' | 'inconclusive';

const SAFE_REPOSITORY = /^[^\s@/:]+(?:\/[^\s@/:]+)+$/;
const SAFE_CONVERSATION = /^[^\s\u0000-\u001f]{1,200}$/;
const SAFE_OWNER = /^[^\s\u0000-\u001f]{1,300}$/;

const emptyRecord = (): CloneBreakerRecord => ({
  state: 'closed', incident: 0, opened_at: null, retry_at: null, trial: null, notified: false, failures: []
});

const validClass = (value: unknown): value is CloneFailureClass => (CLONE_FAILURE_CLASSES as readonly string[]).includes(String(value));

export class CloneBreaker {
  jobs: JobStore;
  now: () => number;
  logger: Logger;

  constructor(jobs: JobStore, now: () => number = Date.now, logger: Logger = console) {
    this.jobs = jobs;
    this.now = now;
    this.logger = logger;
  }

  // Loaded from the ledger: a file without a breaker is closed, and a half-open claim that never got its conversation has no owner in this
  // process, so it reopens (inconclusive) instead of holding a start that does not exist. Call once after JobStore.load.
  async hydrate(): Promise<boolean> {
    const now = this.now();
    const record = this.record();
    const changed = this.normalize(now);
    const orphaned = record.state === 'half_open' && record.trial !== null && record.trial.conversation === null;
    if (orphaned) this.reopen(record, now);
    if (changed || orphaned) await this.save(now);
    return changed || orphaned;
  }

  // Every new start waits while the breaker is not closed: open holds all, half_open holds all but the claimed trial.
  holds(): boolean {
    this.normalize(this.now());
    return this.record().state !== 'closed';
  }

  // Is one half-open trial free to be claimed now (the hold has passed and no trial is running)?
  trialReady(): boolean {
    const now = this.now();
    this.normalize(now);
    const record = this.record();
    return record.state === 'half_open' && record.trial === null && (record.retry_at === null || now >= record.retry_at);
  }

  // Claim the one trial for a job before its start: the claim is written to the ledger first, so a restart sees who owns it.
  async admitTrial(owner: string, now = this.now()): Promise<boolean> {
    if (!SAFE_OWNER.test(owner)) return false;
    this.normalize(now);
    const record = this.record();
    if (record.state !== 'half_open' || record.trial !== null || (record.retry_at !== null && now < record.retry_at)) return false;
    record.trial = { owner, conversation: null, started: now, deadline: now + CLONE_BREAKER_TRIAL_MS };
    await this.save(now);
    return true;
  }

  // The claimed start produced its conversation: only that conversation may settle the trial from now on.
  async confirmTrial(owner: string, conversation: string, now = this.now()): Promise<boolean> {
    if (!SAFE_OWNER.test(owner) || !SAFE_CONVERSATION.test(conversation)) return false;
    this.normalize(now);
    const record = this.record();
    const trial = record.trial;
    if (!trial || trial.owner !== owner || trial.conversation !== null || now >= trial.deadline) return false;
    trial.conversation = conversation;
    await this.save(now);
    return true;
  }

  // The claimed start failed or its outcome is unknown: release the reservation and reopen for another hold. No second trial is left behind.
  async abandonTrial(owner: string, now = this.now()): Promise<boolean> {
    this.normalize(now);
    const record = this.record();
    if (!record.trial || record.trial.owner !== owner) return false;
    this.reopen(record, now);
    await this.save(now);
    return true;
  }

  // Only the conversation of the admitted trial can settle it. Positive checkout evidence closes and clears the window; a failed or
  // inconclusive trial reopens for ten minutes in the same incident, so the notification is not sent again.
  async settleTrial(conversation: string, outcome: CloneTrialOutcome, now = this.now()): Promise<boolean> {
    this.normalize(now);
    const record = this.record();
    if (!record.trial || record.trial.conversation === null || record.trial.conversation !== conversation) return false;
    if (outcome === 'checkout') this.close(record);
    else this.reopen(record, now);
    await this.save(now);
    return true;
  }

  // Record one confirmed failure. A replay of a conversation already in the window is ignored; old records expire, so the ledger keeps no
  // evidence longer than it can count. Returns whether the durable record changed.
  async reportFailure(report: CloneFailureReport, now = this.now()): Promise<boolean> {
    const failure = this.cleanReport(report);
    if (!failure) return false;
    this.normalize(now);
    const record = this.record();
    const before = JSON.stringify(record);
    if (record.failures.some((entry) => entry.conversation === failure.conversation)) return false;
    record.failures.push({ ...failure, at: now });
    if (record.state === 'closed') {
      const conversations = new Set(record.failures.map((entry) => entry.conversation));
      const repositories = new Set(record.failures.map((entry) => entry.repository));
      if (conversations.size >= CLONE_BREAKER_MIN_CONVERSATIONS && repositories.size >= CLONE_BREAKER_MIN_REPOSITORIES) this.trip(record, now);
    } else if (record.trial?.conversation === failure.conversation) {
      // The admitted trial itself failed to clone: that is not positive evidence, so the hold starts again.
      this.reopen(record, now);
    }
    if (JSON.stringify(record) === before) return false;
    await this.save(now);
    return true;
  }

  // The incident's one notification: claimed durably before it is sent. A reopen keeps the claim; only a new incident claims again.
  async claimNotification(now = this.now()): Promise<boolean> {
    this.normalize(now);
    const record = this.record();
    if (record.state === 'closed' || record.notified) return false;
    record.notified = true;
    await this.save(now);
    return true;
  }

  // What the status views publish: state and timing only, never the evidence behind it.
  snapshot(): CloneBreakerSnapshot {
    this.normalize(this.now());
    const record = this.record();
    return {
      state: record.state,
      since: record.state === 'closed' ? null : record.opened_at,
      retry_at: record.state === 'closed' ? null : record.retry_at,
      trial_until: record.trial?.deadline ?? null
    };
  }

  state(): CloneBreakerState {
    this.normalize(this.now());
    return this.record().state;
  }

  private record(): CloneBreakerRecord {
    let record = this.jobs.meta.clone_breaker;
    if (!record) {
      record = emptyRecord();
      this.jobs.meta.clone_breaker = record;
    }
    return record;
  }

  // Drops what can no longer count or hold, and moves an elapsed hold to half_open. It never closes the breaker: only checkout evidence does.
  private normalize(now: number): boolean {
    const record = this.record();
    let changed = false;
    const failures = record.failures.filter((entry) => Number.isFinite(entry.at) && entry.at <= now && now - entry.at <= CLONE_BREAKER_WINDOW_MS);
    if (failures.length !== record.failures.length) {
      record.failures = failures;
      changed = true;
    }
    if (record.state === 'closed') {
      // A closed breaker keeps the failures that are still counting toward its threshold; only stale incident fields go.
      if (record.opened_at !== null || record.retry_at !== null || record.trial !== null || record.notified) {
        record.opened_at = null;
        record.retry_at = null;
        record.trial = null;
        record.notified = false;
        changed = true;
      }
      return changed;
    }
    if (record.opened_at === null) {
      record.opened_at = now;
      changed = true;
    }
    if (record.state === 'open') {
      if (record.trial !== null) {
        record.trial = null;
        changed = true;
      }
      if (record.retry_at === null) {
        record.retry_at = record.opened_at + CLONE_BREAKER_HOLD_MS;
        changed = true;
      }
      if (now >= record.retry_at) {
        record.state = 'half_open';
        changed = true;
      }
      return changed;
    }
    // half_open: an expired or incomplete trial is inconclusive and reopens; a trial never holds forever.
    const trial = record.trial;
    if (trial && (trial.deadline <= now || trial.started > now || trial.deadline > trial.started + CLONE_BREAKER_TRIAL_MS
      || !SAFE_OWNER.test(trial.owner) || (trial.conversation !== null && !SAFE_CONVERSATION.test(trial.conversation)))) {
      this.reopen(record, now);
      changed = true;
    }
    return changed;
  }

  private trip(record: CloneBreakerRecord, now: number): void {
    record.state = 'open';
    record.incident += 1;
    record.opened_at = now;
    record.retry_at = now + CLONE_BREAKER_HOLD_MS;
    record.trial = null;
    record.notified = false;
  }

  // A failed or inconclusive trial is the same incident: the failure window and the notification claim stay, the hold starts again.
  private reopen(record: CloneBreakerRecord, now: number): void {
    record.state = 'open';
    record.trial = null;
    record.opened_at ??= now;
    record.retry_at = now + CLONE_BREAKER_HOLD_MS;
  }

  private close(record: CloneBreakerRecord): void {
    record.state = 'closed';
    record.opened_at = null;
    record.retry_at = null;
    record.trial = null;
    record.notified = false;
    record.failures = [];
  }

  // A report is trusted only in its normalized form: a repository full name and a conversation id, no URL, whitespace or control character.
  private cleanReport(report: CloneFailureReport): CloneFailureReport | null {
    if (!validClass(report?.class) || typeof report.repository !== 'string' || typeof report.conversation !== 'string') return null;
    const repository = report.repository.trim().toLowerCase();
    const conversation = report.conversation.trim();
    if (!SAFE_REPOSITORY.test(repository) || !SAFE_CONVERSATION.test(conversation)) return null;
    return { class: report.class, repository, conversation };
  }

  private async save(now: number): Promise<void> {
    try {
      await this.jobs.persist(now);
    } catch (error) {
      this.logger.error('clone breaker: the ledger could not be written:', (error as Error)?.message);
    }
  }
}
