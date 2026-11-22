// Checks a predicate of a scenario step against the forge and the ledger, once. The runner polls it for a wait and calls it once for an assert.
import type { CommentMatch, Predicate } from './format.ts';
import type { E2eForge, LedgerPort } from './port.ts';
import type { PullRequest } from '../types/forge.ts';

export interface Probe {
  forge: E2eForge;
  repository: string;
  /** The default branch, which `branch: 'default'` names. */
  defaultBranch: string;
  ledger: LedgerPort;
  /** The `$name` variables of the run (ticket numbers and captured pull request numbers). */
  vars: Map<string, number>;
}

export interface Verdict {
  ok: boolean;
  /** Says what was seen, for the report: it is the reason of a failed assert and the last state of a timed out wait. */
  detail: string;
  /** The number a findPull found. */
  captured?: number;
}

/** Replaces each `$name` by the variable's value; an unknown name throws (the parser rejects those first, so it is a bug if it happens). */
export function expand(text: string, vars: Map<string, number>): string {
  return text.replace(/\$([a-z][a-zA-Z0-9]{0,40})/g, (_, name: string) => {
    if (!vars.has(name)) throw new Error('no value for $' + name);
    return String(vars.get(name));
  });
}

/** The number a reference such as `$ticket` stands for. */
export function numberOf(text: string, vars: Map<string, number>): number {
  const value = Number(expand(text, vars));
  if (!Number.isInteger(value) || value < 1) throw new Error('"' + text + '" is not an issue or pull request number');
  return value;
}

// A comment check: how many comments contain the text, against min and max.
function commentVerdict(bodies: string[], match: CommentMatch, vars: Map<string, number>): Verdict {
  const text = expand(match.contains, vars);
  const count = bodies.filter((body) => body.includes(text)).length;
  const min = match.min ?? 1;
  const ok = count >= min && (match.max === undefined || count <= match.max);
  return { ok, detail: 'comments containing "' + text.slice(0, 80) + '": ' + count + ' (wanted ' + (match.max === undefined ? 'at least ' + min : min + (match.max === min ? '' : '..' + match.max)) + ')' };
}

// The state a pull request is in, in the words of the predicate.
function pullState(pr: PullRequest): 'open' | 'closed' | 'merged' {
  if (pr.merged) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

// Pages of 50 newest first, three pages at most: a test repository has far fewer pull requests than that.
async function findPullNumber(probe: Probe, head: string, state: string | undefined): Promise<{ number: number | null; seen: number }> {
  let seen = 0;
  for (let page = 1; page <= 3; page++) {
    const pulls = await probe.forge.listPulls(probe.repository, { state: 'all', limit: 50, sort: 'recentupdate', page });
    seen += pulls.length;
    const hit = pulls.find((pr) => branchOf(pr) === head && (!state || pullState(pr) === state));
    if (hit) return { number: hit.number, seen };
    if (pulls.length < 50) break;
  }
  return { number: null, seen };
}

/** The head branch of a pull request. A merged one can be reported as refs/pull/<n>/head, then its label names the branch. */
export function branchOf(pr: PullRequest): string {
  const ref = String(pr.head?.ref ?? '');
  if (ref && !ref.startsWith('refs/pull/')) return ref;
  return String((pr.head as { label?: string } | undefined)?.label ?? '').replace(/^[^:]*:/, '');
}

export async function probe(predicate: Predicate, p: Probe): Promise<Verdict> {
  if ('issue' in predicate) {
    const number = numberOf(predicate.issue, p.vars);
    const issue = await p.forge.getIssue(p.repository, number);
    const problems: string[] = [];
    if (predicate.state && issue.state !== predicate.state) problems.push('state is ' + issue.state);
    if (predicate.hasLabel && !(issue.labels || []).some((label) => label.name === predicate.hasLabel)) problems.push('no label ' + predicate.hasLabel);
    if (predicate.comment) {
      const comments = await p.forge.listComments(p.repository, number, 100);
      const verdict = commentVerdict(comments.map((comment) => comment.body || ''), predicate.comment, p.vars);
      if (!verdict.ok) problems.push(verdict.detail);
    }
    return problems.length ? { ok: false, detail: '#' + number + ': ' + problems.join('; ') } : { ok: true, detail: '#' + number + ' as wanted' };
  }
  if ('pull' in predicate) {
    const number = numberOf(predicate.pull, p.vars);
    const pr = await p.forge.getPull(p.repository, number);
    const problems: string[] = [];
    if (predicate.state && pullState(pr) !== predicate.state) problems.push('state is ' + pullState(pr));
    if (predicate.hasLabel && !(pr.labels || []).some((label) => label.name === predicate.hasLabel)) problems.push('no label ' + predicate.hasLabel);
    if (predicate.comment) {
      const comments = await p.forge.listComments(p.repository, number, 100);
      const verdict = commentVerdict(comments.map((comment) => comment.body || ''), predicate.comment, p.vars);
      if (!verdict.ok) problems.push(verdict.detail);
    }
    return problems.length ? { ok: false, detail: 'pull request #' + number + ': ' + problems.join('; ') } : { ok: true, detail: 'pull request #' + number + ' as wanted' };
  }
  if ('findPull' in predicate) {
    const head = expand(predicate.findPull, p.vars);
    const found = await findPullNumber(p, head, predicate.state);
    return found.number === null
      ? { ok: false, detail: 'no pull request from ' + head + ' among ' + found.seen + ' seen' }
      : { ok: true, detail: 'pull request #' + found.number + ' from ' + head, captured: found.number };
  }
  if ('mergeCommit' in predicate) {
    const number = numberOf(predicate.mergeCommit, p.vars);
    const pr = await p.forge.getPull(p.repository, number);
    if (!pr.merged || !pr.merge_commit_sha) return { ok: false, detail: 'pull request #' + number + ' has no merge commit yet' };
    const status = await p.forge.commitStatus(p.repository, pr.merge_commit_sha);
    const wanted = expand(predicate.status, p.vars);
    return { ok: status.state === wanted, detail: 'merge commit of #' + number + ' is ' + status.state + ' (wanted ' + wanted + ')' };
  }
  if ('branch' in predicate) {
    const name = predicate.branch === 'default' ? p.defaultBranch : predicate.branch;
    const tip = await p.forge.branchTip(p.repository, name);
    if (!tip) return { ok: false, detail: 'branch ' + name + ' does not exist' };
    const status = await p.forge.commitStatus(p.repository, tip);
    return { ok: status.state === predicate.status, detail: 'tip of ' + name + ' is ' + status.state + ' (wanted ' + predicate.status + ')' };
  }
  if ('revertRestarts' in predicate) {
    const number = numberOf(predicate.revertRestarts, p.vars);
    const restarts = p.ledger.revertRestartsOf(p.repository, number);
    const problems: string[] = [];
    if (predicate.exactly !== undefined && restarts !== predicate.exactly) problems.push('revert restarts ' + restarts + ', wanted exactly ' + predicate.exactly);
    if (predicate.atLeast !== undefined && restarts < predicate.atLeast) problems.push('revert restarts ' + restarts + ', wanted at least ' + predicate.atLeast);
    return problems.length ? { ok: false, detail: '#' + number + ': ' + problems.join('; ') } : { ok: true, detail: '#' + number + ': ' + restarts + ' revert restart(s)' };
  }
  const number = numberOf(predicate.runs, p.vars);
  const runs = p.ledger.runsOf(p.repository, number, predicate.label);
  const where = '#' + number + (predicate.label ? ' ' + predicate.label : ' (all issue routes)');
  const problems: string[] = [];
  if (predicate.exactly !== undefined && runs !== predicate.exactly) problems.push('runs ' + runs + ', wanted exactly ' + predicate.exactly);
  if (predicate.atLeast !== undefined && runs < predicate.atLeast) problems.push('runs ' + runs + ', wanted at least ' + predicate.atLeast);
  return problems.length ? { ok: false, detail: where + ': ' + problems.join('; ') } : { ok: true, detail: where + ': ' + runs + ' runs' };
}

/**
 * The issue whose runs a run-dependent predicate waits for, or null when it is not one: `runs` names it, a findPull of `ai/issue-<n>` is
 * the run of that issue, and a findPull of `ai/revert-<n>` is the run of the ticket that pull request came from (read from the forge).
 */
export async function runTicketOf(predicate: Predicate, p: Probe): Promise<number | null> {
  if ('runs' in predicate) return numberOf(predicate.runs, p.vars);
  if ('revertRestarts' in predicate) return numberOf(predicate.revertRestarts, p.vars);
  if (!('findPull' in predicate)) return null;
  const head = expand(predicate.findPull, p.vars);
  const issue = /^ai\/issue-(\d+)$/.exec(head);
  if (issue) return Number(issue[1]);
  const revert = /^ai\/revert-(\d+)$/.exec(head);
  if (!revert) return null;
  const pr = await p.forge.getPull(p.repository, Number(revert[1]));
  const origin = /^ai\/issue-(\d+)$/.exec(branchOf(pr));
  return origin ? Number(origin[1]) : null;
}
