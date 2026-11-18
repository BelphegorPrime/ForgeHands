// Cleans the workspace and guards the disk (WORKSPACE_CLEANUP_DIR, WORKSPACE_KEEP_HOURS, WORKSPACE_KEEP_FAILED_HOURS, WORKSPACE_ORPHAN_HOURS,
// WORKSPACE_CLEANUP_DRY, DISK_WARN_PERCENT, DISK_MIN_FREE_GB). OpenHands runs every job in its own clone directory below its workspace and
// nothing deletes them, so the disk fills up. ForgeHands sees the same directory through WORKSPACE_CLEANUP_DIR: it deletes the clone of a job
// once the job ended long enough ago, and the directories that no ledger job names any more once they are old enough. Names that do not
// match the naming of ForgeHands are never touched, and nothing outside the directory is followed.
import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ACTIVE } from '../store/jobs.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Notify } from '../notify/index.ts';
import { diskMessage } from '../notify/texts.ts';
import { metrics } from '../metrics.ts';
import type { DirectConfig, Job, Logger } from '../types.ts';
import { workspaceName } from './prompt.ts';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const GB = 1e9;
// Every 30 minutes, and once shortly after the start.
export const PASS_EVERY_MS = 30 * 60000;
const FIRST_PASS_MS = 60000;
// The names ForgeHands gives a clone directory (see workspaceName): repository, then an epic (no suffix), or an issue or a dependency bot's
// pull request with the optional suffix of a round, a review, a fix, a conflict or a security review (at most 8 characters of a delivery id
// or a commit). Nothing else is ever a candidate.
const SCHEME = /^\w[\w.-]*-[\w.-]+-(?:epic-\d+|(?:issue|pr)-\d+(?:-(?:round|review|fix|conflict|security)-\w{0,8})?)$/;

// The part of the filesystem API that the cleanup uses; the tests replace it with fakes.
export interface WorkspaceFs {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ isDirectory(): boolean; mtimeMs: number }>;
  realpath(path: string): Promise<string>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  statfs(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
}

export const nodeFs: WorkspaceFs = {
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  rm: (path, options) => rm(path, options),
  statfs: async (path) => {
    const usage = await statfs(path);
    return { bsize: usage.bsize, blocks: usage.blocks, bfree: usage.bfree, bavail: usage.bavail };
  }
};

/** What the status page and the metrics show of the workspace; null when the cleanup is off. */
export interface WorkspaceState {
  dry: boolean;
  last_pass: string | null;
  cleaned_last_pass: number;
  used_percent: number | null;
  free_gb: number | null;
  /** The reason new runs wait (low disk space), or null. */
  hold: string | null;
}

const errText = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200);

// The directory names a job holds while it is active. A round whose delivery id is missing gets a time-based name that cannot be
// computed again later, so such a job holds every name of its round prefix instead.
function holdsOf(job: Job): { name: string; prefix: string | null } | null {
  let name: string;
  try { name = workspaceName(job.event); } catch { return null; }
  const prefix = !job.event.delivery_id && name.includes('-round-') ? name.replace(/-round-\w*$/, '-round-') : null;
  return { name, prefix };
}
const holds = (job: Job, name: string): boolean => {
  const held = holdsOf(job);
  return Boolean(held) && (held!.name === name || (held!.prefix !== null && name.startsWith(held!.prefix)));
};

export class Workspace {
  config: DirectConfig;
  jobs: JobStore;
  fs: WorkspaceFs;
  logger: Logger;
  now: () => number;
  notifier: Notify;
  /** Filesystem usage of WORKSPACE_CLEANUP_DIR as of the last measurement (null before the first one or when it cannot be read). */
  usedPercent: number | null = null;
  freeBytes: number | null = null;
  /** True while no new run starts because the disk is below DISK_MIN_FREE_GB. */
  holding = false;
  lastPass: number | null = null;
  cleanedLastPass = 0;
  /** When the disk warning was last sent (in memory: a restart may send it once more). */
  lastWarned: number | null = null;
  lastMeasureError: string | null = null;
  running: Promise<void> | null = null;
  timer: NodeJS.Timeout | undefined;
  firstTimer: NodeJS.Timeout | undefined;

  constructor(config: DirectConfig, jobs: JobStore, options: { fs?: WorkspaceFs; logger?: Logger; now?: () => number; notifier?: Notify } = {}) {
    this.config = config;
    this.jobs = jobs;
    this.fs = options.fs ?? nodeFs;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.notifier = options.notifier ?? { wants: () => false, notify: () => {} };
  }

  get enabled(): boolean {
    return this.config.workspaceCleanupDir !== null;
  }

  // Deletion is off in a dry run (DRY_RUN) and with WORKSPACE_CLEANUP_DRY=1.
  get dry(): boolean {
    return this.config.workspaceCleanupDry || this.config.dryRun;
  }

  start(): void {
    if (!this.enabled) return;
    this.firstTimer = setTimeout(() => { void this.run(); }, FIRST_PASS_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.run(); }, PASS_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  // Called by every dispatch pass. Reads the filesystem (one cheap call) and sets or lifts the hold for new runs. A hold that begins starts
  // a cleanup pass at once, in the background, so that the hold can end again soon. Never throws.
  async poll(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.measure();
      if (this.updateHold()) void this.run();
    } catch (error) {
      this.logger.error('workspace disk check failed:', errText(error));
    }
  }

  // One cleanup pass at a time: a call while one runs gets that pass. Never rejects.
  run(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (!this.running) {
      this.running = this.pass()
        .catch((error) => { this.logger.error('workspace cleanup failed:', errText(error)); })
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  // The state for /status.json, the status page and the metrics; null when the cleanup is off.
  state(): WorkspaceState | null {
    if (!this.enabled) return null;
    return {
      dry: this.dry,
      last_pass: this.lastPass === null ? null : new Date(this.lastPass).toISOString(),
      cleaned_last_pass: this.cleanedLastPass,
      used_percent: this.usedPercent,
      free_gb: this.freeBytes === null ? null : Math.round(this.freeBytes / GB * 10) / 10,
      hold: this.holdText()
    };
  }

  holdText(): string | null {
    if (!this.holding || this.freeBytes === null) return null;
    return 'low disk space (' + (Math.round(this.freeBytes / GB * 10) / 10) + ' GB free)';
  }

  // Reads the usage of the filesystem. A failure is logged once until it changes; the last known values stay.
  async measure(): Promise<void> {
    const dir = this.config.workspaceCleanupDir;
    if (!dir) return;
    try {
      const usage = await this.fs.statfs(dir);
      const used = (usage.blocks - usage.bfree) * usage.bsize;
      const available = usage.bavail * usage.bsize;
      const total = used + available;
      this.usedPercent = total > 0 ? Math.round(used / total * 1000) / 10 : 0;
      this.freeBytes = available;
      this.lastMeasureError = null;
    } catch (error) {
      const message = errText(error);
      if (message !== this.lastMeasureError) this.logger.error('workspace disk: cannot read the usage of ' + dir + ':', message);
      this.lastMeasureError = message;
    }
  }

  // Below DISK_MIN_FREE_GB a hold is on (no new run starts). Returns true when the hold has just begun.
  updateHold(): boolean {
    if (this.freeBytes === null) return false;
    const low = this.config.diskMinFreeGb > 0 && this.freeBytes < this.config.diskMinFreeGb * GB;
    if (low === this.holding) return false;
    this.holding = low;
    if (low) {
      this.logger.error('workspace disk: ' + this.holdText() + ', no new run starts until ' + this.config.diskMinFreeGb + ' GB are free (DISK_MIN_FREE_GB)');
      return true;
    }
    this.logger.error('workspace disk: free space is back above DISK_MIN_FREE_GB, new runs start again');
    return false;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    const counts = await this.cleanup(now);
    this.lastPass = now;
    this.cleanedLastPass = counts.cleaned;
    await this.measure();
    this.warnIfFull(now);
    this.updateHold();
    const disk = this.usedPercent === null ? 'disk usage unknown' : 'disk ' + this.usedPercent + ' % used, ' + (this.freeBytes === null ? '?' : Math.round(this.freeBytes / GB * 10) / 10) + ' GB free';
    if (this.dry) {
      this.logger.error('workspace cleanup (dry run, nothing deleted): ' + counts.wouldClean + ' would be cleaned, ' + counts.kept + ' kept; ' + disk);
    } else {
      this.logger.error('workspace cleanup: ' + counts.cleaned + ' cleaned (' + counts.finished + ' finished, ' + counts.orphans + ' orphans), ' + counts.failed + ' failed, '
        + counts.kept + ' kept; ' + disk);
    }
  }

  // The directories below WORKSPACE_CLEANUP_DIR that may go, by the rules of the README: a directory of a job that ended (each of its jobs
  // longer ago than WORKSPACE_KEEP_HOURS, or WORKSPACE_KEEP_FAILED_HOURS when it failed) and an orphan (no ledger job names it, and its
  // modification time is older than WORKSPACE_ORPHAN_HOURS). A directory that an active job holds is never removed.
  async cleanup(now: number): Promise<{ cleaned: number; finished: number; orphans: number; failed: number; kept: number; wouldClean: number }> {
    const counts = { cleaned: 0, finished: 0, orphans: 0, failed: 0, kept: 0, wouldClean: 0 };
    const root = this.config.workspaceCleanupDir;
    if (!root) return counts;
    let names: string[];
    let rootReal: string;
    try {
      names = await this.fs.readdir(root);
      rootReal = await this.fs.realpath(root);
    } catch (error) {
      this.logger.error('workspace cleanup: cannot read ' + root + ':', errText(error));
      return counts;
    }
    const ledger = this.jobs.list();
    const active = ledger.filter((job) => ACTIVE.has(job.status));
    // The jobs that name each directory (by its exact name), finished or not.
    const owners = new Map<string, Job[]>();
    for (const job of ledger) {
      const held = holdsOf(job);
      if (held) owners.set(held.name, [...(owners.get(held.name) || []), job]);
    }
    const keepMs = (job: Job) => (job.status === 'failed' ? this.config.workspaceKeepFailedHours : this.config.workspaceKeepHours) * HOUR_MS;
    const endedAt = (job: Job) => job.finished ?? job.created;
    const candidates: { name: string; path: string; reason: 'finished' | 'orphan' }[] = [];
    for (const name of names) {
      // Anything that is not the name of a ForgeHands run is never touched.
      if (!SCHEME.test(name)) continue;
      const path = join(root, name);
      let info: { isDirectory(): boolean; mtimeMs: number };
      try {
        info = await this.fs.lstat(path);
      } catch {
        continue; // gone since the listing
      }
      // A symlink (or a file) of that name is left alone: nothing is followed out of the tree.
      if (!info.isDirectory()) { counts.kept += 1; continue; }
      if (active.some((job) => holds(job, name))) { counts.kept += 1; continue; }
      const jobsOfName = owners.get(name) || [];
      let reason: 'finished' | 'orphan';
      if (jobsOfName.length) {
        if (!jobsOfName.every((job) => now - endedAt(job) > keepMs(job))) { counts.kept += 1; continue; }
        reason = 'finished';
      } else {
        if (now - info.mtimeMs <= this.config.workspaceOrphanHours * HOUR_MS) { counts.kept += 1; continue; }
        reason = 'orphan';
      }
      // The resolved path must be the directory itself, inside the root (a symlinked root is resolved once, above).
      let real: string;
      try {
        real = await this.fs.realpath(path);
      } catch {
        continue;
      }
      if (real !== join(rootReal, name) || dirname(real) !== rootReal || basename(real) !== name) {
        this.logger.error('workspace cleanup: ' + name + ' resolves outside ' + root + ', not touched');
        counts.kept += 1;
        continue;
      }
      candidates.push({ name, path, reason });
    }
    for (const candidate of candidates) {
      // Checked again right before the delete: a job for this name may have been queued since the listing.
      if (this.jobs.list(true).some((job) => holds(job, candidate.name))) { counts.kept += 1; continue; }
      if (this.dry) {
        counts.wouldClean += 1;
        this.logger.error(candidate.name + ': would be cleaned (' + candidate.reason + '), dry run');
        continue;
      }
      try {
        await this.fs.rm(candidate.path, { recursive: true, force: true });
        counts.cleaned += 1;
        if (candidate.reason === 'finished') counts.finished += 1; else counts.orphans += 1;
        metrics.inc('forgehands_workspace_cleaned_total');
        this.logger.error(candidate.name + ': cleaned (size not measured)');
      } catch (error) {
        counts.failed += 1;
        this.logger.error('could not clean ' + candidate.name + ', tried again in the next pass:', errText(error));
      }
    }
    return counts;
  }

  // One disk warning per day while the usage is at or above DISK_WARN_PERCENT, through the notifier (its channels only).
  private warnIfFull(now: number): void {
    const warn = this.config.diskWarnPercent;
    if (!warn || this.usedPercent === null || this.usedPercent < warn) return;
    if (this.lastWarned !== null && now - this.lastWarned < DAY_MS) return;
    this.lastWarned = now;
    this.logger.error('workspace disk: ' + this.usedPercent + ' % used, at or above DISK_WARN_PERCENT (' + warn + ')');
    try {
      this.notifier.notify(diskMessage(this.config.notify.language, {
        usedPercent: this.usedPercent,
        freeGb: Math.round((this.freeBytes ?? 0) / GB * 10) / 10,
        warnPercent: warn,
        minFreeGb: this.config.diskMinFreeGb
      }));
    } catch (error) {
      this.logger.error('disk warning failed:', errText(error));
    }
  }
}
