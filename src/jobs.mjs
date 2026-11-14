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
    this.writes = Promise.resolve();
  }
  async load() {
    try {
      const content = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(content)) throw Error('Invalid job store');
      for (const job of content) if (job && job.id) this.jobs.set(job.id, job);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  list(status) {
    const all = [...this.jobs.values()].sort((a, b) => a.created - b.created);
    return status ? all.filter((job) => ACTIVE.has(job.status) && (status === true || job.status === status)) : all;
  }
  activeByKey(key) {
    return this.list(true).find((job) => job.key === key);
  }
  add(job) {
    const record = { id: randomUUID(), attempts: 0, ...job };
    this.jobs.set(record.id, record);
    return record;
  }
  persist(now = Date.now()) {
    this.writes = this.writes.catch(() => {}).then(async () => {
      for (const [id, job] of this.jobs) {
        if (!ACTIVE.has(job.status) && (job.finished || job.created) < now - KEEP_MS) this.jobs.delete(id);
      }
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify([...this.jobs.values()]), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writes;
  }
}
