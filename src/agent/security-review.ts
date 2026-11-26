// The security review (a route of kind sensitive_review): a green commit that touches a protected path gets a second, read-only review.
import type { ForgeEvent, Job, Json } from '../types.ts';
import type { Dispatcher } from './dispatch.ts';

// What SecurityReview reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type SecurityReviewHost = Pick<Dispatcher, 'config' | 'forge' | 'issueKey' | 'jobs' | 'logger' | 'merger' | 'now'>;

export class SecurityReview {
  host: SecurityReviewHost;

  constructor(host: SecurityReviewHost) {
    this.host = host;
  }

  // A green commit of a pull request that changes a protected path (the deny list of the merge policy of its repository) also gets a
  // security review, once per commit, when a route of kind sensitive_review exists. It is advisory: no label, no round, no merge.
  async startSecurityReview(event: ForgeEvent): Promise<void> {
    const route = [...this.host.config.routes].find(([, entry]) => entry.kind === 'sensitive_review')?.[0];
    if (!route || !event.pull_request || !event.ci || !this.host.config.forgejo) return;
    const key = this.host.issueKey(event) + ':' + route + ':' + event.ci.commit_sha.slice(0, 8);
    if (this.host.jobs.list().some((job) => job.key === key)) return;
    const policy = this.host.config.mergePolicy.get(event.repository.full_name.toLowerCase());
    if (!policy) return;
    try {
      const files = await this.host.merger.changedFiles(event.repository.full_name, event.pull_request.number);
      const hit = [...new Set(files.filter((name) => policy.deny.some((pattern) => pattern.test(name))))];
      if (!hit.length) return;
      this.host.jobs.add({ key, label: route, event: { ...event, type: 'ci.sensitive', label: route, protected_files: hit.slice(0, 20) }, status: 'queued', created: this.host.now() });
      await this.host.jobs.persist(this.host.now());
    } catch (error) {
      this.host.logger.error('could not start the security review of ' + this.host.issueKey(event) + ':', error.message);
    }
  }

  // The security review is advisory: when its run ends without the comment, run it once more; after that it is only logged.
  async checkSecurityReview(job: Job): Promise<void> {
    const event = job.event;
    if (!this.host.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.host.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || (pr.head?.sha && pr.head.sha !== event.ci.commit_sha)) return;
      if (await this.host.merger.securityReview(event.repository.full_name, event.pull_request.number, event.ci.commit_sha)) { await this.handOverAfterSecurity(job); return; }
      if (!job.verdict_retry) {
        Object.assign(job, { status: 'queued', verdict_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.host.logger.error('security review ' + job.key + ' ended without a comment, running it once more');
        return;
      }
      this.host.logger.error('security review ' + job.key + ' ended twice without a comment');
      await this.handOverAfterSecurity(job);
    } catch (error) {
      this.host.logger.error('could not check the security review of #' + event.pull_request.number + ':', error.message);
    }
  }

  // The hand-over of an approved protected-path pull request waits for its security review (see Merger.handle); when that run has ended
  // (with its comment, without one, or failed) the approval is looked at again, which hands the pull request over with what was found.
  async handOverAfterSecurity(job: Job): Promise<void> {
    const event = job.event;
    if (!this.host.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.host.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || pr.head?.sha !== event.ci.commit_sha) return;
      const labelled = (pr.labels || []).some((label: Json) => label.name === this.host.config.approvedLabel);
      if (!labelled && !(this.host.config.verdictSource !== 'comment' && (await this.host.merger.reviewOf(event.repository.full_name, event.pull_request.number, pr.head.sha)).ok)) return;
      await this.host.merger.handle(event);
    } catch (error) {
      this.host.logger.error('could not hand #' + event.pull_request.number + ' over after its security review:', error.message);
    }
  }
}
