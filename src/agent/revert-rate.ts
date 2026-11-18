import type { MergeRecord } from '../types.ts';
import { REVERT_BRANCH } from './bot.ts';

// The revert rate looks at the merges of the last 30 days (the ledger keeps as much). The status page shows the same figure over 7 days too.
export const REVERT_RATE_WINDOW_MS = 30 * 24 * 3600 * 1000;

export interface RevertRate {
  // Merges ForgeHands made in the window. The merges of revert pull requests (ai/revert-<n>) are not merges here.
  merges: number;
  // Of those, the merges whose revert pull request was merged (MergeRecord.reverted_by). A revert that is only started does not count.
  reverted: number;
  // Of those, the merges after which a human had to take over (MergeRecord.needed_human).
  needed_human: number;
  // reverted / merges as a share from 0 to 1; null without merges, so that nothing divides by zero.
  ratio: number | null;
}

// The revert rate of one repository over the merges of a window that ends now.
export function revertRate(merges: MergeRecord[], repository: string, now: number, windowMs = REVERT_RATE_WINDOW_MS): RevertRate {
  const name = repository.toLowerCase();
  const since = now - windowMs;
  const counted = merges.filter((entry) => entry.repository === name && entry.merged_at >= since && !REVERT_BRANCH.test(String(entry.branch || '')));
  const reverted = counted.filter((entry) => entry.reverted_by !== undefined).length;
  return {
    merges: counted.length,
    reverted,
    needed_human: counted.filter((entry) => entry.needed_human === true).length,
    ratio: counted.length ? reverted / counted.length : null
  };
}

// The merge of pull request `number` is undone by the merged revert pull request `revert`. Returns the merge when it was marked now; a merge
// that already has a revert keeps its first one, so a revert of the revert (or a second revert) does not count the merge twice.
export function markReverted(merges: MergeRecord[], repository: string, number: number, revert: number): MergeRecord | undefined {
  const name = repository.toLowerCase();
  const merge = merges.find((entry) => entry.repository === name && entry.number === number && entry.reverted_by === undefined
    && !REVERT_BRANCH.test(String(entry.branch || '')));
  if (!merge) return undefined;
  merge.reverted_by = revert;
  return merge;
}
