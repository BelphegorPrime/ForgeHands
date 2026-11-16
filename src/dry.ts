import type { Config, Logger } from './types.ts';

const MAX_KEPT = 200;
const READ_ONLY = new Set(['GET', 'HEAD']);

// DRY_RUN: is a write about this repository replaced by a log line? Without DRY_RUN_REPOS every repository is dry; with it only those.
// No repository (a call that does not belong to one) is dry whenever dry mode is on at all: when in doubt, nothing is written.
export function isDry(config: Pick<Config, 'dryRun' | 'dryRunRepos'>, repository?: string): boolean {
  if (!config.dryRun) return false;
  if (!config.dryRunRepos.size || !repository) return true;
  return config.dryRunRepos.has(repository.toLowerCase());
}

export const isWrite = (method: string): boolean => !READ_ONLY.has(method.toUpperCase());

export interface DryWrite { at: string; target: string; method: string; path: string; body: string | null }

// The would-be writes of a dry run: logged as they happen, and the latest ones kept (in memory only) for /status.json.
export class DryLog {
  writes: DryWrite[] = [];
  logger: Logger;

  constructor(logger: Logger = console) {
    this.logger = logger;
  }

  record(target: string, method: string, path: string, body?: unknown): void {
    const text = body === undefined ? null : JSON.stringify(body).slice(0, 300);
    this.writes.push({ at: new Date().toISOString(), target, method, path, body: text });
    if (this.writes.length > MAX_KEPT) this.writes.shift();
    this.logger.error('DRY RUN, not sent: ' + method + ' ' + target + path + (text ? ' ' + text : ''));
  }
}
