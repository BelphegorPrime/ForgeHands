import { createForge, createTransport } from '../forge/index.ts';
import { DryLog } from '../dry.ts';
import { isBotPull, pullBranch, REVERT_BRANCH } from './bot.ts';
import { metrics } from '../metrics.ts';
import { NO_NOTIFY, mentionOf, pullUrl } from '../notify/index.ts';
import { immediateMessage } from '../notify/texts.ts';
import { checksMessage } from '../notify/checks.ts';
import { checkFacts } from './checks.ts';
import type { Facts } from '../notify/texts.ts';
import type { Notify } from '../notify/index.ts';
import type { DirectConfig, Fetch, ForgeEvent, Json, Logger } from '../types.ts';
import type { Forge } from '../types/forge.ts';
import type { JobStore } from '../store/jobs.ts';
import { isDry } from '../dry.ts';

const PAGE = 50;
const MAX_FILES = 1000;
// A held two-key merge is looked at again this often (the timer in the dispatch tick), so that a lifted HOLD_LABEL or a new commit is noticed.
const HOLD_RECHECK_MS = 5 * 60000;
const DAY_MS = 24 * 60 * 60000;
// After the WIP marker is removed Forgejo works out `mergeable` again, a moment later: a false that is read right after is read again this often.
const MERGEABLE_REREADS = 4;
const MERGEABLE_WAIT_MS = 2000;
// A 'not merged' line is written once per pull request, head commit and reason in this span (a hold or a wait is looked at again every few minutes).
const DECISION_LOG_MS = 60 * 60000;
const DECISION_KEEP_MS = 7 * DAY_MS;

// The ledger key of a pull request's hold: "repo#pr<n>" (lower case), the same form as the ledger keys of bot pull requests.
export const holdKey = (repository: string, number: number): string => repository.toLowerCase() + '#pr' + number;

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
  // The last merge decision per pull request ("repo#<pr>", lower case): the reason it was not merged (or 'merged'), and when. The status page shows it.
  decisions = new Map<string, { reason: string; at: number }>();
  // When a 'not merged' line was last written, per "repo#<pr>@<sha>:<reason>" (see report).
  decisionLogged = new Map<string, number>();
  // Set by the dispatcher: is a security review of this commit still queued or running? Then the hand-over waits for it.
  securityPending: (repository: string, number: number, sha: string) => boolean = () => false;
  // Tells the ledger that ForgeHands merged a ticket or handed it to a human (ticket: "repo#issue" or "repo!pr<n>"); the dispatcher sets it, see Dispatcher.noteTicket.
  note: (ticket: string, fact: 'merged' | 'blocked') => void = () => {};
  // Tells the human by a message of ForgeHands' own (src/notify); the dispatcher sets it. Off by default.
  notifier: Notify = NO_NOTIFY;
  // Repository@commit pairs known to have no workflow file (REVIEW_WITHOUT_CI), for this process only. "Has CI" is never kept: a workflow
  // file can arrive with the next commit, and a commit that has them must be looked at again.
  noCiSeen = new Set<string>();
  // Repositories whose missing CI was reported (CHECKS_FROM_CI), once per process.
  checksNoticed = new Set<string>();
  // The ledger (the dispatcher sets it): holds of two-key merges are kept there, so that a restart neither loses nor shortens one.
  ledger: JobStore | null = null;
  now: () => number = Date.now;
  // The wait between re-reads of `mergeable` (see readMergeable). A test replaces it.
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // Is the commit green? 'green': every check reports and succeeds. 'no_ci': nothing reports and the repository has no workflow file at that
  // commit (REVIEW_WITHOUT_CI), so there is nothing to wait for. A repository with workflows that has not reported yet is not green, and
  // neither is a failing, pending or unreadable one. A failing status call throws, the caller decides what an unknown answer means.
  async ciGreen(repository: string, sha: string): Promise<'green' | 'no_ci' | false> {
    const status = await this.forge.commitStatus(repository, sha);
    if (status?.state === 'success' && status.total_count > 0) return 'green';
    return !(status?.total_count > 0) && (await this.noWorkflows(repository, sha)) ? 'no_ci' : false;
  }

  // Does this commit have no CI that could run: no workflow file in the tree? Only a positive answer is kept, and only in memory. Off
  // switch, a forge that cannot tell, an unreadable forge: all of them answer false ("unknown"), so nothing is reviewed on a guess.
  async noWorkflows(repository: string, sha: string): Promise<boolean> {
    if (!this.config.reviewWithoutCi || !this.config.forgejo || !this.forge.hasWorkflows) return false;
    const key = repository.toLowerCase() + '@' + sha;
    if (this.noCiSeen.has(key)) return true;
    try {
      if (await this.forge.hasWorkflows(repository, sha)) return false;
    } catch (error) {
      this.logger.error('could not tell whether ' + repository + ' has workflows at ' + sha.slice(0, 7) + ', not treating it as without CI:', error.message);
      return false;
    }
    this.noCiSeen.add(key);
    return true;
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

  // Returns the outcome as a status string; nothing here throws. Every outcome is reported (see report): a merge, or the reason it did not merge.
  async handle(event: ForgeEvent, regraced = false): Promise<string> {
    const seen: { sha: string | null } = { sha: null };
    const outcome = await this.decide(event, regraced, seen);
    this.report(event.repository.full_name, event.pull_request?.number ?? 0, outcome, seen.sha);
    return outcome;
  }

  // Writes the decision of a pull request that had an approval signal: one line for a merge, one for a refusal (`not merged: <reason>`, at most
  // once per head commit and reason per hour), a counter for both, and the last decision for the status page. Called by handle, and by the
  // dispatcher for an approval that never reached handle (see Dispatcher.approve, enqueue). Never throws.
  report(repository: string, number: number, outcome: string, sha: string | null): void {
    const name = repository.toLowerCase() + '#' + number;
    const now = this.now();
    if (outcome === 'merged') {
      this.decisions.delete(name);
      metrics.inc('forgehands_merge_decisions_total', { result: 'merged', reason: 'merged' });
      this.logger.error(repository + '#' + number + ': merged (' + String(sha || '').slice(0, 7) + ')');
      return;
    }
    metrics.inc('forgehands_merge_decisions_total', { result: 'not_merged', reason: outcome });
    this.decisions.set(name, { reason: outcome, at: now });
    for (const [key, entry] of [...this.decisions]) if (now - entry.at > DECISION_KEEP_MS) this.decisions.delete(key);
    const logKey = name + '@' + String(sha || '') + ':' + outcome;
    const last = this.decisionLogged.get(logKey);
    if (last !== undefined && now - last < DECISION_LOG_MS) return;
    this.decisionLogged.set(logKey, now);
    if (this.decisionLogged.size > 1000) for (const [key, at] of [...this.decisionLogged]) if (now - at >= DECISION_LOG_MS) this.decisionLogged.delete(key);
    this.logger.error(repository + '#' + number + ': not merged: ' + outcome);
  }

  // The decision of handle, without the report. `seen.sha` is set once the head commit is known.
  async decide(event: ForgeEvent, regraced: boolean, seen: { sha: string | null }): Promise<string> {
    const repository = event.repository.full_name;
    const policy = this.config.mergePolicy.get(repository.toLowerCase());
    if (!policy || !this.config.forgejo) return 'no_merge_policy';
    const number = event.pull_request!.number;
    try {
      const pr = await this.forge.getPull(repository, number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      // Judged from the pull request as Forgejo has it now, not from the event: an agent branch, or a pull request of a listed bot.
      const bot = isBotPull({ authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos }, pr, repository);
      if (!bot && !/^ai\/issue-\d+$/.test(pullBranch(pr))) return 'not_an_agent_branch';
      const sha = pr.head.sha;
      seen.sha = sha;
      // A revert pull request (REVERT_ON_RED) is an agent pull request as any other, but skips the hold and the daily limit.
      const revert = REVERT_BRANCH.test(pullBranch(pr));
      const labels = (pr.labels || []).map((label: Json) => label.name);
      // The approval label (comment mode, or a human's) is a claim; native reviews need no label, they are the proof themselves.
      const labelled = labels.includes(this.config.approvedLabel);
      if (!labelled && this.config.verdictSource === 'comment') return 'not_approved';
      if (labels.includes(this.config.blockedLabel)) return metrics.refused('blocked');
      // The verdict for this very commit is the proof. Without one nothing is merged.
      const review = await this.reviewOf(repository, number, sha);
      // A failed check is the same refusal as a red CI at the merge gate below, and takes no approval label off.
      if (review.reason === 'ci_failed') return metrics.refused('ci_not_green');
      // No label to take off: a review that does not (yet) say yes is simply not a reason to merge.
      if (!labelled && !review.ok) return review.reason === 'changes_requested' ? 'changes_requested' : review.reason === 'not_enough' ? 'awaiting_approvals' : 'not_approved';
      // The reviewer sometimes sets the label a moment before it posts the verdict comment. A label that arrives first is looked at
      // once more after a short wait, instead of being taken off at once (the wait does not hold the webhook delivery).
      if (!review.ok && review.reason === 'none' && !regraced && this.config.approvalGraceMs > 0) {
        this.later(() => { this.handle(event, true).catch((error) => this.logger.error('late approval check failed:', error.message)); }, this.config.approvalGraceMs);
        return 'awaiting_review';
      }
      if (!review.ok) {
        this.note(this.ticketOf(repository, number, bot ? null : pullBranch(pr)), 'blocked');
        await this.rejectApproval(repository, number, sha, review.reason, pr);
        return metrics.refused('no_valid_review');
      }
      const ci = await this.ciGreen(repository, sha);
      if (!ci) return metrics.refused('ci_not_green');
      const changed = await this.changedFiles(repository, number);
      const protectedFiles = changed.filter((name) => policy.deny.some((pattern) => pattern.test(name)));
      // Forgejo refuses to merge a pull request titled as work in progress (and reports it as not mergeable). Approved and green is
      // the end of the work in progress, for a human as much as for ForgeHands: the marker goes before either merges it. Only after
      // the title is clean does `mergeable` say anything about conflicts, so look at the pull request again.
      let current = pr;
      if (this.forge.isWip(pr.title || '')) {
        await this.forge.setPullTitle(repository, number, this.forge.stripWip(pr.title));
        current = await this.readMergeable(repository, number);
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
      // The two keys have agreed and everything else holds: the daily limit (TWO_KEYS_DAILY_LIMIT) and a hold (TWO_KEYS_HOLD_MINUTES) come before the merge.
      if (twoKeys && !revert) {
        if (this.config.twoKeysDailyLimit && this.twoKeysToday(repository) >= this.config.twoKeysDailyLimit) {
          const limit = 'daily limit of ' + this.config.twoKeysDailyLimit + ' merges through two keys reached';
          await this.remark(repository, number, await this.handOverText(repository, number, sha, policy, protectedFiles, false)
            + '\n\nNot merged: ' + limit + ' (TWO_KEYS_DAILY_LIMIT). A human has to merge it.', true);
          await this.tellHandOver(repository, number, sha, policy, protectedFiles, current);
          return metrics.refused('daily_limit');
        }
        const gate = await this.holdGate(repository, number, sha, labels);
        if (gate !== 'go') return gate;
      }
      await this.forge.mergePull(repository, number, { method: this.config.mergeMethod, headSha: sha, deleteBranch: true });
      metrics.inc('forgehands_merges_total', { repository: repository.toLowerCase() });
      await this.recordMerge(repository, number, pullBranch(pr), twoKeys);
      this.note(this.ticketOf(repository, number, bot ? null : pullBranch(pr)), 'merged');
      const checks = ci === 'no_ci' ? 'there is no CI in this repository' : 'CI green';
      await this.remark(repository, number, twoKeys ? 'merged: approved by the reviewer and the security review, ' + checks + '; the protected paths it touches are configured for two keys.'
        : 'merged: approved by the reviewer, ' + checks + ', no protected path touched.');
      // A bot's pull request belongs to no ticket: there is nothing to close.
      if (bot) return 'merged';
      const issue = Number(/^ai\/issue-(\d+)$/.exec(pullBranch(pr))![1]);
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

  // The pull request as Forgejo has it once the WIP marker is gone. Forgejo recomputes `mergeable` asynchronously, so a false read right after the
  // title change may be stale: it is read again up to MERGEABLE_REREADS times, MERGEABLE_WAIT_MS apart. Only a false that stays is a conflict.
  async readMergeable(repository: string, number: number): Promise<Json> {
    let pull = await this.forge.getPull(repository, number);
    for (let read = 0; read < MERGEABLE_REREADS && pull?.mergeable === false; read++) {
      await this.sleep(MERGEABLE_WAIT_MS);
      pull = await this.forge.getPull(repository, number);
    }
    return pull;
  }

  // What ForgeHands merged goes to the ledger: the merge commit, read from the pull request after the merge (Forgejo's merge call does not return
  // it), and whether two keys merged it. A dry run merged nothing; a failed read keeps the record without the commit. Best effort.
  async recordMerge(repository: string, number: number, branch: string, twoKeys: boolean): Promise<void> {
    if (!this.ledger || isDry(this.config, repository)) return;
    let sha: string | null = null;
    try {
      const pr = await this.forge.getPull(repository, number);
      sha = pr?.merge_commit_sha || null;
    } catch (error) {
      this.logger.error('could not read the merge commit of #' + number + ':', error.message);
    }
    this.ledger.merges.push({ repository: repository.toLowerCase(), number, branch, sha, merged_at: this.now(), two_keys: twoKeys });
    await this.saveLedger();
  }

  // The merges through two keys of this repository in the last 24 hours (TWO_KEYS_DAILY_LIMIT). Without a ledger, none.
  twoKeysToday(repository: string): number {
    if (!this.ledger) return 0;
    const since = this.now() - DAY_MS;
    return this.ledger.merges.filter((entry) => entry.two_keys && entry.repository === repository.toLowerCase() && entry.merged_at > since).length;
  }

  // The hold of a two-key merge (TWO_KEYS_HOLD_MINUTES): 'go' when the merge may happen now; otherwise 'held' (the hold runs; it is started here, and
  // commented once per hold period) or 'held_label' (HOLD_LABEL is on). A hold belongs to one commit: a new commit clears it. Taking the label off
  // starts a full hold period again, so the operator always gets the whole time. Off (0) or without a ledger: 'go'.
  async holdGate(repository: string, number: number, sha: string, labels: string[]): Promise<'go' | 'held' | 'held_label'> {
    const store = this.ledger;
    if (!store || !this.config.twoKeysHoldMinutes) return 'go';
    const key = holdKey(repository, number);
    const now = this.now();
    let hold = store.holds.get(key);
    if (hold && hold.sha !== sha) { store.holds.delete(key); hold = undefined; }
    if (labels.includes(this.config.holdLabel)) {
      store.holds.set(key, { repository, number, sha, since: hold?.since ?? now, merge_after: null, check_at: now + HOLD_RECHECK_MS });
      await this.saveLedger();
      return 'held_label';
    }
    if (hold && hold.merge_after !== null) {
      if (hold.merge_after > now) {
        hold.check_at = Math.min(hold.merge_after, now + HOLD_RECHECK_MS);
        return 'held';
      }
      store.holds.delete(key);
      return 'go';
    }
    // No hold yet, or HOLD_LABEL came off: a full hold period starts now.
    const until = now + this.config.twoKeysHoldMinutes * 60000;
    store.holds.set(key, { repository, number, sha, since: now, merge_after: until, check_at: Math.min(until, now + HOLD_RECHECK_MS) });
    await this.saveLedger();
    try { await this.forge.findOrCreateLabel(repository, this.config.holdLabel, '#fbca04'); }
    catch (error) { this.logger.error('could not create the label ' + this.config.holdLabel + ':', error.message); }
    await this.remark(repository, number, 'approved by both keys. It merges at ' + new Date(until).toISOString().slice(11, 16) + ' UTC unless the label `'
      + this.config.holdLabel + '` is put on this pull request or a new commit arrives.', true);
    return 'held';
  }

  // The timer of the holds, called once per dispatch tick. A hold that is due is looked at through handle(), which merges when the hold has ended
  // and everything still holds (the reviewer, the security review, CI, mergeable, HOLD_LABEL off). A pull request that closed or got a new commit
  // loses its hold. Returns whether a hold was looked at.
  async recheckHolds(): Promise<boolean> {
    const store = this.ledger;
    if (!store || !store.holds.size) return false;
    let looked = false;
    for (const [key, hold] of [...store.holds]) {
      if (hold.check_at > this.now()) continue;
      looked = true;
      try {
        const pr = await this.forge.getPull(hold.repository, hold.number);
        if (!pr || pr.state !== 'open' || pr.merged || pr.head?.sha !== hold.sha) { store.holds.delete(key); continue; }
        await this.handle({ repository: { full_name: hold.repository }, pull_request: { number: hold.number } } as unknown as ForgeEvent);
      } catch (error) {
        this.logger.error('could not look again at the hold of #' + hold.number + ':', error.message);
      }
      // Whatever handle() decided, a hold whose time has run out is over; a held one is looked at again soon.
      const left = store.holds.get(key);
      if (left && left.merge_after !== null && left.merge_after <= this.now()) store.holds.delete(key);
      else if (left) left.check_at = Math.min(left.merge_after ?? Infinity, this.now() + HOLD_RECHECK_MS);
    }
    if (looked) await this.saveLedger();
    return looked;
  }

  async saveLedger(): Promise<void> {
    try { await this.ledger!.persist(this.now()); }
    catch (error) { this.logger.error('could not persist the holds:', error.message); }
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
    if (this.config.checksFromCi) {
      const refused = await this.checksVerdict(repository, sha);
      if (refused) return refused;
    }
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

  // CHECKS_FROM_CI: a head whose recorded check failed gets no OK, whatever the reviewer wrote. A head without any CI is reported once per
  // repository to the human and is judged as before: revert-on-red and verification need CI, so the operator should know it is missing.
  // Never throws; an unreadable check is `unknown` and decides nothing.
  async checksVerdict(repository: string, sha: string): Promise<{ ok: false; reason: string } | null> {
    const facts = await checkFacts(this.forge, repository, sha, this.logger, this.config.reviewWithoutCi);
    if (facts.state === 'failure') return { ok: false, reason: 'ci_failed' };
    const key = repository.toLowerCase();
    if (facts.state === 'none' && !this.checksNoticed.has(key)) {
      this.checksNoticed.add(key);
      this.logger.error(repository + ' has no CI (no workflow file at ' + sha.slice(0, 8) + '): revert-on-red and verification cannot work there');
      if (this.notifier.wants('checks')) this.notifier.notify(checksMessage(this.config.notify.language, repository, sha), repository);
    }
    return null;
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

  // The first lines of the verdict the reviewer gave on this commit, for the human (the review comment that starts with `Verdict:`, else the review
  // that asks for changes). Empty when none is found; a read that fails throws, and the caller decides.
  async verdictLines(repository: string, number: number, sha: string): Promise<string[]> {
    const firstLines = (body: unknown): string[] => String(body || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.slice(0, 200));
    if (this.config.verdictSource !== 'review') {
      const time = Date.parse((await this.forge.commitTime(repository, sha)) || '');
      const since = Number.isFinite(time) ? time : 0;
      const comments = await this.forge.listComments(repository, number, 100);
      const last = (Array.isArray(comments) ? comments : [])
        .filter((comment: Json) => Date.parse(comment.created_at) >= since && /verdict\s*:\s*(not\s+ok|ok)\b/i.test(String(comment.body || '').slice(0, 300)))
        .sort((a: Json, b: Json) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1);
      if (last) return firstLines(last.body);
    }
    if (this.config.verdictSource !== 'comment') {
      const reviews = await this.forge.listReviews(repository, number);
      const last = (Array.isArray(reviews) ? reviews : [])
        .filter((review: Json) => review.commit_id === sha && review.state === 'REQUEST_CHANGES' && !review.dismissed && !review.stale)
        .sort((a: Json, b: Json) => (Date.parse(a.submitted_at || '') || 0) - (Date.parse(b.submitted_at || '') || 0)).at(-1);
      if (last) return firstLines(last.body);
    }
    return [];
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
