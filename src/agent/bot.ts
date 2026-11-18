import type { Json } from '../types.ts';

export interface BotRules {
  authors: Set<string>;
  prefixes: string[];
  /** BOT_REPOS: only these repositories (lowercase full names) have bot pull requests; empty or missing: every allowed repository. */
  repos?: Set<string>;
}

// The branch of a revert pull request (REVERT_ON_RED): ai/revert-<n>, opened by the run that reverts the merge of pull request #<n>.
export const REVERT_BRANCH = /^ai\/revert-\d+$/;

// Does this pull request (Forgejo's JSON, from a webhook or the API) come from a dependency bot the operator listed (BOT_AUTHORS)?
// The author must be listed and, when BOT_BRANCH_PREFIXES is set, the head branch must start with one of the prefixes. The head has to be in
// the repository itself: a bot's branch lives there, a fork is somebody else's code. An agent branch (ai/issue-<n>) is never a bot pull request.
// A revert pull request (ai/revert-<n>) has no ticket either, so it takes the bot's path (no worker fixes it, its own title is the task) whoever
// opened it; the head has to be in the repository.
export function isBotPull(rules: BotRules, pr: Json, repository: string): boolean {
  if (!pr || typeof pr !== 'object') return false;
  const head = pr.head?.repo?.full_name;
  const sameRepo = !(typeof head === 'string' && head.toLowerCase() !== repository.toLowerCase());
  if (REVERT_BRANCH.test(String(pr.head?.ref || ''))) return sameRepo;
  if (!rules.authors.size) return false;
  if (rules.repos?.size && !rules.repos.has(repository.toLowerCase())) return false;
  const login = String(pr.user?.login || pr.user?.username || '').toLowerCase();
  const ref = String(pr.head?.ref || '');
  if (!login || !rules.authors.has(login) || !ref || /^ai\/issue-\d+$/.test(ref)) return false;
  if (rules.prefixes.length && !rules.prefixes.some((prefix) => ref.startsWith(prefix))) return false;
  return sameRepo;
}
