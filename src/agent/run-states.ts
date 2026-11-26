// The states of a run and the limits the dispatcher and its collaborators share, with the helpers that read a conversation's usage.
import type { IdleCounts, TokenTotals, Json } from '../types.ts';

// `paused` counts: the run stopped (an OpenHands restart, or POST /pause). It is an interruption, so it is resumed (see resume), not a verdict on the ticket.
export const TERMINAL = new Set(['finished', 'error', 'stuck', 'deleted', 'paused', 'max_iterations']);
export const RETRY_BASE_MS = 60000;
export const MAX_ATTEMPTS = 3;
// Routes that count as a follow-up round of an issue (a review run does not).
export const ROUND_KINDS = new Set<string | undefined>(['pull_request', 'ci_failure', 'conflict']);
export const ERROR_RETRY_DELAY_MS = 60000;
// Errors of a gateway that has no model left to ask: treated like a quota that is used up.
export const UNAVAILABLE_CODES = new Set(['LLMServiceUnavailableError', 'BadGatewayError', 'LLMTimeoutError']);
// The last this many started runs decide what a repository has had so far (see pickNext).
export const RECENT_STARTS = 50;
// WAIT_FOR_SAME_FILES looks at no more open pull requests than this per check.
export const FILE_PULLS_LOOKED_AT = 20;
export const ACTIVE_STATUSES = new Set(['waiting', 'queued', 'running']);
// Stage A (RESUME_ATTEMPTS): the states a run is continued in, on its own conversation. A run that reached its iteration limit is not among
// them: nothing in the API raises that limit of a conversation, so the same run would end the same way (see resume).
export const RESUMABLE = new Set(['stuck', 'timeout']);
// A paused run (PAUSE_RESUMES) is continued with its own message: nothing went wrong with the ticket, the agent was interrupted.
export const PAUSE_MESSAGE = 'The run was interrupted (the agent server was restarted or the conversation was paused). Continue from where you stopped: check the state of the branch and of your last step, then finish the task and end with the finish tool.';
// A continued run is given this long before its state counts again: the state it stopped in may still be reported for a moment.
export const RESUME_SETTLE_MS = 60000;
// Stage B (FAILURE_ESCALATE): the states after which a round starts once more on the profile of its escalate_to route (see escalateFailure).
// `no_delivery` is not one of them: an issue run that ends empty twice is escalated by checkDelivery instead (once, when its route has escalate_to).
export const ESCALATABLE = new Set(['stuck', 'timeout', 'max_iterations']);
// The idle line is logged again after this long when nothing about the waiting work has changed (see reportIdle).
export const IDLE_LOG_EVERY_MS = 15 * 60000;
// After a stall alert no other one for this long, unless nothing waits any more (see checkStall).
export const STALL_REPEAT_MS = 6 * 3600000;
// The open dependencies of a ticket that has no waiting job in the ledger are read from the forge, at most once per ticket per this long (cached).
export const DEP_CACHE_MS = 10 * 60000;
// And at most this many such reads per pass: beyond that a ticket's edges are unknown for now (no edges, nothing is broken).
export const DEP_READS_PER_PASS = 40;

// The route kinds, as the token counter labels them (a known set, see metrics.known).
export const ROUTE_KINDS = ['issue', 'pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict', 'sensitive_review', 'main_red'];
export const TOKEN_TYPES = ['prompt', 'completion', 'cache_read', 'reasoning'] as const;

// Tokens of a conversation (stats.usage_to_metrics: one entry per usage id, each with its LLM calls in token_usages), summed. Null when the
// conversation carries no usage at all.
export function tokenUsage(data: Json): TokenTotals | null {
  const usage = data?.stats?.usage_to_metrics ?? data?.metrics?.usage_to_metrics;
  if (!usage || typeof usage !== 'object') return null;
  const totals: TokenTotals = { prompt: 0, completion: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
  for (const entry of Object.values(usage) as Json[]) {
    for (const call of Array.isArray(entry?.token_usages) ? entry.token_usages as Json[] : []) {
      totals.prompt += Number(call?.prompt_tokens) || 0;
      totals.completion += Number(call?.completion_tokens) || 0;
      totals.cache_read += Number(call?.cache_read_tokens) || 0;
      totals.cache_write += Number(call?.cache_write_tokens) || 0;
      totals.reasoning += Number(call?.reasoning_tokens) || 0;
    }
  }
  return totals;
}

// Accumulated LLM cost (USD) of a conversation, summed over all of its LLMs.
export function conversationCost(data: Json): number | null {
  // OpenHands reports it under `stats`; `metrics` is null in the conversation response.
  const usage = data?.stats?.usage_to_metrics ?? data?.metrics?.usage_to_metrics;
  if (!usage || typeof usage !== 'object') return null;
  return (Object.values(usage) as Json[]).reduce((sum: number, entry) => sum + (Number(entry?.accumulated_cost) || 0), 0);
}

// The idle line: how many waiting jobs wait for what (see Dispatcher.reportIdle). `could_start` is only named when it is not 0.
export function idleLine(reasons: IdleCounts, tiers: string[]): string {
  const total = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  return 'idle: ' + total + ' waiting: ' + reasons.dependencies + ' on dependencies, ' + reasons.files + ' on files of older tickets, '
    + reasons.quota + ' held (quota ' + (tiers.join('/') || 'none') + '), ' + reasons.disk + ' held (low disk), '
    + reasons.hourly + ' over the hourly limit, ' + reasons.concurrency + ' over a concurrency limit'
    + (reasons.could_start ? ', ' + reasons.could_start + ' could start but did not' : '')
    + (reasons.cycle ? ', ' + reasons.cycle + ' in a dependency cycle' : '')
    + (reasons.stuck ? ', ' + reasons.stuck + ' behind a blocked pull request' : '');
}

// The note a revert's comment carries when the failed run could not turn green on a rerun (RERUN_TIMEOUT_MINUTES).
export const RERUN_NOTE: Record<'red' | 'timeout' | 'unavailable', string> = {
  red: 'A rerun of the failed run did not turn it green.',
  timeout: 'A rerun of the failed run did not finish within RERUN_TIMEOUT_MINUTES.',
  unavailable: 'No rerun of the failed run could be started.'
};
// Action run states that are not finished yet: a rerun is waited for while its run is in one of them.
export const RUN_UNFINISHED = new Set(['running', 'waiting', 'queued', 'pending', 'blocked']);

// The verdict of preExistingFailure (REVERT_ON_RED): regression, a check that was green before the merge and is red after it; pre_existing, a red
// check that was not green before it; unknown, the commit before the merge could not be read; recovered, the commit is green on the second read.
export type PreExisting = { verdict: 'regression' | 'pre_existing' | 'unknown' | 'recovered'; parent?: string; checks: string[] };
