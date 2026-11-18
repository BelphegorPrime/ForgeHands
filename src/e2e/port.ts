// What the suite needs from the outside world: the forge client (the Forge interface, through its fixtures) and the ledger of ForgeHands
// (how many runs it started for an issue). Nothing else: the runner and the predicates take these two, so a test passes a fake.
import type { Forge } from '../types/forge.ts';

/** The forge operations the suite uses. Every one is part of the Forge interface; the fixtures are required here. */
export type E2eForge = Pick<Forge, 'getIssue' | 'closeIssue' | 'listComments' | 'addComment' | 'getPull' | 'listPulls' | 'closePull' | 'branchTip'
  | 'commitStatus' | 'compare' | 'createIssue' | 'findOrCreateLabel' | 'addLabels' | 'listBranches' | 'deleteBranch' | 'readFile' | 'writeFile'
  | 'deleteFile' | 'getRepository'> & { createIssue: NonNullable<Forge['createIssue']>; listBranches: NonNullable<Forge['listBranches']>;
  deleteBranch: NonNullable<Forge['deleteBranch']>; readFile: NonNullable<Forge['readFile']>; writeFile: NonNullable<Forge['writeFile']>;
  deleteFile: NonNullable<Forge['deleteFile']>; getRepository: NonNullable<Forge['getRepository']> };

/** The runs ForgeHands started for an issue with a label (the ledger, including the ones that ended). */
export interface LedgerPort {
  runsOf(repository: string, issue: number, label: string): number;
}

/** The forge as the suite needs it, or null when the forge lacks a fixture (GitLab): the suite then cannot run there. */
export function e2eForgeOf(forge: Forge): E2eForge | null {
  const required = ['createIssue', 'listBranches', 'deleteBranch', 'readFile', 'writeFile', 'deleteFile', 'getRepository'] as const;
  if (required.some((name) => typeof forge[name] !== 'function')) return null;
  return forge as E2eForge;
}
