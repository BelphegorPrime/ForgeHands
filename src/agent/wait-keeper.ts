// The waits of the ledger kept moving: waits on the files of older tickets (WAIT_FOR_SAME_FILES) are released when those tickets end, and a
// cycle of waits is broken so that no ticket waits for itself.
import { parseDeclaredFiles } from './files.ts';
import { anyOverlap } from '../utils/path-overlap.ts';
import { pullBranch } from './bot.ts';
import { metrics } from '../metrics.ts';
import type { Job } from '../types.ts';
import { ticketKey, waitGraph } from './waits.ts';
import { FILE_PULLS_LOOKED_AT, ACTIVE_STATUSES, DEP_CACHE_MS, DEP_READS_PER_PASS } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What WaitKeeper reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type WaitKeeperHost = Pick<Dispatcher, 'config' | 'forge' | 'jobs' | 'logger' | 'now' | 'tick'>;

export class WaitKeeper {
  host: WaitKeeperHost;
  // Same-files waits not taken ("repo#j>repo#t") and dependency cycles logged: each once, in memory.
  cyclePairs = new Set<string>();
  cyclesLogged = new Set<string>();
  // The open dependencies read from the forge for the wait graph: ticket key -> when read and what was open (a failed read is an empty answer).
  depCache = new Map<string, { at: number; open: string[] }>();
  depReads = 0; // reads spent in the current pass

  constructor(host: WaitKeeperHost) {
    this.host = host;
  }

  // WAIT_FOR_SAME_FILES: the older issues (lower numbers) whose files this worker job's issue also declares, because they have an open agent
  // pull request that changes them, or a job in the ledger and the same declared files. The oldest goes first, so no ticket ever waits
  // for a newer one and two tickets cannot wait for each other. Any failing read means "not held": a ticket is never stuck on a guess.
  async filesBlockers(job: Job): Promise<number[]> {
    const event = job.event;
    const mine = parseDeclaredFiles(event.issue.body);
    if (!this.host.config.waitForSameFiles || !this.host.config.forgejo || !mine.length) return [];
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const blockers = new Set<number>();
    try {
      const pulls = await this.host.forge.listPulls(repository, { state: 'open', limit: FILE_PULLS_LOOKED_AT });
      for (const pr of (Array.isArray(pulls) ? pulls : []).slice(0, FILE_PULLS_LOOKED_AT)) {
        const other = Number(/^ai\/issue-(\d+)$/.exec(pullBranch(pr))?.[1]);
        if (!other || other >= number || blockers.has(other)) continue;
        const files = await this.host.forge.pullFiles(repository, pr.number, 100);
        const names = (Array.isArray(files) ? files : []).flatMap((file) => [file.filename, file.previous_filename].filter((name): name is string => !!name));
        if (anyOverlap(mine, names)) blockers.add(other);
      }
      for (const other of this.host.jobs.list(true)) {
        const issue = other.event?.issue;
        if (!issue || other.event.bot || other.event.repository.full_name.toLowerCase() !== repository.toLowerCase()) continue;
        if (issue.number >= number || blockers.has(issue.number) || !ACTIVE_STATUSES.has(other.status)) continue;
        if (this.host.config.epicLabels.has(other.label) || !anyOverlap(mine, parseDeclaredFiles(issue.body))) continue;
        if ((await this.host.forge.getIssue(repository, issue.number))?.state === 'open') blockers.add(issue.number);
      }
    } catch (error) {
      this.host.logger.error('could not compare the files of #' + number + ' with the open work, it is not held back:', error.message);
      return [];
    }
    // A blocker that already waits for this ticket (explicit dependencies and the waits in force) would make a cycle: it is not waited for.
    const me = repository.toLowerCase() + '#' + number;
    const kept: number[] = [];
    for (const other of [...blockers].sort((a, b) => a - b)) {
      const key = repository.toLowerCase() + '#' + other;
      if (!(await this.waitReaches(key, me, true))) kept.push(other);
      else this.noteCycle(me, key);
    }
    return kept;
  }

  // Whether `to` is waited for, directly or through other waits, starting from `from`: the waits in force (the ledger's waiting jobs, explicit and, with
  // `files`, same-files) and, for a ticket that has no waiting job with explicit dependencies, its open dependencies in the forge (forgeEdges).
  async waitReaches(from: string, to: string, files: boolean): Promise<boolean> {
    const ledger = waitGraph(this.host.jobs.list(), files);
    const explicit = waitGraph(this.host.jobs.list(), false);
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i += 1) {
      const node = queue[i];
      if (node === to) return true;
      const edges = new Set(ledger.get(node) ?? []);
      if (!explicit.has(node)) for (const next of await this.forgeEdges(node)) edges.add(next);
      for (const next of edges) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return false;
  }

  // The open dependencies of a ticket, read from the forge. Cached per ticket for DEP_CACHE_MS; a failed read counts as none (cached too, so the
  // ticket is not read again in that time); past DEP_READS_PER_PASS reads in a pass the answer is none for now (not cached). A ticket whose jobs are
  // all archived (closed on the status page) is not read: its open dependencies do not hold anything back.
  async forgeEdges(node: string): Promise<string[]> {
    const cached = this.depCache.get(node);
    if (cached && this.host.now() - cached.at < DEP_CACHE_MS) return cached.open;
    const own = this.host.jobs.list().filter((job) => ticketKey(job) === node);
    if (!this.host.config.forgejo || (own.length && own.every((job) => job.archived_view))) return [];
    if (this.depReads >= DEP_READS_PER_PASS) return [];
    this.depReads += 1;
    const at = own[0]?.event.repository.full_name ?? node.split('#')[0];
    const number = Number(node.split('#')[1]);
    let open: string[] = [];
    try {
      const dependencies = await this.host.forge.dependencies(at, number);
      open = (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open').map((issue) => node.split('#')[0] + '#' + issue.number);
    } catch (error) {
      this.host.logger.error('could not read the dependencies of #' + number + ', its waits are not known for now:', error.message);
    }
    this.depCache.set(node, { at: this.host.now(), open });
    return open;
  }

  // A same-files wait that closes a cycle is not taken: the older ticket already waits for this one, through explicit dependencies or other waits in
  // force. Logged and counted once per pair (`waiting` is a ticket key, `other` the older one).
  noteCycle(waiting: string, other: string): void {
    const pair = waiting + '>' + other;
    if (this.cyclePairs.has(pair)) return;
    this.cyclePairs.add(pair);
    metrics.inc('forgehands_wait_cycles_broken_total');
    const number = other.split('#')[1];
    this.host.logger.error(waiting + ': not waiting for #' + number + ' (same files): #' + number + ' is blocked by this ticket (cycle)');
  }

  // The waits in force are read from the ledger (no forge read): a same-files wait that closes a cycle is dropped, the explicit dependencies never. A job
  // left with no wait is queued again. True when something changed.
  async breakWaitCycles(): Promise<boolean> {
    if (!this.host.config.waitForSameFiles) return false;
    let changed = false;
    for (const job of this.host.jobs.list('waiting')) {
      if (!job.waiting_for_files?.length || job.waiting_for?.length || job.waiting_for_run || job.event.bot || job.event.pull_request) continue;
      const me = ticketKey(job);
      const repository = job.event.repository.full_name.toLowerCase();
      const kept: number[] = [];
      for (const number of job.waiting_for_files) {
        const other = repository + '#' + number;
        if (await this.waitReaches(other, me, true)) this.noteCycle(me, other);
        else kept.push(number);
      }
      if (kept.length === job.waiting_for_files.length) continue;
      changed = true;
      if (kept.length) job.waiting_for_files = kept;
      else {
        job.status = 'queued';
        delete job.waiting_for_files;
        this.host.logger.error(job.key + ' no longer waits for the files of older tickets (cycle)');
      }
    }
    return changed;
  }

  // Look again at the jobs that wait for the same files and queue those whose older tickets are gone. Called when something may have
  // been freed (a push to the default branch, a closed issue, a run that ended); startJob checks once more before a worker starts.
  async releaseFileWaits(): Promise<boolean> {
    if (!this.host.config.waitForSameFiles) return false;
    let changed = false;
    for (const job of this.host.jobs.list('waiting')) {
      if (!job.waiting_for_files?.length || job.waiting_for?.length) continue;
      const blockers = await this.filesBlockers(job);
      if (blockers.length) { job.waiting_for_files = blockers; continue; }
      job.status = 'queued';
      delete job.waiting_for_files;
      this.host.logger.error(job.key + ' no longer waits for the files of older tickets');
      changed = true;
    }
    return changed;
  }

  // The same, from outside a pass (a webhook): save and start what was released.
  async releaseFileWaitsNow(): Promise<void> {
    try {
      if (!(await this.releaseFileWaits())) return;
      await this.host.jobs.persist(this.host.now());
      this.host.tick().catch((error) => this.host.logger.error('dispatch failed:', error.message));
    } catch (error) {
      this.host.logger.error('could not release the tickets that wait for the same files:', error.message);
    }
  }
}
