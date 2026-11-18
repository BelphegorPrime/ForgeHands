import type { Json } from '../types.ts';

export interface BotRules {
  authors: Set<string>;
  prefixes: string[];
  /** BOT_REPOS: only these repositories (lowercase full names) have bot pull requests; empty or missing: every allowed repository. */
  repos?: Set<string>;
}

// The branch of a revert pull request (REVERT_ON_RED): ai/revert-<n>, opened by the run that reverts the merge of pull request #<n>.
export const REVERT_BRANCH = /^ai\/revert-\d+$/;

// Forgejo's head.ref of a pull request whose branch is gone (merged, branch deleted): the pull request's own ref, not a branch name.
const PULL_REF = /^refs\/pull\/\d+\/head$/;

// Is this a ref of a pull request (refs/pull/<n>/head) rather than the name of a branch?
export function isPullRef(name: unknown): boolean {
  return PULL_REF.test(String(name ?? ''));
}

// The real branch name of a pull request object (Forgejo's JSON, from the API or a webhook). After a merge Forgejo deletes the head branch and
// then reports head.ref as refs/pull/<n>/head, while head.label still names the branch ("ai/issue-28"; a fork's label is "owner:branch").
// So: head.ref when it names a branch, else head.label without the owner prefix. Every match of a branch name goes through here.
export function pullBranch(pr: Json | null | undefined): string {
  const ref = String(pr?.head?.ref ?? '');
  if (ref && !isPullRef(ref)) return ref;
  return String(pr?.head?.label ?? '').replace(/^[^:]*:/, '');
}

// Does this pull request (Forgejo's JSON, from a webhook or the API) come from a dependency bot the operator listed (BOT_AUTHORS)?
// The author must be listed and, when BOT_BRANCH_PREFIXES is set, the head branch must start with one of the prefixes. The head has to be in
// the repository itself: a bot's branch lives there, a fork is somebody else's code. An agent branch (ai/issue-<n>) is never a bot pull request.
// A revert pull request (ai/revert-<n>) has no ticket either, so it takes the bot's path (no worker fixes it, its own title is the task) whoever
// opened it; the head has to be in the repository.
export function isBotPull(rules: BotRules, pr: Json, repository: string): boolean {
  if (!pr || typeof pr !== 'object') return false;
  const head = pr.head?.repo?.full_name;
  const sameRepo = !(typeof head === 'string' && head.toLowerCase() !== repository.toLowerCase());
  const ref = pullBranch(pr);
  if (REVERT_BRANCH.test(ref)) return sameRepo;
  if (!rules.authors.size) return false;
  if (rules.repos?.size && !rules.repos.has(repository.toLowerCase())) return false;
  const login = String(pr.user?.login || pr.user?.username || '').toLowerCase();
  if (!login || !rules.authors.has(login) || !ref || /^ai\/issue-\d+$/.test(ref)) return false;
  if (rules.prefixes.length && !rules.prefixes.some((prefix) => ref.startsWith(prefix))) return false;
  return sameRepo;
}
