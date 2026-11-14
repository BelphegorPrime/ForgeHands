import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVE = new Set(['queued', 'running']);

// Persistent issue ledger: one record per started or queued run (repo#issue:label -> conversation).
export class JobStore {
  constructor(file) {
    this.file = file;
    this.jobs = new Map();
    this.labels = new Map(); // repo#issue -> { labels, seen }: the labels seen on the last event of an issue
    this.writes = Promise.resolve();
  }
  async load() {
    try {
      const content = JSON.parse(await readFile(this.file, 'utf8'));
      // v0.2.0 to v0.2.4 stored a bare array of jobs.
      const jobs = Array.isArray(content) ? content : content?.jobs;
      if (!Array.isArray(jobs)) throw Error('Invalid job store');
      for (const job of jobs) if (job && job.id) this.jobs.set(job.id, job);
      for (const [key, value] of Object.entries(content?.labels || {})) {
        if (value && Array.isArray(value.labels)) this.labels.set(key, value);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  list(status) {
    const all = [...this.jobs.values()].sort((a, b) => a.created - b.created);
    return status ? all.filter((job) => ACTIVE.has(job.status) && (status === true || job.status === status)) : all;
  }
  getLabels(issueKey) {
    return this.labels.get(issueKey)?.labels ?? null;
  }
  setLabels(issueKey, labels, now = Date.now()) {
    const previous = this.getLabels(issueKey);
    const changed = !previous || previous.length !== labels.length || previous.some((name, i) => name !== labels[i]);
    this.labels.set(issueKey, { labels, seen: now });
    return changed;
  }
  activeByKey(key) {
    return this.list(true).find((job) => job.key === key);
  }
  add(job) {
    const record = { id: randomUUID(), attempts: 0, ...job };
    this.jobs.set(record.id, record);
    return record;
  }
  remove(id) {
    this.jobs.delete(id);
  }
  persist(now = Date.now()) {
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
