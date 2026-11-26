// The nudge (NUDGE_AT_PERCENT): a worker run that has used much of its iteration limit without a branch is told once to stop exploring and push.
import { randomUUID } from 'node:crypto';
import { metrics } from '../metrics.ts';
import type { Job, Json } from '../types.ts';
import type { Dispatcher } from './dispatch.ts';

// Nudge (NUDGE_AT_PERCENT): a run's actions are counted at most once a minute, and not before the run is three minutes old.
const NUDGE_CHECK_EVERY_MS = 60000;
const NUDGE_MIN_RUN_MS = 180000;
// A nudge is sent at most this many times without a trace of it in the events (the first send and one resend after a timeout).
const NUDGE_TRIES = 2;

// What Nudger reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type NudgerHost = Pick<Dispatcher, 'api' | 'branchExists' | 'config' | 'jobs' | 'logger' | 'now' | 'sendMessage'>;

export class Nudger {
  host: NudgerHost;
  nudgeChecks = new Map<string, number>(); // job id -> when the actions of its run were last counted (NUDGE_AT_PERCENT); in memory only
  // job id -> the nudge being delivered in the background (see startNudge): the poll path never waits for a nudge; in memory only.
  nudgeInflight = new Map<string, Promise<void>>();

  constructor(host: NudgerHost) {
    this.host = host;
  }

  // NUDGE_AT_PERCENT: a worker run on an issue that has used that share of its route's iteration limit, and whose forge shows no branch ai/issue-<n>,
  // is told once (per conversation) to stop exploring and push. Only a running conversation is looked at. Every read is best effort: when the count,
  // the forge or OpenHands fails, nothing is sent and the next look comes a minute later. Returns true when the job changed (to be persisted).
  async nudgeIfNoBranch(job: Job, now: number): Promise<boolean> {
    const route = this.host.config.routes.get(job.label);
    // Planner, epic and split routes are not workers: they plan, they do not push a branch of their own.
    const worker = !!route && route.kind === 'issue' && !job.event.pull_request && !job.event.bot && job.event.type !== 'epic.done'
      && !this.host.config.epicLabels.has(job.label) && job.label !== this.host.config.splitLabel;
    if (!this.host.config.nudgeAtPercent || !worker || !this.host.config.forgejo || !job.started || !job.conversation_id || job.nudged !== undefined || job.nudge_settled
      || job.nudge_gave_up || this.nudgeInflight.has(job.id)) return false;
    if (now - job.started < NUDGE_MIN_RUN_MS) return false;
    const last = this.nudgeChecks.get(job.id);
    if (last !== undefined && now - last < NUDGE_CHECK_EVERY_MS) return false;
    this.nudgeChecks.set(job.id, now);
    // A nudge that timed out earlier is resolved first (its marker is looked for), without counting again.
    if (job.nudge_pending) { this.startNudge(job, { used: job.nudge_pending.used, max: job.nudge_pending.max }); return false; }
    const repository = job.event.repository.full_name;
    const number = job.event.issue.number;
    let used: number;
    try {
      used = await this.actionCount(job);
    } catch (error) {
      this.host.logger.error(job.key + ': actions not counted, no nudge yet (' + error.message + ')');
      return false;
    }
    const max = route.maxIterations;
    if (used < Math.ceil(max * this.host.config.nudgeAtPercent / 100)) return false;
    let pushed: boolean;
    try {
      pushed = await this.host.branchExists(repository, 'ai/issue-' + number);
    } catch (error) {
      this.host.logger.error(job.key + ': the branch is not read, no nudge yet (' + error.message + ')');
      return false;
    }
    if (pushed) { job.nudge_settled = true; return true; }
    this.startNudge(job, { used, max });
    return false;
  }

  // The nudge is delivered in the background: a message to a running conversation answers only after the agent's current step, so the poll
  // path (and the dispatch loop with it) never waits for it. One delivery per job at a time (nudgeInflight); the ledger is written when it ends.
  startNudge(job: Job, plan: { used: number; max: number }): void {
    const flight = this.runNudge(job, plan)
      .catch((error) => this.host.logger.error(job.key + ': nudge failed: ' + error.message))
      .finally(() => {
        this.nudgeInflight.delete(job.id);
        this.host.jobs.persist(this.host.now()).catch((error) => this.host.logger.error('persist failed:', error.message));
      });
    this.nudgeInflight.set(job.id, flight);
  }

  // Delivers the nudge once, with a marker in its text. A timeout does not say whether OpenHands stored the message (it may be queued behind the
  // agent's step), so the events are read for the marker first; the message is sent again only when they do not hold it, and only NUDGE_TRIES
  // times in all. A refusal (HTTP status: 409, 423, 429, ...) is not a delivery: the next look counts and tries again.
  async runNudge(job: Job, plan: { used: number; max: number }): Promise<void> {
    const number = job.event.issue.number;
    const pending = job.nudge_pending ??= { marker: '[forgehands-nudge ' + randomUUID().slice(0, 8) + ']', tries: 0, used: plan.used, max: plan.max };
    for (;;) {
      if (pending.tries > 0) {
        let stored: boolean;
        try {
          stored = await this.nudgeInEvents(job, pending.marker);
        } catch (error) {
          this.host.logger.error(job.key + ': nudge pending, the events could not be read (' + error.message + '), checking again on the next look');
          return;
        }
        if (stored) {
          this.host.logger.error(job.key + ': nudge confirmed in the events');
          return this.nudgeDelivered(job, pending);
        }
        if (pending.tries >= NUDGE_TRIES) {
          job.nudge_gave_up = true;
          delete job.nudge_pending;
          this.host.logger.error(job.key + ': the nudge was not delivered after ' + pending.tries + ' tries, no more nudges for this run');
          return;
        }
      }
      pending.tries += 1;
      try {
        await this.host.sendMessage(job, this.nudgeText(pending.used, pending.max, number) + ' ' + pending.marker, this.host.config.nudgeTimeoutMs);
      } catch (error) {
        // An answer with an HTTP status is a refusal: nothing was stored, and the next look tries again.
        if (/^HTTP \d+$/.test(error.message)) {
          delete job.nudge_pending;
          this.host.logger.error(job.key + ': nudge refused (' + error.message + '), trying again on the next look');
          return;
        }
        this.host.logger.error(job.key + ': nudge pending (timeout), checking the events');
        continue;
      }
      return this.nudgeDelivered(job, pending);
    }
  }

  // The nudge is in the conversation: the job is nudged once, and the count is kept.
  nudgeDelivered(job: Job, pending: { used: number; max: number }): void {
    job.nudged = pending.used;
    delete job.nudge_pending;
    metrics.inc('forgehands_nudges_total', { kind: 'issue' });
    this.host.logger.error(job.key + ': nudged at ' + pending.used + '/' + pending.max + ' actions, no branch yet');
  }

  // Whether a user message with the marker is among the newest events of the conversation. Throws when the events cannot be read.
  async nudgeInEvents(job: Job, marker: string): Promise<boolean> {
    const response = await this.host.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/search?limit=30&sort_order=TIMESTAMP_DESC', undefined, job.event.repository.full_name);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const items = ((await response.json()) as Json)?.items || [];
    return items.some((item: Json) => item?.source !== 'agent' && JSON.stringify(item).includes(marker));
  }

  // The agent actions of a conversation so far: OpenHands' event count, restricted to ActionEvent. Throws when the count cannot be read.
  async actionCount(job: Job): Promise<number> {
    const response = await this.host.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/count?kind=ActionEvent', undefined, job.event.repository.full_name);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = (await response.json()) as Json;
    const count = typeof data === 'number' ? data : Number(data?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('the answer carries no count');
    return count;
  }

  // The nudge's text: the default, or NUDGE_MESSAGE with {used}, {max} and {branch} filled in.
  nudgeText(used: number, max: number, number: number): string {
    const branch = 'ai/issue-' + number;
    if (this.host.config.nudgeMessage) return this.host.config.nudgeMessage.replaceAll('{used}', String(used)).replaceAll('{max}', String(max)).replaceAll('{branch}', branch);
    return 'You have used ' + used + ' of ' + max + ' actions and have not pushed a branch yet. Stop exploring. Implement the smallest change that meets the acceptance check, '
      + 'commit and push it to the branch ' + branch + ' and open the draft pull request; or, if something blocks you, write a comment on the issue that names the exact blocker '
      + 'and finish. Do not start new investigations.';
  }
}
