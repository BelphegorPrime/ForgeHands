import { forgejoCall } from './client.ts';
import type { DirectConfig, Fetch, ForgeEvent, Json, Logger } from '../types.ts';

const WIP = /^\s*(?:\[WIP\]|WIP:)\s*/i;
const PAGE = 50;
const MAX_FILES = 1000;

// Merges the pull request of an agent issue once the reviewer approved it, CI is green and it touches no protected path.
// What may merge is the operator's decision (MERGE_POLICY, per repository), never the repository's or the agent's.
export class Merger {
  config: DirectConfig;
  send: Fetch;
  logger: Logger;
  later: (run: () => void, ms: number) => void;

  constructor(config: DirectConfig, send: Fetch = fetch, logger: Logger = console,
    later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms).unref(); }) {
    this.config = config;
    this.send = send;
    this.logger = logger;
    this.later = later;
  }

  call(repository: string, method: string, path: string, body?: unknown): Promise<Json> {
    return forgejoCall(this.config, this.send, repository, method, path, body);
  }

  async changedFiles(repository: string, number: number): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; names.length < MAX_FILES; page++) {
      const files = await this.call(repository, 'GET', '/pulls/' + number + '/files?limit=' + PAGE + '&page=' + page);
      if (!Array.isArray(files) || !files.length) break;
      for (const file of files) names.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if (files.length < PAGE) break;
    }
    return names.filter((name) => typeof name === 'string');
  }

  // `human`: the comment hands the pull request to a human, so it mentions him (and is the only kind that does).
  async remark(repository: string, number: number, text: string, human = false): Promise<void> {
    const mention = human && this.config.humanLogin ? '@' + this.config.humanLogin + ' ' : '';
    try { await this.call(repository, 'POST', '/issues/' + number + '/comments', { body: mention + 'ForgeHands: ' + text }); }
    catch (error) { this.logger.error('could not comment on #' + number + ':', error.message); }
  }

  // Returns the outcome as a status string; nothing here throws.
  async handle(event: ForgeEvent, regraced = false): Promise<string> {
    const repository = event.repository.full_name;
    const policy = this.config.mergePolicy.get(repository.toLowerCase());
    if (!policy || !this.config.forgejo) return 'no_merge_policy';
    const number = event.pull_request!.number;
    try {
      const pr = await this.call(repository, 'GET', '/pulls/' + number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      if (!/^ai\/issue-\d+$/.test(pr.head?.ref || '')) return 'not_an_agent_branch';
      const sha = pr.head.sha;
      const labels = (pr.labels || []).map((label: Json) => label.name);
      if (!labels.includes(this.config.approvedLabel)) return 'not_approved';
      if (labels.includes(this.config.blockedLabel)) return 'blocked';
      // The approval label is a claim; the review comment is the proof. Without a verdict for this very commit nothing is merged.
      const review = await this.reviewOf(repository, number, sha);
      // The reviewer sometimes sets the label a moment before it posts the verdict comment. A label that arrives first is looked at
      // once more after a short wait, instead of being taken off at once (the wait does not hold the webhook delivery).
      if (!review.ok && review.reason === 'none' && !regraced && this.config.approvalGraceMs > 0) {
        this.later(() => { this.handle(event, true).catch((error) => this.logger.error('late approval check failed:', error.message)); }, this.config.approvalGraceMs);
        return 'awaiting_review';
      }
      if (!review.ok) {
        await this.rejectApproval(repository, number, sha, review.reason);
        return 'no_valid_review';
      }
      const status = await this.call(repository, 'GET', '/commits/' + encodeURIComponent(sha) + '/status');
      if (status?.state !== 'success' || !(status.total_count > 0)) return 'ci_not_green';
      const protectedFiles = (await this.changedFiles(repository, number))
        .filter((name) => policy.deny.some((pattern) => pattern.test(name)));
      // Forgejo refuses to merge a pull request titled as work in progress (and reports it as not mergeable). Approved and green is
      // the end of the work in progress, for a human as much as for ForgeHands: the marker goes before either merges it. Only after
      // the title is clean does `mergeable` say anything about conflicts, so look at the pull request again.
      let current = pr;
      if (WIP.test(pr.title || '')) {
        await this.call(repository, 'PATCH', '/pulls/' + number, { title: pr.title.replace(WIP, '') });
        current = await this.call(repository, 'GET', '/pulls/' + number);
      }
      if (protectedFiles.length) {
        const security = await this.securityLine(repository, number, sha);
        await this.remark(repository, number, 'approved and green, but not merged automatically: it touches protected paths (' + [...new Set(protectedFiles)].slice(0, 10).join(', ') + '). It is ready for a human to merge.' + security, true);
        return 'protected_paths';
      }
      if (current?.mergeable === false) {
        await this.remark(repository, number, 'approved and green, but the pull request does not merge cleanly (conflict). A human has to look at it.', true);
        return 'not_mergeable';
      }
      await this.call(repository, 'POST', '/pulls/' + number + '/merge', {
        Do: this.config.mergeMethod, head_commit_id: sha, delete_branch_after_merge: true
      });
      const issue = Number(/^ai\/issue-(\d+)$/.exec(pr.head.ref)![1]);
      await this.remark(repository, number, 'merged: approved by the reviewer, CI green, no protected path touched.');
      try { await this.call(repository, 'PATCH', '/issues/' + issue, { state: 'closed' }); }
      catch (error) { this.logger.error('could not close issue #' + issue + ':', error.message); }
      return 'merged';
    } catch (error) {
      this.logger.error('auto-merge of ' + repository + '#' + number + ' failed:', error.message);
      await this.remark(repository, number, 'approved and green, but the merge failed (' + String(error.message).slice(0, 120) + '). A human has to look at this pull request.', true);
      return 'merge_failed';
    }
  }

  // The verdict word of the latest security review comment for this commit ("OK" or "CONCERNS"), or null. Advisory, written by the
  // sensitive reviewer: `## Security review: OK|CONCERNS` and the first eight characters of the commit.
  async securityReview(repository: string, number: number, sha: string): Promise<string | null> {
    const comments = await this.call(repository, 'GET', '/issues/' + number + '/comments?limit=100');
    const found = (Array.isArray(comments) ? comments : [])
      .map((comment: Json) => ({ at: Date.parse(comment.created_at), text: String(comment.body || '').slice(0, 600) }))
      .filter((entry) => /security review\s*:\s*(ok|concerns)\b/i.test(entry.text.slice(0, 200)) && entry.text.includes(sha.slice(0, 8)))
      .sort((a, b) => a.at - b.at)
      .at(-1);
    return found ? /concerns/i.test(found.text.slice(0, 200)) ? 'CONCERNS' : 'OK' : null;
  }

  // One sentence for the comment that hands a protected-path pull request to the human. Empty without a security review route.
  async securityLine(repository: string, number: number, sha: string): Promise<string> {
    if (![...this.config.routes.values()].some((route) => route.kind === 'sensitive_review')) return '';
    try {
      const verdict = await this.securityReview(repository, number, sha);
      if (verdict === 'CONCERNS') return ' The security review of this commit has CONCERNS: read its comment before you merge.';
      if (verdict === 'OK') return ' The security review of this commit found no concerns.';
      return ' There is no security review of this commit yet.';
    } catch (error) {
      this.logger.error('could not read the security review of #' + number + ':', error.message);
      return '';
    }
  }

  // The latest review comment of the current commit: written after the commit, long enough to hold evidence, and starting with
  // "Verdict: OK" or "Verdict: NOT OK". A comment of anybody counts (a human may review too); the latest one decides.
  async reviewOf(repository: string, number: number, sha: string): Promise<{ ok: boolean; reason?: string }> {
    let since = 0;
    try {
      const commit = await this.call(repository, 'GET', '/git/commits/' + encodeURIComponent(sha));
      const time = Date.parse(commit?.created || commit?.commit?.committer?.date || '');
      if (Number.isFinite(time)) since = time;
    } catch (error) {
      this.logger.error('could not read the time of commit ' + sha.slice(0, 8) + ', counting every review comment:', error.message);
    }
    const comments = await this.call(repository, 'GET', '/issues/' + number + '/comments?limit=100');
    const verdicts = (Array.isArray(comments) ? comments : [])
      .filter((comment: Json) => Date.parse(comment.created_at) >= since && String(comment.body || '').length >= this.config.minReviewChars)
      .map((comment: Json) => ({ at: Date.parse(comment.created_at), match: /verdict\s*:\s*(not\s+ok|ok)\b/i.exec(String(comment.body).slice(0, 300)) }))
      .filter((entry) => entry.match)
      .sort((a, b) => a.at - b.at);
    const last = verdicts.at(-1);
    if (!last) return { ok: false, reason: 'none' };
    return /^not/i.test(last.match![1]) ? { ok: false, reason: 'not_ok' } : { ok: true };
  }

  // An approval without a review behind it: take it off, say so, hand the pull request to a human. Best effort.
  async rejectApproval(repository: string, number: number, sha: string, reason?: string): Promise<void> {
    const event = { repository: { full_name: repository }, pull_request: { number } };
    await this.clearApproval(event);
    const what = reason === 'not_ok'
      ? 'the latest review of commit ' + sha.slice(0, 8) + ' says NOT OK'
      : 'there is no review comment for commit ' + sha.slice(0, 8) + ' that starts with \"Verdict: OK\" and holds evidence (at least ' + this.config.minReviewChars + ' characters)';
    await this.remark(repository, number, 'the label ' + this.config.approvedLabel + ' was set, but ' + what + '. The approval is not trusted and was taken off. A human has to look at this pull request, or push a commit to run the review again.', true);
    try {
      const known = await this.call(repository, 'GET', '/labels?limit=100');
      let label = (known || []).find((entry: Json) => entry.name === this.config.blockedLabel);
      if (!label) label = await this.call(repository, 'POST', '/labels', { name: this.config.blockedLabel, color: '#b60205' });
      await this.call(repository, 'POST', '/issues/' + number + '/labels', { labels: [label.id] });
    } catch (error) {
      this.logger.error('could not mark the pull request:', error.message);
    }
  }

  // A new round or review means the earlier approval no longer covers the branch. Best effort.
  async clearApproval(event: { repository: { full_name: string }; pull_request?: { number: number } }): Promise<void> {
    if (!this.config.forgejo) return;
    const repository = event.repository.full_name;
    const number = event.pull_request!.number;
    try {
      const labels = await this.call(repository, 'GET', '/issues/' + number + '/labels');
      const approved = (labels || []).find((label: Json) => label.name === this.config.approvedLabel);
      if (approved) await this.call(repository, 'DELETE', '/issues/' + number + '/labels/' + approved.id);
    } catch (error) {
      this.logger.error('could not clear the approval of #' + number + ':', error.message);
    }
  }
}
