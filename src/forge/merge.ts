import { createForge, createTransport } from './index.ts';
import { DryLog } from '../dry.ts';
import { isBotPull } from './bot.ts';
import { metrics } from '../metrics.ts';
import { NO_NOTIFY, mentionOf, pullUrl } from '../notify/index.ts';
import { immediateMessage } from '../notify/texts.ts';
import type { Facts } from '../notify/texts.ts';
import type { Notify } from '../notify/index.ts';
import type { DirectConfig, Fetch, ForgeEvent, Json, Logger } from '../types.ts';
import type { Forge } from './types.ts';

const PAGE = 50;
const MAX_FILES = 1000;

// Merges the pull request of an agent issue (or of a dependency bot, BOT_AUTHORS) once the reviewer approved it, CI is green and it touches no protected path.
// What may merge is the operator's decision (MERGE_POLICY, per repository), never the repository's or the agent's.
export class Merger {
  config: DirectConfig;
  send: Fetch;
  logger: Logger;
  later: (run: () => void, ms: number) => void;
  dry: DryLog;
  forge: Forge;
  // The wire: what every call of this merger passes through. A test replaces it; the paths stay the forge's.
  transport: ReturnType<typeof createTransport>;
  // Set by the dispatcher: is a security review of this commit still queued or running? Then the hand-over waits for it.
  securityPending: (repository: string, number: number, sha: string) => boolean = () => false;
  // Tells the ledger that ForgeHands merged a ticket or handed it to a human (ticket: "repo#issue" or "repo!pr<n>"); the dispatcher sets it, see Dispatcher.noteTicket.
  note: (ticket: string, fact: 'merged' | 'blocked') => void = () => {};
  // Tells the human by a message of ForgeHands' own (src/notify); the dispatcher sets it. Off by default.
  notifier: Notify = NO_NOTIFY;

  constructor(config: DirectConfig, send: Fetch = fetch, logger: Logger = console,
    later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms).unref(); }, dry: DryLog = new DryLog(logger)) {
    this.config = config;
    this.send = send;
    this.logger = logger;
    this.later = later;
    this.dry = dry;
    this.transport = createTransport(config, send, dry);
    this.forge = createForge(config, (repository, method, path, body) => this.call(repository, method, path, body));
  }

  call(repository: string, method: string, path: string, body?: unknown): Promise<Json> {
    return this.transport(repository, method, path, body);
  }

  async changedFiles(repository: string, number: number): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; names.length < MAX_FILES; page++) {
      const files = await this.forge.pullFiles(repository, number, PAGE, page);
      if (!Array.isArray(files) || !files.length) break;
      for (const file of files) names.push(file.filename, ...(file.previous_filename ? [file.previous_filename] : []));
      if (files.length < PAGE) break;
    }
    return names.filter((name) => typeof name === 'string');
  }

  // `human`: the comment hands the pull request to a human, so it mentions him (and is the only kind that does).
  async remark(repository: string, number: number, text: string, human = false): Promise<void> {
    const mention = human ? mentionOf(this.config) : '';
    try { await this.forge.addComment(repository, number, mention + 'ForgeHands: ' + text); }
    catch (error) { this.logger.error('could not comment on #' + number + ':', error.message); }
  }

  // The message for the human about this pull request (kind: handover, blocked, conflict, failed); nothing is built when the kind is not wanted.
  tell(kind: string, repository: string, number: number, facts: Partial<Facts>, htmlUrl?: unknown): void {
    if (!this.notifier.wants(kind)) return;
    this.notifier.notify(immediateMessage(this.config.notify.language, kind, { repository, number, link: pullUrl(this.config, repository, number, htmlUrl), ...facts }), repository);
  }

  // Returns the outcome as a status string; nothing here throws.
  async handle(event: ForgeEvent, regraced = false): Promise<string> {
    const repository = event.repository.full_name;
    const policy = this.config.mergePolicy.get(repository.toLowerCase());
    if (!policy || !this.config.forgejo) return 'no_merge_policy';
    const number = event.pull_request!.number;
    try {
      const pr = await this.forge.getPull(repository, number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      // Judged from the pull request as Forgejo has it now, not from the event: an agent branch, or a pull request of a listed bot.
      const bot = isBotPull({ authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos }, pr, repository);
      if (!bot && !/^ai\/issue-\d+$/.test(pr.head?.ref || '')) return 'not_an_agent_branch';
      const sha = pr.head.sha;
      const labels = (pr.labels || []).map((label: Json) => label.name);
      // The approval label (comment mode, or a human's) is a claim; native reviews need no label, they are the proof themselves.
      const labelled = labels.includes(this.config.approvedLabel);
      if (!labelled && this.config.verdictSource === 'comment') return 'not_approved';
      if (labels.includes(this.config.blockedLabel)) return metrics.refused('blocked');
      // The verdict for this very commit is the proof. Without one nothing is merged.
      const review = await this.reviewOf(repository, number, sha);
      // No label to take off: a review that does not (yet) say yes is simply not a reason to merge.
      if (!labelled && !review.ok) return review.reason === 'changes_requested' ? 'changes_requested' : review.reason === 'not_enough' ? 'awaiting_approvals' : 'not_approved';
      // The reviewer sometimes sets the label a moment before it posts the verdict comment. A label that arrives first is looked at
      // once more after a short wait, instead of being taken off at once (the wait does not hold the webhook delivery).
      if (!review.ok && review.reason === 'none' && !regraced && this.config.approvalGraceMs > 0) {
        this.later(() => { this.handle(event, true).catch((error) => this.logger.error('late approval check failed:', error.message)); }, this.config.approvalGraceMs);
        return 'awaiting_review';
      }
      if (!review.ok) {
        this.note(this.ticketOf(repository, number, bot ? null : pr.head.ref), 'blocked');
        await this.rejectApproval(repository, number, sha, review.reason, pr);
        return metrics.refused('no_valid_review');
      }
      const status = await this.forge.commitStatus(repository, sha);
      if (status?.state !== 'success' || !(status.total_count > 0)) return metrics.refused('ci_not_green');
      const changed = await this.changedFiles(repository, number);
      const protectedFiles = changed.filter((name) => policy.deny.some((pattern) => pattern.test(name)));
      // Forgejo refuses to merge a pull request titled as work in progress (and reports it as not mergeable). Approved and green is
      // the end of the work in progress, for a human as much as for ForgeHands: the marker goes before either merges it. Only after
      // the title is clean does `mergeable` say anything about conflicts, so look at the pull request again.
      let current = pr;
      if (this.forge.isWip(pr.title || '')) {
        await this.forge.setPullTitle(repository, number, this.forge.stripWip(pr.title));
        current = await this.forge.getPull(repository, number);
      }
      let twoKeys = false;
      if (protectedFiles.length) {
        // The human gets one comment with everything he needs: why a human, which paths, what the security review found. While a security
        // review of this commit is still under way the hand-over waits for it (the dispatcher hands over when that run ends).
        if (this.hasSecurityRoute() && this.securityPending(repository, number, sha) && !(await this.securityReview(repository, number, sha))) return 'awaiting_security_review';
        if (!(await this.twoKeysHold(repository, number, sha, policy, protectedFiles))) {
          await this.remark(repository, number, await this.handOverText(repository, number, sha, policy, protectedFiles, current?.mergeable === false), true);
          await this.tellHandOver(repository, number, sha, policy, protectedFiles, current);
          return metrics.refused('protected_paths');
        }
        twoKeys = true;
      }
      if (current?.mergeable === false) {
        await this.remark(repository, number, 'approved and green, but the pull request does not merge cleanly (conflict). A human has to look at it.', true);
        this.tell('conflict', repository, number, { title: current?.title }, current?.html_url);
        return metrics.refused('not_mergeable');
      }
      await this.forge.mergePull(repository, number, { method: this.config.mergeMethod, headSha: sha, deleteBranch: true });
      metrics.inc('forgehands_merges_total', { repository: repository.toLowerCase() });
      this.note(this.ticketOf(repository, number, bot ? null : pr.head.ref), 'merged');
      await this.remark(repository, number, twoKeys ? 'merged: approved by the reviewer and the security review, CI green; the protected paths it touches are configured for two keys.'
        : 'merged: approved by the reviewer, CI green, no protected path touched.');
      // A bot's pull request belongs to no ticket: there is nothing to close.
      if (bot) return 'merged';
      const issue = Number(/^ai\/issue-(\d+)$/.exec(pr.head.ref)![1]);
      try { await this.forge.closeIssue(repository, issue); }
      catch (error) { this.logger.error('could not close issue #' + issue + ':', error.message); }
      return 'merged';
    } catch (error) {
      this.logger.error('auto-merge of ' + repository + '#' + number + ' failed:', error.message);
      await this.remark(repository, number, 'approved and green, but the merge failed (' + String(error.message).slice(0, 120) + '). A human has to look at this pull request.', true);
      this.tell('failed', repository, number, { why: 'merge_failed' });
      return metrics.refused('merge_failed');
    }
  }

  // The verdict word of the latest security review comment for this commit ("OK" or "CONCERNS"), or null. Advisory, written by the
  // sensitive reviewer: `## Security review: OK|CONCERNS` and the first eight characters of the commit.
  async securityReview(repository: string, number: number, sha: string): Promise<string | null> {
    const comments = await this.forge.listComments(repository, number, 100);
    const found = (Array.isArray(comments) ? comments : [])
      .filter((comment: Json) => !this.config.securityReviewers || this.config.securityReviewers.has(String(comment.user?.login || comment.user?.username || '').toLowerCase()))
      .map((comment: Json) => ({ at: Date.parse(comment.created_at), text: String(comment.body || '').slice(0, 600) }))
      .filter((entry) => /security review\s*:\s*(ok|concerns)\b/i.test(entry.text.slice(0, 200)) && entry.text.includes(sha.slice(0, 8)))
      .sort((a, b) => a.at - b.at)
      .at(-1);
    return found ? /concerns/i.test(found.text.slice(0, 200)) ? 'CONCERNS' : 'OK' : null;
  }

  // Two keys: every protected file is also a `two_keys` file of the policy, a security review route exists and its comment for this very
  // commit says OK (the second key, a different agent run than the reviewer's). Anything else leaves the pull request to the human.
  twoKeyFiles(policy: { deny: RegExp[]; twoKeys?: RegExp[] }, files: string[]): string[] {
    return (policy.twoKeys || []).length ? files.filter((file) => policy.twoKeys!.some((pattern) => pattern.test(file))) : [];
  }

  async twoKeysHold(repository: string, number: number, sha: string, policy: { deny: RegExp[]; twoKeys?: RegExp[] }, files: string[]): Promise<boolean> {
    if (!this.hasSecurityRoute() || !files.length || this.twoKeyFiles(policy, files).length !== files.length) return false;
    try { return (await this.securityReview(repository, number, sha)) === 'OK'; }
    catch (error) {
      this.logger.error('could not read the security review of #' + number + ':', error.message);
      return false;
    }
  }

  hasSecurityRoute(): boolean {
    return [...this.config.routes.values()].some((route) => route.kind === 'sensitive_review');
  }

  // The comment that hands a protected-path pull request to the human: what is done, why a human, which paths (with the reason of the
  // policy where it has one), what the security review found and, if Forgejo already reports a conflict, that it is being resolved.
  async handOverText(repository: string, number: number, sha: string, policy: { patterns: string[]; deny: RegExp[]; reasons: (string | null)[]; twoKeys?: RegExp[] },
    files: string[], conflict: boolean): Promise<string> {
    const groups = new Map<number, string[]>();
    for (const file of [...new Set(files)]) {
      const index = policy.deny.findIndex((pattern) => pattern.test(file));
      groups.set(index, [...(groups.get(index) || []), file]);
    }
    const lines = [...groups].map(([index, list]) => '- `' + policy.patterns[index] + '`' + (policy.reasons[index] ? ': ' + policy.reasons[index] : '')
      + ' (' + list.slice(0, 5).join(', ') + (list.length > 5 ? ', and ' + (list.length - 5) + ' more' : '') + ')');
    const security = await this.securityLine(repository, number, sha);
    const second = this.twoKeyFiles(policy, [...new Set(files)]);
    const qualified = second.length ? 'Of these files, ' + second.slice(0, 5).join(', ') + (second.length > 5 ? ' and ' + (second.length - 5) + ' more' : '') + (second.length === new Set(files).size ? ' are all configured for two keys, but that needs a security review of this commit that says OK.' : ' would qualify for two keys, but not every protected file does.') : '';
    return ['approved and green, but not merged automatically: it touches protected paths. It is ready for a human to merge.',
      'The reviewer approved commit ' + sha.slice(0, 8) + ' and CI is green. A human merges it because the merge policy keeps these paths for a person:\n' + lines.join('\n'),
      ...(security ? [security.trim()] : []),
      ...(qualified && this.hasSecurityRoute() ? [qualified] : []),
      ...(conflict ? [this.forge.agent(repository).name + ' reports a conflict with the default branch; a conflict round resolves it before the merge.'] : [])].join('\n\n');
  }

  // The hand-over of a protected-path pull request as a message: the reason of the policy for the matching patterns (else the message says
  // that protected paths are touched), how many files, and what the security review found. Best effort, never throws.
  async tellHandOver(repository: string, number: number, sha: string, policy: { patterns: string[]; deny: RegExp[]; reasons: (string | null)[] }, files: string[], pr: Json): Promise<void> {
    if (!this.notifier.wants('handover')) return;
    try {
      const unique = [...new Set(files)];
      const reasons = [...new Set(unique.map((file) => policy.reasons[policy.deny.findIndex((pattern) => pattern.test(file))]).filter((reason): reason is string => Boolean(reason)))];
      let security: Facts['security'] = 'none';
      if (this.hasSecurityRoute()) {
        const verdict = await this.securityReview(repository, number, sha).catch(() => null);
        security = verdict === 'OK' ? 'ok' : verdict === 'CONCERNS' ? 'concerns' : 'none';
      }
      this.tell('handover', repository, number, { title: pr?.title, files: unique.length, reason: reasons.join('; '), security }, pr?.html_url);
    } catch (error) {
      this.logger.error('could not build the notification of #' + number + ':', error.message);
    }
  }

  // One sentence for the comment that hands a protected-path pull request to the human. Empty without a security review route.
  async securityLine(repository: string, number: number, sha: string): Promise<string> {
    if (!this.hasSecurityRoute()) return '';
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

  // The verdict of the pull request for this commit, from the source the operator chose (VERDICT_SOURCE).
  async reviewOf(repository: string, number: number, sha: string): Promise<{ ok: boolean; reason?: string }> {
    const source = this.config.verdictSource;
    if (source === 'comment') return this.commentVerdict(repository, number, sha);
    let native: { ok: boolean; reason?: string };
    try { native = await this.nativeVerdict(repository, number, sha); }
    catch (error) {
      // Only `both` has another source to fall back on; `review` fails (the merge reports it) rather than guess.
      if (source === 'review') throw error;
      this.logger.error('could not read the reviews of #' + number + ', going by the verdict comment:', error.message);
      return this.commentVerdict(repository, number, sha);
    }
    if (native.ok || source === 'review' || native.reason === 'changes_requested') return native;
    // `both`: a verdict comment counts too, unless a current review asks for changes (that one wins).
    return this.commentVerdict(repository, number, sha);
  }

  // The native reviews of the head commit: per reviewer only the latest approval or request for changes counts, and only when it is not
  // dismissed, not stale and written for exactly this commit (`commit_id`). An approval of somebody who may not approve (Forgejo: `official`
  // false) and an approval whose body is shorter than MIN_REVIEW_CHARS (no evidence) do not count; a request for changes always does.
  // `any`: some reviewer has given a verdict on this commit, whatever it is.
  async nativeReviews(repository: string, number: number, sha: string): Promise<{ approvals: string[]; changes: string[]; any: boolean }> {
    const reviews = await this.forge.listReviews(repository, number);
    const latest = new Map<string, Json>();
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const login = String(review.user?.login || '').toLowerCase();
      if (!login || review.dismissed || review.stale || review.commit_id !== sha) continue;
      if (review.state !== 'APPROVED' && review.state !== 'REQUEST_CHANGES') continue;
      const previous = latest.get(login);
      const at = Date.parse(review.submitted_at || '') || 0;
      if (!previous || at > (Date.parse(previous.submitted_at || '') || 0) || (at === (Date.parse(previous.submitted_at || '') || 0) && Number(review.id) > Number(previous.id))) latest.set(login, review);
    }
    const approvals: string[] = [];
    const changes: string[] = [];
    for (const [login, review] of latest) {
      if (review.state === 'REQUEST_CHANGES') changes.push(login);
      else if (review.official !== false && String(review.body || '').length >= this.config.minReviewChars) approvals.push(login);
    }
    return { approvals, changes, any: latest.size > 0 };
  }

  async nativeVerdict(repository: string, number: number, sha: string): Promise<{ ok: boolean; reason?: string }> {
    const { approvals, changes, any } = await this.nativeReviews(repository, number, sha);
    if (changes.length) return { ok: false, reason: 'changes_requested' };
    if (approvals.length >= this.config.requiredApprovals) return { ok: true };
    return { ok: false, reason: any ? 'not_enough' : 'none' };
  }

  // The latest review comment of the current commit: written after the commit, long enough to hold evidence, and starting with
  // "Verdict: OK" or "Verdict: NOT OK". A comment of anybody counts (a human may review too); the latest one decides.
  async commentVerdict(repository: string, number: number, sha: string): Promise<{ ok: boolean; reason?: string }> {
    let since = 0;
    try {
      const time = Date.parse((await this.forge.commitTime(repository, sha)) || '');
      if (Number.isFinite(time)) since = time;
    } catch (error) {
      this.logger.error('could not read the time of commit ' + sha.slice(0, 8) + ', counting every review comment:', error.message);
    }
    const comments = await this.forge.listComments(repository, number, 100);
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
  // The ledger's name of a ticket: "repo#issue" for an agent branch (ai/issue-<n>), "repo!pr<n>" for a bot's pull request (no branch given).
  ticketOf(repository: string, number: number, agentBranch: string | null): string {
    return repository.toLowerCase() + (agentBranch === null ? '!pr' + number : '#' + /^ai\/issue-(\d+)$/.exec(agentBranch)![1]);
  }

  async rejectApproval(repository: string, number: number, sha: string, reason?: string, pr?: Json): Promise<void> {
    metrics.inc('forgehands_blocks_total', { reason: 'approval_not_trusted' });
    const event = { repository: { full_name: repository }, pull_request: { number } };
    await this.clearApproval(event);
    const what = reason === 'changes_requested' ? 'a review of commit ' + sha.slice(0, 8) + ' asks for changes'
      : reason === 'not_enough' ? 'commit ' + sha.slice(0, 8) + ' has fewer than the ' + this.config.requiredApprovals + ' approving review(s) (REQUIRED_APPROVALS) of reviewers who may approve, each with at least ' + this.config.minReviewChars + ' characters of evidence'
      : reason === 'not_ok' ? 'the latest review of commit ' + sha.slice(0, 8) + ' says NOT OK'
      : this.config.verdictSource === 'review' ? 'there is no approving review for commit ' + sha.slice(0, 8)
      : 'there is no review comment for commit ' + sha.slice(0, 8) + ' that starts with \"Verdict: OK\" and holds evidence (at least ' + this.config.minReviewChars + ' characters)';
    await this.remark(repository, number, 'the label ' + this.config.approvedLabel + ' was set, but ' + what + '. The approval is not trusted and was taken off. A human has to look at this pull request, or push a commit to run the review again.', true);
    this.tell('blocked', repository, number, { why: 'approval_not_trusted', title: pr?.title }, pr?.html_url);
    try {
      const label = await this.forge.findOrCreateLabel(repository, this.config.blockedLabel, '#b60205');
      await this.forge.addLabels(repository, number, [label]);
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
      const labels = await this.forge.labelsOf(repository, number);
      const approved = (labels || []).find((label) => label.name === this.config.approvedLabel);
      if (approved) await this.forge.removeLabel(repository, number, approved);
    } catch (error) {
      this.logger.error('could not clear the approval of #' + number + ':', error.message);
    }
  }
}
