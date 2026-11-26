// UPDATE_BRANCHES: when the default branch moves, the open agent pull requests are brought up to date (or a conflict round starts), once the
// branch has been quiet for a while; a run that ends on a pull request has its branch looked at too.
import { pullBranch } from './bot.ts';
import { metrics } from '../metrics.ts';
import type { ForgeEvent, Job, Json, PushEvent } from '../types.ts';
import type { Dispatcher } from './dispatch.ts';

// What BranchRefresher reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type BranchRefresherHost = Pick<Dispatcher, 'config' | 'forge' | 'issueKey' | 'jobs' | 'logger' | 'markForHuman' | 'merger' | 'now' | 'roundLimit' | 'rounds' | 'roundsUsedUp' | 'tick'>;

export class BranchRefresher {
  host: BranchRefresherHost;
  lastUpdate = new Map<string, number>(); // repository#pr -> when ForgeHands last updated its branch (the cooldown)
  mainMoved = new Map<string, { at: number; event: PushEvent }>(); // repository -> { at, event }: the default branch moved, look at the pull requests after the delay

  constructor(host: BranchRefresherHost) {
    this.host = host;
  }

  // The default branch of a repository moved. Remember the newest push and look at the pull requests once it has been quiet for a while.
  onMainMoved(event: PushEvent): string {
    if (!this.host.config.updateBranches || !this.host.config.forgejo) return 'branch_updates_off';
    this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.host.now(), event });
    return 'scheduled';
  }

  async refreshMoved(now: number): Promise<boolean> {
    let changed = false;
    for (const [repository, moved] of [...this.mainMoved]) {
      if (now - moved.at < this.host.config.branchUpdateDelayMs) continue;
      this.mainMoved.delete(repository);
      try { if (await this.refreshBranches(moved.event)) changed = true; }
      catch (error) { this.host.logger.error('could not look at the pull requests of ' + repository + ':', error.message); }
    }
    return changed;
  }

  // Open agent pull requests (branch ai/issue-<n>) that fell behind the default branch. What a rebase throws away is a review, so only a
  // pull request with neither an approval nor an OK review for its current commit is brought up to date, and only when no agent works on
  // its issue. A rebase that conflicts becomes a conflict round of the worker. Approved and reviewed pull requests are left alone: they
  // merge as they are, and a conflict shows when the merge is tried.
  async refreshBranches(event: PushEvent): Promise<boolean> {
    const tip = event.after;
    const pulls = await this.host.forge.listPulls(event.repository.full_name, { state: 'open', limit: 50 });
    let changed = false;
    let deferred = false;
    for (const pr of Array.isArray(pulls) ? pulls : []) {
      const outcome = await this.refreshPull(event, pr, tip);
      if (outcome.changed) changed = true;
      if (outcome.deferred) deferred = true;
    }
    // Look again later at what was postponed (the CI run ended, the cooldown passed).
    if (deferred) this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.host.now(), event });
    return changed;
  }

  // One open pull request against the default branch at `tip`: bring it up to date, or start a conflict round when the rebase conflicts.
  async refreshPull(event: PushEvent, pr: Json, tip: string): Promise<{ changed: boolean; deferred: boolean }> {
    const none = { changed: false, deferred: false };
    const base = event.repository.full_name.toLowerCase() + '#';
    const match = /^ai\/issue-(\d+)$/.exec(pullBranch(pr));
    if (!match || pr.state !== 'open' || pr.merged || !pr.merge_base || pr.merge_base === tip) return none;
    if (pr.head?.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== event.repository.full_name.toLowerCase()) return none;
    const issue = Number(match[1]);
    if (this.host.jobs.list(true).some((job) => job.key.startsWith(base + issue + ':'))) return none;
    const labels = (pr.labels || []).map((label: Json) => label.name);
    if (labels.includes(this.host.config.blockedLabel)) return none;
    const approved = labels.includes(this.host.config.approvedLabel);
    const prEvent = { ...event, pull_request: { number: pr.number, head_ref: pullBranch(pr), html_url: pr.html_url || null },
      issue: { number: issue, title: String(pr.title || '').slice(0, 1000), body: String(pr.body || '').slice(0, 50000), html_url: pr.html_url || null, comments: 0, labels } };
    let reviewed = approved;
    if (!reviewed) { try { reviewed = (await this.host.merger.reviewOf(event.repository.full_name, pr.number, pr.head.sha)).ok; } catch { reviewed = false; } }
    // An approved or reviewed pull request is not brought up to date: that would throw the review away, and it merges as it is. But one
    // that conflicts can be merged by nobody (a human waiting to merge a protected path would find it so). Once the WIP marker is gone,
    // which approval removes, Forgejo's mergeable is reliable: a conflict starts a conflict round, after which CI and review run again.
    if (reviewed) {
      if (pr.mergeable === false && !this.host.forge.isWip(String(pr.title || '')) && (await this.startConflictRound(prEvent, tip))) return { changed: true, deferred: false };
      return none;
    }
    // An update changes the head commit: it cancels the CI run in progress and throws away a review. So it only happens where it
    // is needed (the branch and the default branch touch the same files) and not while CI runs or just after the last update.
    if (!(await this.touchesSameFiles(event, pr, tip))) return none;
    const hold = await this.updateHold(event, pr);
    if (hold) { this.host.logger.error(event.repository.full_name + '#' + pr.number + ': update postponed (' + hold + ')'); return { changed: false, deferred: true }; }
    this.lastUpdate.set(base + pr.number, this.host.now());
    try {
      if (await this.host.forge.updateBranch(event.repository.full_name, pr.number) === 'conflict') {
        metrics.inc('forgehands_branch_conflicts_total');
        if (await this.startConflictRound(prEvent, tip)) return { changed: true, deferred: false };
        return none;
      }
      this.host.logger.error(event.repository.full_name + '#' + pr.number + ' brought up to date with the default branch');
      metrics.inc('forgehands_branch_updates_total');
    } catch (error) {
      this.host.logger.error('could not update #' + pr.number + ':', error.message);
    }
    return none;
  }

  // The default branch may have moved while a run on this pull request was active (such a pull request is left alone, see refreshPull), and
  // no later push brings it back into view. When the run ends, look at the pull request once: the same update, the same conflict round.
  async checkBranchAfterRun(job: Job): Promise<void> {
    const event = job.event;
    // A dependency bot keeps its own branch current (Renovate rebases itself).
    if (!this.host.config.updateBranches || !this.host.config.forgejo || !event?.pull_request || event.bot) return;
    const kind = this.host.config.routes.get(job.label)?.kind;
    if (kind === 'conflict' || kind === 'sensitive_review') return;
    try {
      const branch = event.repository.default_branch;
      if (!branch) return;
      const tip = await this.host.forge.branchTip(event.repository.full_name, branch);
      if (typeof tip !== 'string' || !tip) return;
      const pr = await this.host.forge.getPull(event.repository.full_name, event.pull_request.number);
      const push = { type: 'push.default', source: this.host.forge.kind, repository: event.repository, sender: event.sender, after: tip } as unknown as PushEvent;
      const outcome = await this.refreshPull(push, pr, tip);
      if (outcome.deferred) this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.host.now(), event: push });
      if (outcome.changed) this.host.tick().catch((error) => this.host.logger.error('dispatch failed:', error.message));
    } catch (error) {
      this.host.logger.error('could not look at the branch of #' + event.pull_request.number + ' after its run:', error.message);
    }
  }

  // Can the rebase of this pull request conflict? Only if the default branch changed a file since the merge base that the pull request
  // changes too. Anything unclear (a failing call, a list that may be cut off) counts as yes.
  async touchesSameFiles(event: PushEvent, pr: Json, tip: string): Promise<boolean> {
    try {
      const compare = await this.host.forge.compare(event.repository.full_name, pr.merge_base, tip);
      const ours = await this.host.forge.pullFiles(event.repository.full_name, pr.number, 100);
      if (!Array.isArray(compare?.files) || !Array.isArray(ours) || ours.length >= 100 || ((compare.total_commits ?? 0) > 0 && compare.files.length === 0)) return true;
      const names = (list: Json[]) => list.flatMap((file) => [file.filename, file.previous_filename]).filter(Boolean);
      const theirs = new Set(names(compare.files));
      return names(ours).some((name) => theirs.has(name));
    } catch (error) {
      this.host.logger.error('could not compare #' + pr.number + ' with the default branch:', error.message);
      return true;
    }
  }

  // Why the update of this pull request has to wait, or null: CI still runs on its head commit, or its branch was updated recently.
  async updateHold(event: PushEvent, pr: Json): Promise<string | null> {
    const last = this.lastUpdate.get(event.repository.full_name.toLowerCase() + '#' + pr.number);
    if (last && this.host.now() - last < this.host.config.branchUpdateMinIntervalMs) return 'cooldown';
    try {
      const status = await this.host.forge.commitStatus(event.repository.full_name, pr.head.sha);
      if (status?.state === 'pending' && status.total_count > 0) return 'CI is still running';
    } catch (error) {
      this.host.logger.error('could not read the status of #' + pr.number + ':', error.message);
    }
    return null;
  }

  // The branch of a pull request conflicts with the default branch: a round of the worker resolves it (rebase and one force push are
  // allowed in this round and only here). Counts as a round; without a conflict route, or when the rounds are used up, a human is called.
  async startConflictRound(event: ForgeEvent, tip: string): Promise<boolean> {
    const route = [...this.host.config.routes].find(([, entry]) => entry.kind === 'conflict')?.[0];
    const number = event.pull_request!.number;
    if (!route) {
      await this.host.markForHuman(event, 'ForgeHands: the pull request conflicts with ' + (event.repository.default_branch || 'the default branch') + ' and no conflict round is configured. A human has to resolve it.', 'conflict');
      return false;
    }
    const key = this.host.issueKey(event) + ':' + route + ':' + tip.slice(0, 8);
    if (this.host.jobs.list().some((job) => job.key === key)) return false;
    if (this.host.rounds(event) >= this.host.roundLimit(event)) { await this.host.roundsUsedUp(event); return false; }
    this.host.jobs.add({ key, label: route, status: 'queued', created: this.host.now(), event: { ...event, type: 'pull_request.conflict', label: route, base_sha: tip } });
    await this.host.merger.clearApproval(event);
    this.host.logger.error(this.host.issueKey(event) + ': pull request #' + number + ' conflicts with the default branch, conflict round queued');
    return true;
  }
}
