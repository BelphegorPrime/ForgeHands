// The facts about blocked agent pull requests that the status page, the idle summary and the gauges share. The watchdog (ReviewSweep.watchStuck)
// keeps the records in the ledger; a ticket that waits, directly or through other waiting tickets, for a blocked one is marked "waiting behind stuck".
// Read from the ledger only: no forge read.
import { waitGraph } from './waits.ts';
import type { Job, StuckRecord } from '../types.ts';

// The ledger key of a pull request's stuck record: "repo#pr<n>" (lower case), the form the holds of two-key merges use too.
export const stuckKey = (repository: string, number: number): string => repository.toLowerCase() + '#pr' + number;

// The tickets ("repo#issue", lower case) whose pull request is blocked now.
export function blockedTickets(records: Map<string, StuckRecord>): Set<string> {
  const tickets = new Set<string>();
  for (const record of records.values()) if (record.blocked) tickets.add(record.repository.toLowerCase() + '#' + record.issue);
  return tickets;
}

// For every ticket that waits on a blocked ticket (an explicit dependency, or a same-files wait in force), directly or through other waiting
// tickets: the numbers of the blocked tickets it waits behind, ascending. A ticket that waits on nothing blocked has no entry.
export function behindBlocked(jobs: Job[], blocked: Set<string>): Map<string, number[]> {
  const graph = waitGraph(jobs, true);
  const result = new Map<string, number[]>();
  for (const start of graph.keys()) {
    const found: number[] = [];
    const seen = new Set<string>([start]);
    const queue = [...(graph.get(start) ?? [])];
    while (queue.length) {
      const node = queue.shift()!;
      if (seen.has(node)) continue;
      seen.add(node);
      if (blocked.has(node)) found.push(Number(node.slice(node.lastIndexOf('#') + 1)));
      queue.push(...(graph.get(node) ?? []));
    }
    if (found.length) result.set(start, found.sort((a, b) => a - b));
  }
  return result;
}
