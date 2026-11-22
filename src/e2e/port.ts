// What the suite needs from the outside world: the forge client (the Forge interface, through its fixtures) and the ledger of ForgeHands
// (the runs it started for an issue, and the dispatcher's queue for them). Nothing else: the runner and the predicates take these two, so a
// test passes a fake.
import type { Forge } from '../types/forge.ts';
import type { JobStatus } from '../types.ts';

/** The forge operations the suite uses. Every one is part of the Forge interface; the fixtures are required here. */
export type E2eForge = Pick<Forge, 'getIssue' | 'closeIssue' | 'listComments' | 'addComment' | 'getPull' | 'listPulls' | 'closePull' | 'branchTip'
  | 'commitStatus' | 'compare' | 'createIssue' | 'findOrCreateLabel' | 'addLabels' | 'listBranches' | 'deleteBranch' | 'readFile' | 'writeFile'
  | 'deleteFile' | 'getRepository'> & { createIssue: NonNullable<Forge['createIssue']>; listBranches: NonNullable<Forge['listBranches']>;
  deleteBranch: NonNullable<Forge['deleteBranch']>; readFile: NonNullable<Forge['readFile']>; writeFile: NonNullable<Forge['writeFile']>;
  deleteFile: NonNullable<Forge['deleteFile']>; getRepository: NonNullable<Forge['getRepository']> };

/** One run of an issue in the ledger: the route it ran under, its state and times (ms since the epoch). */
export interface TicketRun {
  label: string;
  status: JobStatus;
  created: number;
  started?: number;
  finished?: number;
  /** For a queued or waiting run: how many runs go first (running ones, and queued ones created before it). */
  ahead: number;
  /** What started the run, read from its job: `first` (the worker's first run), `revert restart` (the event carries the revert_retry marker),
   * `escalated after <state>`, or `delivery retry`. For the scenario's notes only; a predicate does not read it. */
  why: string;
}

/** The runs ForgeHands started (and queued) for an issue, through the ledger and the dispatcher's queue. */
export interface LedgerPort {
  /**
   * The runs ForgeHands started for an issue: with `label`, the runs under that route; without it, the runs under every issue route (the
   * routes of kind `issue`: the worker label, its escalation, the fallbacks). A run that was only queued and never started does not count.
   */
  runsOf(repository: string, issue: number, label?: string): number;
  /**
   * The runs ForgeHands started for an issue because its change was reverted (the event carries `revert_retry`, see Dispatcher.revertMerged), under
   * the issue routes. A run that was only queued and never started does not count.
   */
  revertRestartsOf(repository: string, issue: number): number;
  /** Every run of an issue under the issue routes, oldest first, whatever its state (ended ones included). */
  runsStateOf(repository: string, issue: number): TicketRun[];
  /** Drops the runs of an issue that wait or are queued (a closed ticket must not start later). Running runs are left alone. Returns how many. */
  dropQueued(repository: string, issue: number): Promise<number>;
}

/** The forge as the suite needs it, or null when the forge lacks a fixture (GitLab): the suite then cannot run there. */
export function e2eForgeOf(forge: Forge): E2eForge | null {
  const required = ['createIssue', 'listBranches', 'deleteBranch', 'readFile', 'writeFile', 'deleteFile', 'getRepository'] as const;
  if (required.some((name) => typeof forge[name] !== 'function')) return null;
  return forge as E2eForge;
}
