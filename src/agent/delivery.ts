// What a run that ended left behind: a worker run must leave a pull request, a comment or a closed issue (else it runs once more, escalates or
// goes to the human), and a review run must leave a verdict.
import { pullBranch } from './bot.ts';
import { classifyHandback, handbackOf } from './handback.ts';
import { metrics } from '../metrics.ts';
import type { ForgeEvent, Job, Json } from '../types.ts';
import type { Dispatcher } from './dispatch.ts';

// What DeliveryCheck reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type DeliveryCheckHost = Pick<Dispatcher, 'config' | 'forge' | 'handback' | 'jobs' | 'logger' | 'markForHuman' | 'merger' | 'operatorDependencies' | 'reportFailure' | 'tierRunEnded' | 'waitForOperator'>;

export class DeliveryCheck {
  host: DeliveryCheckHost;

  constructor(host: DeliveryCheckHost) {
    this.host = host;
  }

  // A worker run on a ticket that ends as `finished` is not a delivery. A model that answers in words without a tool call can "finish" in a minute
  // with nothing done, and the ticket then waits for ever (several tickets did). A run on an issue (not a plan or an epic) must leave a pull request
  // from the branch ai/issue-<n> that was created or changed since the run started, or a comment on the issue written since then, or close the issue.
  // Otherwise the run is made once more; after the second empty run a human is called. Best effort: when the forge cannot be read nothing happens.
  async checkDelivery(job: Job): Promise<void> {
    const event = job.event;
    if (!this.host.config.forgejo || !event || event.pull_request || event.type === 'epic.done' || !job.started) return;
    if (this.host.config.epicLabels.has(job.label) || (event.issue.labels || []).some((name) => this.host.config.epicLabels.has(name))) return;
    try {
      const since = job.started - 60000;
      const repository = event.repository.full_name;
      const issue = await this.host.forge.getIssue(repository, event.issue.number);
      // A ticket that is closed (by the run, or by a person) is delivered: a comment on its parent is then the report, see parentComment below.
      if (!issue || issue.state !== 'open') return;
      const branch = 'ai/issue-' + event.issue.number;
      const pulls = await this.host.forge.listPulls(repository, { state: 'all', limit: 50, sort: 'recentupdate' });
      if (pulls.some((pr) => pullBranch(pr) === branch && Date.parse(pr.updated_at) >= since)) return;
      // A need only the operator can meet, with an operator ticket this ticket depends on: the ticket waits, and that is no failed delivery.
      const prerequisites = await this.host.operatorDependencies(repository, event.issue.number);
      if (prerequisites.length) { await this.host.waitForOperator(job, prerequisites); return; }
      const comments = await this.host.forge.listComments(repository, event.issue.number, 50);
      // A comment since the run began is a delivery, unless it hands the ticket back: "done, but nothing pushed" or a blocker (see handback.ts).
      const written = comments.filter((comment) => Date.parse(comment.created_at) >= since);
      const handback = written.length ? handbackOf(written) : null;
      if (written.length && !handback) return;
      if (this.superseded(job)) return;
      if (handback) {
        await this.host.handback.handle(job, handback.kind, handback.text);
        return;
      }
      // A comment on the parent (the issue this one blocks) is no delivery while this ticket is open: the ticket has no pull request and is not
      // closed. It is a hand-back like a comment on the ticket itself: a blocker is escalated, anything else is asked for the push first.
      const parent = await this.parentComment(event, since);
      if (this.superseded(job)) return;
      if (parent) {
        this.host.logger.error(repository + '#' + event.issue.number + ': the run commented on #' + parent.number + ' and left the ticket open, a hand-back');
        await this.host.handback.handle(job, classifyHandback(parent.text) === 'blocker' ? 'blocker' : 'pushed_nothing', parent.text);
        return;
      }
      if (!job.delivery_retry) {
        Object.assign(job, { status: 'queued', delivery_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.host.logger.error(job.key + ' finished without a pull request or a comment, running it once more');
        return;
      }
      if (this.escalateDelivery(job)) return;
      Object.assign(job, { status: 'failed', result: 'no_delivery' });
      this.host.tierRunEnded(job, 'no_delivery');
      await this.host.reportFailure(job, 'no_delivery');
    } catch (error) {
      this.host.logger.error('could not check what ' + job.key + ' delivered:', error.message);
    }
  }

  // A label set while the ended run was being looked at (the forge reads above take a while) has queued a fresh run of the same ticket. That run
  // takes over: running the old one once more, escalating it or calling a human would put two agents on one branch.
  superseded(job: Job): boolean {
    const other = this.host.jobs.activeByKey(job.key);
    if (!other || other === job) return false;
    this.host.logger.error(job.key + ': a fresh run was queued while the last one was looked at, it takes over');
    return true;
  }

  // The second empty run of an issue whose route has escalate_to starts once more on the profile of that route (FAILURE_ESCALATE), on the same
  // ticket: a fresh run, `escalated` and `escalated_after` no_delivery. It is counted as the escalation and the target's tier like any escalated
  // run. The escalated run keeps delivery_retry, so when it also ends empty the human is called at once (no third run). Returns true when queued.
  escalateDelivery(job: Job): boolean {
    // The route the ticket was started with (job.label): a run on the fallback route (job.fell_back) escalates like any other.
    const route = this.host.config.routes.get(job.label);
    if (!this.host.config.failureEscalate || !route?.escalateTo || job.escalated) return false;
    Object.assign(job, { status: 'queued', escalated: true, failure_escalation: true, escalated_after: 'no_delivery', started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
    metrics.inc('forgehands_failure_escalations_total');
    this.host.logger.error(job.key + ': no delivery twice, starting once more on ' + route.escalateTo);
    return true;
  }

  // The newest comment of the agent since the run began on a parent (an issue this one blocks), with the parent's number, or null. A read that fails
  // counts as no comment: an unknown answer never reads as delivered.
  async parentComment(event: ForgeEvent, since: number): Promise<{ number: number; text: string } | null> {
    let login: string | null;
    let parents: Json;
    try {
      login = (await this.host.forge.agentLogin?.()) ?? null;
      if (!login) return null;
      parents = await this.host.forge.blocks(event.repository.full_name, event.issue.number);
    } catch (error) {
      this.host.logger.error('could not read what #' + event.issue.number + ' blocks:', error.message);
      return null;
    }
    for (const parent of Array.isArray(parents) ? parents : []) {
      try {
        const comments = await this.host.forge.listComments(event.repository.full_name, parent.number, 50);
        const own = comments.filter((comment) => String(comment.user?.login || '').toLowerCase() === login && Date.parse(comment.created_at) >= since);
        if (own.length) return { number: parent.number, text: String(own.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0].body ?? '') };
      } catch (error) {
        this.host.logger.error('could not read the comments of #' + parent.number + ':', error.message);
      }
    }
    return null;
  }

  // A review run that ended without a verdict (neither the approval nor the changes label) would leave the pull request standing
  // for ever, green and unseen. Unless it moved on meanwhile, run it once more; after the second miss hand it to a human.
  async checkVerdict(job: Job): Promise<void> {
    const event = job.event;
    if (!this.host.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.host.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || (pr.head?.sha && pr.head.sha !== event.ci.commit_sha)) return;
      const names = (pr.labels || []).map((label: Json) => label.name);
      // No worker fixes a bot's pull request (BOT_FIX_ROUNDS is 0): a review that asks for changes hands it to a human, as the reviewer should have.
      if (event.bot && !this.host.config.botFixRounds && names.includes(this.host.config.changesLabel) && ![this.host.config.approvedLabel, this.host.config.blockedLabel].some((name) => names.includes(name))) {
        await this.host.markForHuman(event, 'ForgeHands: the review of commit ' + event.ci.commit_sha.slice(0, 8) + ' asks for changes to this dependency update, and no worker fixes bot pull requests. A human has to look at it.', 'bot_pull_request');
        return;
      }
      if ([this.host.config.approvedLabel, this.host.config.changesLabel, this.host.config.blockedLabel].some((name) => names.includes(name)) && this.host.config.verdictSource !== 'review') return;
      // Native reviews: any approval or request for changes on the head commit is a verdict (the webhook of the review does the rest).
      if (this.host.config.verdictSource !== 'comment' && (await this.host.merger.nativeReviews(event.repository.full_name, event.pull_request.number, event.ci.commit_sha)).any) return;
      if (this.host.config.verdictSource === 'review' && names.includes(this.host.config.blockedLabel)) return;
      // The first time, review once more: such a run mostly ends early (a blind command, a spent iteration budget), not for good.
      if (!job.verdict_retry) {
        Object.assign(job, { status: 'queued', verdict_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.host.logger.error('review ' + job.key + ' ended without a verdict, running it once more');
        return;
      }
      await this.host.markForHuman(event, 'ForgeHands: the review of commit ' + event.ci.commit_sha.slice(0, 8) + ' ended twice without a verdict (' + (this.host.config.verdictSource === 'review' ? 'no approving or rejecting review' : 'no ' + this.host.config.approvedLabel + ' and no ' + this.host.config.changesLabel) + '). A human has to look at this pull request, or push a commit to start the review again.', 'no_verdict');
    } catch (error) {
      this.host.logger.error('could not check the verdict of #' + event.pull_request.number + ':', error.message);
    }
  }
}
