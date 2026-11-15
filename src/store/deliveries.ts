import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class DeliveryStore {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this.inflight = new Set();
    this.writes = Promise.resolve();
  }
  async load() {
    try {
      const content = JSON.parse(await readFile(this.file, 'utf8'));
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw Error('Invalid delivery store');
      for (const [key, value] of Object.entries(content)) {
        if (typeof value === 'number' && value > Date.now() - TTL_MS) this.records.set(key, value);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  has(key) {
    const timestamp = this.records.get(key);
    if (timestamp && timestamp > Date.now() - TTL_MS) return true;
    if (timestamp) this.records.delete(key);
    return false;
  }
  acquire(key) {
    if (this.has(key)) return 'completed';
    if (this.inflight.has(key)) return 'inflight';
    this.inflight.add(key);
    return 'new';
  }
  release(key) { this.inflight.delete(key); }
  async mark(key) {
    this.records.set(key, Date.now());
    this.writes = this.writes.catch(() => {}).then(async () => {
      const cutoff = Date.now() - TTL_MS;
      for (const [id, value] of this.records) if (value < cutoff) this.records.delete(id);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = this.file + '.' + process.pid + '.tmp';
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.writes;
  }
}
