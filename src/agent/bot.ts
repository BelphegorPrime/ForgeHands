import type { Json } from '../types.ts';

export interface BotRules {
  authors: Set<string>;
  prefixes: string[];
  /** BOT_REPOS: only these repositories (lowercase full names) have bot pull requests; empty or missing: every allowed repository. */
  repos?: Set<string>;
}

// Does this pull request (Forgejo's JSON, from a webhook or the API) come from a dependency bot the operator listed (BOT_AUTHORS)?
// The author must be listed and, when BOT_BRANCH_PREFIXES is set, the head branch must start with one of the prefixes. The head has to be in
// the repository itself: a bot's branch lives there, a fork is somebody else's code. An agent branch (ai/issue-<n>) is never a bot pull request.
export function isBotPull(rules: BotRules, pr: Json, repository: string): boolean {
  if (!rules.authors.size || !pr || typeof pr !== 'object') return false;
  if (rules.repos?.size && !rules.repos.has(repository.toLowerCase())) return false;
  const login = String(pr.user?.login || pr.user?.username || '').toLowerCase();
  const ref = String(pr.head?.ref || '');
  if (!login || !rules.authors.has(login) || !ref || /^ai\/issue-\d+$/.test(ref)) return false;
  if (rules.prefixes.length && !rules.prefixes.some((prefix) => ref.startsWith(prefix))) return false;
  const head = pr.head?.repo?.full_name;
  return !(typeof head === 'string' && head.toLowerCase() !== repository.toLowerCase());
}
