// A clone failure is reported back as a forge comment, and only a fresh, attributable one may count toward the clone breaker. This module
// decides that from the comment alone: it returns the normalized class, repository and conversation and never the comment text, so raw clone
// output or a credential URL cannot reach the ledger.
import { CLONE_BREAKER_WINDOW_MS } from './clone-breaker.ts';
import type { CloneFailureReport } from './clone-breaker.ts';
import type { CloneFailureClass } from '../types.ts';

/** How long a job with a confirmed clone failure waits before it is tried again. */
export const CLONE_RETRY_DELAY_MS = 10 * 60_000;
/** How many confirmed clone failures may send a job back to the queue before it counts as a blocker. */
export const CLONE_RETRY_LIMIT = 3;

/** The comment a report may arrive in. `body` is untrusted and is only matched, never kept. */
export interface CloneHandbackComment {
  login: string | null | undefined;
  created_at: string;
  body: unknown;
}

/** Everything the decision needs, passed in so the function stays pure. */
export interface CloneHandbackInput {
  comment: CloneHandbackComment;
  /** The login of the agent whose run could have written the comment; null when the run has no identity. */
  agentLogin: string | null;
  /** The time the run started (ms), from the injected clock. */
  runStarted: number;
  now: number;
  /** The repository full name of the ticket. */
  repository: string;
  /** The ticket number. */
  issue: number;
  /** The conversation the run belongs to. */
  conversation: string;
  scope: 'ticket' | 'pull_request' | 'parent';
  /** Other runs sharing this conversation's parent; a positive count makes an unattributed report ambiguous. */
  concurrentRuns?: number;
}

const MENTIONS_CLONE = /\bgit\s+clone\b|\bcloning\b|\bclone\b/;
const REPOSITORY_NOT_FOUND = /repository not found/;
const FATAL = /fatal:/;
const COULD_NOT_READ_FROM_REMOTE = /could not read from remote/;
const AUTHENTICATION_FAILED = /authentication failed/;
const COULD_NOT_READ_USERNAME = /could not read username/;
const COULD_NOT_RESOLVE_HOST = /could not resolve host/;
// A host glued in front of a full URL, e.g. `https://host/https://host` or `host/https://`.
const DOUBLED_HOST = /[^\s/:]+\/https?:\/\//;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

// A comment counts only when the agent itself wrote it, it arrived inside the run's window, and its text shows a real failed clone.
// The class is normalized here so the caller never has to parse clone output again; an unattributed comment on a parent is refused.
export function classifyCloneHandback(input: CloneHandbackInput): CloneFailureReport | null {
  const agentLogin = input.agentLogin;
  const login = input.comment?.login;
  if (!nonEmpty(agentLogin) || !nonEmpty(login)) return null;
  if (login.trim().toLowerCase() !== agentLogin.trim().toLowerCase()) return null;

  const now = input.now;
  const runStarted = input.runStarted;
  if (!Number.isFinite(now) || !Number.isFinite(runStarted)) return null;
  const t = Date.parse(input.comment?.created_at);
  if (!Number.isFinite(t)) return null;
  if (t < runStarted - 60_000 || t > now || now - t > CLONE_BREAKER_WINDOW_MS) return null;

  const body = String(input.comment?.body ?? '').toLowerCase();
  const symptom = REPOSITORY_NOT_FOUND.test(body) || FATAL.test(body) || COULD_NOT_READ_FROM_REMOTE.test(body)
    || AUTHENTICATION_FAILED.test(body) || COULD_NOT_RESOLVE_HOST.test(body) || DOUBLED_HOST.test(body);
  if (!MENTIONS_CLONE.test(body) || !symptom) return null;

  // A comment on a parent sits where several tickets can see it, so only the text can attribute it. Concurrency does not lift that rule.
  if (input.scope === 'parent') {
    const ticket = (input.repository + '#' + input.issue).toLowerCase();
    const conversation = input.conversation.toLowerCase();
    const attributed = body.includes(ticket) || (conversation !== '' && body.includes(conversation));
    if (!attributed) return null;
  }

  let failureClass: CloneFailureClass;
  if (DOUBLED_HOST.test(body) || COULD_NOT_RESOLVE_HOST.test(body)) failureClass = 'host_misconfigured';
  else if (REPOSITORY_NOT_FOUND.test(body)) failureClass = 'repository_not_found';
  else if (AUTHENTICATION_FAILED.test(body) || COULD_NOT_READ_USERNAME.test(body)) failureClass = 'auth_failed';
  else failureClass = 'clone_failed';

  return { class: failureClass, repository: input.repository, conversation: input.conversation };
}
