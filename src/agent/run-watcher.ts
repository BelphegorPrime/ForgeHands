// A run that is going: its conversation is polled, and when it ends it is continued (stuck, timeout, paused), escalated, retried after an
// error or a quota, or reported, and the follow-up checks of what it left behind start.
import { mentionOf } from '../notify/index.ts';
import { known, metrics } from '../metrics.ts';
import type { TokenTotals, Job, Json } from '../types.ts';
import { TERMINAL, ROUND_KINDS, ERROR_RETRY_DELAY_MS, UNAVAILABLE_CODES, RESUMABLE, PAUSE_MESSAGE, RESUME_SETTLE_MS, ESCALATABLE, ROUTE_KINDS, TOKEN_TYPES, tokenUsage, conversationCost } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What RunWatcher reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type RunWatcherHost = Pick<Dispatcher, 'api' | 'branchRefresher' | 'checkRoundsAfterRun' | 'config' | 'cooldowns' | 'deliveryCheck' | 'earliestStart' | 'epicGaps' | 'forge' | 'issueKey' | 'jobs' | 'logger' | 'markForHuman' | 'noteTicket' | 'now' | 'nudger' | 'route' | 'securityReview' | 'sendMessage' | 'tell' | 'tierOf' | 'waitKeeper'>;

export class RunWatcher {
  host: RunWatcherHost;

  constructor(host: RunWatcherHost) {
    this.host = host;
  }

  // How long (ms) until the quota is back, when the run ended with a rate limit error; null for any other failure.
  // The error a run ended with, from its last events: whether the model was out of quota (and, when the gateway says, for how long), or
  // whether the agent reached its iteration limit. Null when there is no error event or it cannot be read.
  async lastError(job: Job): Promise<{ code: string; rateLimited: boolean; unavailable?: boolean; waitMs: number | null } | null> {
    try {
      const response = await this.host.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/search?limit=10&sort_order=TIMESTAMP_DESC');
      if (!response.ok) return null;
      const items = ((await response.json()) as Json)?.items || [];
      const errors = items.filter((item: Json) => item?.kind === 'ConversationErrorEvent');
      const limit = errors.find((item: Json) => item.code === 'LLMRateLimitError' || item.classification?.kind === 'rate_limit');
      if (limit) {
        const detail = String(limit.detail || '');
        let seconds = Number(/"retry_after"\s*:\s*(\d+)/.exec(detail)?.[1]);
        // Some gateways (OmniRoute for opencode, combo errors) say it only in words: "reset after 2h 58m 45s", "Resets in 13 days". A text
        // under a minute ("reset after 3s" next to "no credits remaining") is not a reset time; the default wait applies then.
        if (!(seconds > 0)) {
          const after = /reset(?:s)? after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(detail);
          const days = /resets? in\s+(\d+)\s*days?/i.exec(detail);
          const words = after ? (Number(after[1] || 0) * 3600 + Number(after[2] || 0) * 60 + Number(after[3] || 0)) : days ? Number(days[1]) * 86400 : 0;
          seconds = words >= 60 ? words : 0;
        }
        return { code: String(limit.code || 'LLMRateLimitError'), rateLimited: true, waitMs: seconds > 0 ? seconds * 1000 : null };
      }
      if (!errors.length) return null;
      // No model could answer (OmniRoute tried every model of the combination and reports the last failure: 503, bad gateway, timeout): the
      // same as an exhausted quota for the tier. Wait and try again, and give up only when it has gone on for QUOTA_GIVE_UP_HOURS.
      const unavailable = errors.find((item: Json) => UNAVAILABLE_CODES.has(String(item.code || '')));
      if (unavailable) return { code: String(unavailable.code), rateLimited: true, unavailable: true, waitMs: null };
      return { code: String(errors[0].code || ''), rateLimited: false, waitMs: null };
    } catch (error) {
      this.host.logger.error('could not read the error of ' + job.key + ':', error.message);
      return null;
    }
  }

  // A run ended for good (not queued again): count it by kind and end state and time it.
  runEnded(job: Job, state: string, now: number): void {
    const kind = this.host.config.routes.get(job.label)?.kind || 'issue';
    metrics.inc('forgehands_runs_finished_total', { kind, state: known(state, ['finished', 'error', 'stuck', 'deleted', 'paused', 'timeout']) });
    if (job.started) metrics.observe({ kind }, Math.max(0, now - job.started) / 1000);
    this.tierRunEnded(job, state);
  }

  // The same end, counted per repository and the tier the run really ran on (fallback and escalation included).
  tierRunEnded(job: Job, state: string): void {
    const tiers = new Set([...this.host.config.routes.values()].map((route) => route.tier));
    metrics.inc('forgehands_tier_runs_total', {
      repository: known(String(job.event?.repository?.full_name).toLowerCase(), this.host.config.allowedRepos), tier: known(this.host.tierOf(job), tiers),
      result: known(state, ['finished', 'max_iterations', 'error', 'stuck', 'timeout', 'no_delivery'])
    });
  }

  async poll(job: Job, now: number): Promise<boolean> {
    // A continued run whose run call was not answered yet: the message is in its conversation already, so only the run call is repeated.
    // Past the run timeout the continuation is given up and the run counts as timed out, without a second message.
    if (job.resume_pending) {
      if (job.resumed_at! + this.host.config.maxRunMs >= now) {
        await this.startResumed(job);
        return true;
      }
      delete job.resume_pending;
      // A continuation of a pause that never got its run call ends as paused: it is handed over, never split.
      return this.failed(job, job.resumed_from === 'paused' ? 'paused' : 'timeout', now);
    }
    let state: string | null = null;
    let costChanged = false;
    let usage: TokenTotals | null = null; // the tokens of the conversation as this read sees them (null: the read failed)
    try {
      const response = await this.host.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!));
      if (response.status === 404) state = 'deleted';
      else if (response.ok) {
        const data = (await response.json()) as Json;
        state = data.execution_status || data.status;
        const cost = conversationCost(data);
        if (cost !== null && cost !== job.cost) { job.cost = cost; costChanged = true; }
        usage = tokenUsage(data);
      }
    } catch (error) {
      this.host.logger.error('polling ' + job.key + ' failed:', error.message);
    }
    if (state === 'error') {
      const error = await this.lastError(job);
      // The model ran out of quota (the gateway answers with a rate limit, mostly with the time until it resets): not the ticket's fault
      // and no reason to call a human. Hold the tier back until then (at most QUOTA_HOLD_MAX_HOURS, 15 minutes when the gateway gives no
      // time) and run this job again afterwards; give up only when the quota has been out for QUOTA_GIVE_UP_HOURS.
      if (error?.rateLimited) {
        const since = job.rate_limited_since || now;
        if (now - since < this.host.config.quotaGiveUpMs) {
          // No time from the gateway: a quota without a reset time waits 15 minutes; "no model available" starts short and doubles (1, 2, 4, 8,
          // 16, then 30 minutes), because such a window may be over in a minute or last hours.
          const fallback = error.unavailable ? Math.min(60000 * 2 ** Math.min(job.rate_limited || 0, 5), 30 * 60000) : 15 * 60000;
          const wait = Math.min(Math.max(error.waitMs ?? fallback, 60000), this.host.config.quotaHoldMaxMs);
          const until = now + wait;
          this.countTokens(job, usage);
          this.host.cooldowns.set(this.host.tierOf(job) ?? this.host.route(job.label).tier, until);
          this.host.logger.error('model quota used up for ' + job.key + ', trying again after ' + new Date(until).toISOString());
          // The job may start again as soon as one of the routes it can run on is free: its own (or escalated) route, or that route's fallback.
          const next = this.host.earliestStart(job, now);
          Object.assign(job, { status: 'queued', started: undefined, fell_back: undefined, conversation_id: undefined, next_try: next, rate_limited: (job.rate_limited || 0) + 1, rate_limited_since: since, retry_at: next });
          return true;
        }
      }
      // The agent reached its iteration limit: OpenHands reports that as an error, but running it again does the same. It is a ticket that
      // is too big (see reportFailure and SPLIT_LABEL), not an error that passes.
      if (error?.code === 'MaxIterationsReached') state = 'max_iterations';
    }
    // An error ends a run for reasons that often pass (a failing model call, a restart of OpenHands): start it once more, after a pause.
    if (state === 'error' && (job.error_retry || 0) < this.host.config.errorRetries) {
      this.countTokens(job, usage);
      if (await this.host.deliveryCheck.cloneHandback(job)) return true;
      this.host.logger.error(job.key + ' ended with an error, running it once more');
      metrics.inc('forgehands_error_retries_total');
      Object.assign(job, { status: 'queued', started: undefined, conversation_id: undefined, finished: undefined, result: undefined,
        error_retry: (job.error_retry || 0) + 1, next_try: now + ERROR_RETRY_DELAY_MS, retry_at: now + ERROR_RETRY_DELAY_MS });
      return true;
    }
    if (state !== null && TERMINAL.has(state)) {
      // A run continued a moment ago may still be reported in the state it stopped in: that is not news yet.
      if (job.resumed_from === state && now - job.resumed_at! < RESUME_SETTLE_MS) return false;
      this.countTokens(job, usage);
      // A pause the operator wants is not resumed: the ticket is closed or its trigger label is gone (see pauseStop). Such a run ends as it is
      // (no split, no hand-over, no new branch update), and the operator's stop is the one thing ForgeHands does not fight.
      let stopped: string | null = null;
      if (state === 'paused' && (job.pause_resumes || 0) < this.host.config.pauseResumes) {
        try { stopped = await this.pauseStop(job); }
        catch (error) { this.host.logger.error('could not read ' + job.key + ' to see whether it was stopped, trying again:', error.message); return false; }
      }
      if (stopped) {
        Object.assign(job, { status: 'failed', result: state, finished: now });
        this.host.logger.error(job.key + ': paused, ' + stopped + ': not resumed');
        this.runEnded(job, state, now);
        await this.host.waitKeeper.releaseFileWaits();
        return true;
      }
      if (await this.resume(job, state, now)) return true;
      Object.assign(job, { status: state === 'finished' ? 'done' : 'failed', result: state, finished: now });
      this.runEnded(job, state, now);
      await this.host.branchRefresher.checkBranchAfterRun(job);
      await this.host.waitKeeper.releaseFileWaits();
      const done = this.host.config.routes.get(job.label)?.kind;
      // A run that ended because the checkout could not be cloned reports it in a comment: the job waits for a later attempt instead of being
      // escalated or reported (see clone-handback.ts). A confirmed report beats both the escalation and the failure notice.
      if ((done === 'pull_request' || state !== 'finished') && await this.host.deliveryCheck.cloneHandback(job)) return true;
      if (done === 'ci_success') await this.host.deliveryCheck.checkVerdict(job);
      else if (done === 'sensitive_review') { if (state === 'finished') await this.host.securityReview.checkSecurityReview(job); else await this.host.securityReview.handOverAfterSecurity(job); }
      else if (state !== 'finished') { if (!(await this.escalateFailure(job, state))) await this.reportFailure(job, state); }
      else if (done === 'issue') await this.host.deliveryCheck.checkDelivery(job);
      else if (done === 'pull_request') await this.host.checkRoundsAfterRun(job);
      else if (done === 'epic_done') await this.host.epicGaps.review(job);
      // A replan run of an epic (EPIC_GAP_REPLAN) that ended: its sub-issues decide whether the epic waits, is reviewed once more, or goes to a human.
      await this.host.epicGaps.afterReplan(job, now);
      return true;
    }
    // A running worker that has used much of its iteration limit without a branch is nudged (NUDGE_AT_PERCENT).
    if (state === 'running' && await this.host.nudger.nudgeIfNoBranch(job, now)) return true;
    if (costChanged) return true;
    // Free the slot of a run that never ends; the conversation itself is left alone unless the run is continued (see resume).
    // A continued run counts its timeout from the continuation.
    if (job.started && (job.resumed_at ?? job.started) + this.host.config.maxRunMs < now) {
      this.countTokens(job, usage);
      if (await this.resume(job, 'timeout', now)) return true;
      return this.failed(job, 'timeout', now);
    }
    return false;
  }

  // Why a paused run stays stopped, or null when it may be resumed. The operator stops a run by removing its trigger label (or closing the ticket):
  // the label of an issue route is on the issue, that of a round route on the pull request; routes that start on a CI result, a conflict or a
  // closed epic have no label to look at, so only a closed ticket stops them. One read of the forge. Without forge access nothing can be
  // read, so the run is resumed as it always was.
  async pauseStop(job: Job): Promise<string | null> {
    if (!this.host.config.forgejo) return null;
    const event = job.event;
    const repository = event.repository.full_name;
    const kind = this.host.config.routes.get(job.label)?.kind;
    const labelled = kind === 'issue' || kind === 'pull_request';
    if (event.pull_request) {
      const pull = await this.host.forge.getPull(repository, event.pull_request.number);
      if (pull.state === 'closed' || pull.merged) return 'the pull request is closed';
      return !labelled || (pull.labels || []).some((label) => label.name === job.label) ? null : 'the trigger label is gone';
    }
    const issue = await this.host.forge.getIssue(repository, event.issue.number);
    if (issue.state === 'closed') return 'the issue is closed';
    return !labelled || (issue.labels || []).some((label) => label.name === job.label) ? null : 'the trigger label is gone';
  }

  // Stage A (RESUME_ATTEMPTS): a run that ended stuck or timed out goes on in its own conversation, which keeps its context. One message says
  // what happened and asks for another approach, then the run is started again; the job is running again and counts the resume. A paused run
  // (an interruption, PAUSE_RESUMES) goes on the same way with a neutral message and a budget of its own. Once the budget of the state is used
  // up, or the run is not one of RESUMABLE (an iteration limit: nothing in the API raises it, so a continued run would stop at the same limit),
  // this returns false and the next stage decides. A message that could not be sent counts as not continued.
  async resume(job: Job, state: string, now: number): Promise<boolean> {
    const paused = state === 'paused';
    const used = paused ? job.pause_resumes || 0 : job.resumes || 0;
    const budget = paused ? this.host.config.pauseResumes : this.host.config.resumeAttempts;
    if (!(paused || RESUMABLE.has(state)) || !job.conversation_id || used >= budget) return false;
    const repository = job.event.repository.full_name;
    const conversation = '/api/conversations/' + encodeURIComponent(job.conversation_id);
    // A timed out run is still running in OpenHands: it is paused first, so that the message does not go to a busy agent (best effort).
    if (state === 'timeout') {
      try { await this.host.api('POST', conversation + '/pause', undefined, repository); }
      catch (error) { this.host.logger.error('could not pause ' + job.key + ' before it is continued:', error.message); }
    }
    // The message and the run are two calls: a run call that is not answered is repeated on its own (startResumed), never the message.
    const text = paused ? PAUSE_MESSAGE : 'The run stopped as ' + state + '. Do not repeat what you did last. Look at the current state of the branch and of the checks, take a different approach, and end with the finish tool and a short summary.';
    try {
      await this.host.sendMessage(job, text);
    } catch (error) {
      this.host.logger.error(job.key + ': ' + state + ', the message to continue it was not sent (' + error.message + '), the next stage decides');
      return false;
    }
    const counted = paused ? { pause_resumes: used + 1 } : { resumes: used + 1 };
    Object.assign(job, { status: 'running', ...counted, resumed_from: state, resumed_at: now, resume_pending: true, finished: undefined, result: undefined });
    metrics.inc('forgehands_resumes_total', { kind: this.host.config.routes.get(job.label)?.kind || 'issue', state: known(state, [...RESUMABLE, 'paused']) });
    this.host.logger.error(job.key + ': ' + state + ', resuming the conversation (' + (used + 1) + '/' + budget + ')');
    await this.startResumed(job);
    return true;
  }

  // The tokens of a conversation are added to the job's totals and to the counter forgehands_tokens_total when its run ends: at a terminal state,
  // when the conversation is dropped for a retry or a quota hold, or when a run times out. `tokens_seen` is what of the current conversation is
  // counted already, so a continued run adds only what came after. A read that failed (no usage) adds nothing.
  countTokens(job: Job, usage: TokenTotals | null): void {
    if (!usage) return;
    const seen = job.tokens_seen;
    const totals = { prompt: 0, completion: 0, cache_read: 0, cache_write: 0, reasoning: 0, ...job.tokens };
    const delta = { prompt: 0, completion: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
    for (const field of Object.keys(delta) as (keyof TokenTotals)[]) {
      delta[field] = Math.max(0, usage[field] - (seen?.[field] ?? 0));
      totals[field] += delta[field];
    }
    job.tokens = totals;
    job.tokens_seen = usage;
    const tiers = new Set([...this.host.config.routes.values()].map((route) => route.tier));
    const labels = {
      repository: known(String(job.event?.repository?.full_name).toLowerCase(), this.host.config.allowedRepos), tier: known(this.host.tierOf(job), tiers),
      kind: known(this.host.config.routes.get(job.label)?.kind || 'issue', ROUTE_KINDS)
    };
    for (const type of TOKEN_TYPES) if (delta[type] > 0) metrics.inc('forgehands_tokens_total', { ...labels, type }, delta[type]);
  }

  // The run call of a continued conversation. 200 starts it, 409 says it runs already: both clear the pending call. 404 means the conversation is
  // gone (the next poll says so). Any other answer, or no answer, keeps the call pending for the next poll.
  async startResumed(job: Job): Promise<void> {
    try {
      const response = await this.host.api('POST', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/run', undefined, job.event.repository.full_name);
      if (response.ok || response.status === 409) {
        delete job.resume_pending;
        job.resumed_at = this.host.now();
      } else if (response.status === 404) {
        delete job.resume_pending;
      } else {
        this.host.logger.error(job.key + ': the continued run was not started (HTTP ' + response.status + '), trying again');
      }
    } catch (error) {
      this.host.logger.error(job.key + ': the continued run was not started (' + error.message + '), trying again');
    }
  }

  // Stage B (FAILURE_ESCALATE): a round that is still stuck, timed out or out of iterations (after stage A, or at once for the iteration limit) starts
  // once more on the profile of its escalate_to route, on the same pull request and branch, with the own route's prompt and limits. It is one
  // extra try per head commit: a second failure on the same commit goes to the human, and it does not use up a MAX_ROUNDS round. The run is
  // queued like any run (the escalation is the same as the last-round escalation: the job is `escalated`). Returns true when it was queued.
  async escalateFailure(job: Job, state: string): Promise<boolean> {
    const route = this.host.config.routes.get(job.label);
    if (!this.host.config.failureEscalate || !route?.escalateTo || !ROUND_KINDS.has(route.kind) || !job.event.pull_request || job.escalated
      || !ESCALATABLE.has(state) || !this.host.config.forgejo) return false;
    const repository = job.event.repository.full_name;
    const number = job.event.pull_request.number;
    let head: string;
    try {
      const pr = await this.host.forge.getPull(repository, number);
      if (!pr || pr.state !== 'open' || pr.merged || typeof pr.head?.sha !== 'string') return false;
      head = pr.head.sha;
    } catch (error) {
      this.host.logger.error('could not read the head of #' + number + ', no escalation of ' + job.key + ':', error.message);
      return false;
    }
    const key = this.host.issueKey(job.event) + ':' + job.label + ':' + head.slice(0, 8);
    if (this.host.jobs.list().some((other) => other.key === key)) return false;
    this.host.jobs.add({ key, label: job.label, event: { ...job.event, label: job.label }, status: 'queued', created: this.host.now(),
      escalated: true, failure_escalation: true, escalated_after: state });
    metrics.inc('forgehands_failure_escalations_total');
    this.host.logger.error(job.key + ': ' + state + ', starting once more on ' + route.escalateTo + ' (head ' + head.slice(0, 8) + ')');
    return true;
  }

  // A run that ran out of time (a continuation that never started counts the same): it is either escalated (stage B) or reported (stage C, as before).
  async failed(job: Job, state: string, now: number): Promise<boolean> {
    Object.assign(job, { status: 'failed', result: state, finished: now });
    this.runEnded(job, state, now);
    // A failed run that was actually a clone failure is queued again instead of escalated or reported (see clone-handback.ts).
    if (await this.host.deliveryCheck.cloneHandback(job)) return true;
    if (!(await this.escalateFailure(job, state))) await this.reportFailure(job, state);
    return true;
  }

  // What the human is told about an issue run that delivered nothing. It names the escalation when one happened (the same route's escalate_to, read
  // from job.label: a run on the fallback route of its tier is still escalated by that route), so the notice does not claim that nothing was tried.
  deliveryNotice(job: Job): string {
    const run = 'the run for ' + job.label;
    const target = this.host.config.routes.get(job.label)?.escalateTo;
    if (job.escalated && target && job.escalated_after === 'no_delivery') return run + ' finished twice without a pull request and without a comment, and once more after ' + target + ', so nothing was delivered';
    if (job.escalated && target && job.escalated_after === 'handback') return run + ' was handed back by a comment, and the run after it on ' + target + ' finished without a pull request and without a comment, so nothing was delivered';
    return run + ' finished twice without a pull request and without a comment, so nothing was delivered';
  }

  // A run that failed for good must not vanish into the ledger. A worker run on an issue that ran out of iterations or time (max_iterations,
  // stuck, timeout) means a ticket that is too big: with SPLIT_LABEL the planner is asked to split it. A paused run is an interruption and is
  // never split. Everything else is handed to the human, on the pull request (label and mention) or, without one, as a comment on the issue.
  // Best effort: a failing call is only logged.
  async reportFailure(job: Job, state: string): Promise<void> {
    const event = job.event;
    if (!this.host.config.forgejo || !event || state === 'deleted' || state === 'finished') return;
    const kind = this.host.config.routes.get(job.label)?.kind;
    const what = state === 'no_delivery'
      ? this.deliveryNotice(job)
      : 'the run for ' + job.label + (event.pull_request ? ' on pull request #' + event.pull_request.number : '') + ' ended with "' + state + '"';
    try {
      const exhausted = state === 'max_iterations' || state === 'stuck' || state === 'timeout';
      if (this.host.config.splitLabel && kind === 'issue' && !event.pull_request && exhausted && job.label !== this.host.config.splitLabel && !this.host.config.epicLabels.has(job.label)) {
        const number = event.issue.number;
        const repository = event.repository.full_name;
        const split = await this.host.forge.findOrCreateLabel(repository, this.host.config.splitLabel, '#5319e7');
        const present = await this.host.forge.labelsOf(repository, number, 'issue');
        const failed = (present || []).find((entry) => entry.name === job.label);
        await this.host.forge.addComment(repository, number, 'ForgeHands: ' + what + ', so the ticket is probably too big for one run. It goes to the planner (' + this.host.config.splitLabel + ') to be split into slices.', 'issue');
        if (failed) await this.host.forge.removeLabel(repository, number, failed, 'issue');
        await this.host.forge.addLabels(repository, number, [split], 'issue');
        this.host.noteTicket(this.host.issueKey(event), { split_at: this.host.now() });
        return;
      }
      const text = what + '. A human has to look at it.';
      if (event.pull_request) await this.host.markForHuman(event, 'ForgeHands: ' + text, 'failed_run', { why: state });
      else {
        this.host.tell('failed', event, { why: state });
        await this.host.forge.addComment(event.repository.full_name, event.issue.number, mentionOf(this.host.config) + 'ForgeHands: ' + text, 'issue');
      }
    } catch (error) {
      this.host.logger.error('could not report the failure of ' + job.key + ':', error.message);
    }
  }
}
