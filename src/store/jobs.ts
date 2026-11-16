import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Job, JobStatus, NewJob } from '../types.ts';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// `waiting`: the issue depends on issues that are still open; it starts when the last one closes.
export const ACTIVE = new Set<JobStatus>(['waiting', 'queued', 'running']);

interface SeenLabels { labels: string[]; seen: number }

// Persistent issue ledger: one record per started or queued run (repo#issue:label -> conversation).
export class JobStore {
  file: string;
  jobs = new Map<string, Job>();
  labels = new Map<string, SeenLabels>(); // repo#issue -> { labels, seen }: the labels seen on the last event of an issue
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
      for (const [key, value] of Object.entries((content?.labels || {}) as Record<string, SeenLabels>)) {
        if (value && Array.isArray(value.labels)) this.labels.set(key, value);
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
      for (const [key, value] of this.labels) if (value.seen < now - KEEP_MS) this.labels.delete(key);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify({ version: 2, jobs: [...this.jobs.values()], labels: Object.fromEntries(this.labels) }), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writes;
  }
}
