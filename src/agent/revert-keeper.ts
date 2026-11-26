// REVERT_ON_RED: a red default branch after a merge of ForgeHands is reverted (once, after a rerun of the failed run when it was green before
// the merge), and the revert rate is watched.
import { Merger } from './merge.ts';
import { isPullRef, pullBranch, REVERT_BRANCH } from './bot.ts';
import { redact } from '../utils/redact.ts';
import { mentionOf } from '../notify/index.ts';
import { immediateMessage } from '../notify/texts.ts';
import { known, metrics } from '../metrics.ts';
import type { ForgeEvent, Json, RerunRecord, RevertRecord } from '../types.ts';
import type { CommitStatus } from '../types/forge.ts';
import { markReverted, revertRate } from './revert-rate.ts';
import { RERUN_NOTE, RUN_UNFINISHED } from './run-states.ts';
import type { PreExisting } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What RevertKeeper reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type RevertKeeperHost = Pick<Dispatcher, 'commitRecovered' | 'config' | 'enqueueOne' | 'forge' | 'jobs' | 'lastRunLabel' | 'logger' | 'notifier' | 'now' | 'secretValues' | 'tell' | 'tick'>;

export class RevertKeeper {
  host: RevertKeeperHost;
  revertsInFlight = new Set<string>(); // repository#pull request n -> its revert is being handled now (see revertMerged); in memory only

  constructor(host: RevertKeeperHost) {
    this.host = host;
  }

  // The merged revert pull request r (ai/revert-<n>) undid the merge of pull request n: that merge counts as reverted, once (REVERT_RATE_ALERT).
  // Saved at once; a merge that is marked already, or one ForgeHands did not merge, changes nothing.
  async markRevertedMerge(repository: string, number: number, revert: number): Promise<void> {
    const merge = markReverted(this.host.jobs.merges, repository, number, revert);
    if (!merge) return;
    metrics.inc('forgehands_merges_reverted_total', { repository: repository.toLowerCase() });
    try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
  }

  // A red default branch after the merge of pull request n that no revert of ForgeHands undid: no revert route, a revert that went red, or a
  // ticket blocked after its revert. Counted once per merge (forgehands_reverts_needing_human_total), saved at once.
  async markNeededHuman(repository: string, number: number): Promise<void> {
    const name = repository.toLowerCase();
    const merge = this.host.jobs.merges.find((entry) => entry.repository === name && entry.number === number);
    if (!merge || merge.needed_human) return;
    merge.needed_human = true;
    metrics.inc('forgehands_reverts_needing_human_total', { repository: name });
    try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
  }

  // REVERT_RATE_ALERT: a repository whose revert rate of the last 30 days is above the threshold gets one `failed` notice per day (UTC), once
  // REVERT_RATE_MIN_MERGES merges are in the window, so that one revert of two merges does not alarm. Off at 0. Returns whether it noted one.
  async checkRevertRate(now: number): Promise<boolean> {
    const threshold = this.host.config.revertRateAlert;
    if (!threshold || !this.host.notifier.wants('failed')) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    let told = false;
    for (const repository of this.host.config.allowedRepos) {
      const rate = revertRate(this.host.jobs.merges, repository, now);
      if (rate.ratio === null || rate.merges < this.host.config.revertRateMinMerges || rate.ratio * 100 <= threshold) continue;
      const key = 'revert_rate:' + repository + '@' + day;
      if (this.host.jobs.noted(key)) continue;
      this.host.jobs.note(key, now);
      told = true;
      const percent = Math.round(rate.ratio * 1000) / 10;
      this.host.notifier.notify(immediateMessage(this.host.config.notify.language, 'failed', { repository, number: 0, why: 'revert_rate',
        rate: { percent, reverted: rate.reverted, merges: rate.merges, threshold } }), repository);
    }
    return told;
  }

  // The record of the revert of pull request n (REVERT_RETRIES), if any.
  revertOf(repository: string, number: number): RevertRecord | undefined {
    if (!this.host.config.revertRetries) return undefined;
    return this.host.jobs.reverts.find((entry) => entry.repository === repository.toLowerCase() && entry.number === number);
  }

  // The record of the revert of pull request n is missing (the revert ran, but its record was never kept, or the ledger predates it), while the
  // ledger knows the merge of n: when that merge was of an agent's branch (ai/issue-<m>) the record is made now, as onMainFailure would have made it.
  // The branch is read from the pull request when the ledger holds a pull request ref (refs/pull/<n>/head). A bot's or a ticketless merge: none.
  async recoverRevert(repository: string, number: number): Promise<RevertRecord | undefined> {
    if (!this.host.config.revertRetries) return undefined;
    const name = repository.toLowerCase();
    const merge = this.host.jobs.merges.find((entry) => entry.repository === name && entry.number === number);
    if (!merge) return undefined;
    let branch = String(merge.branch || '');
    if (isPullRef(branch)) {
      try { branch = pullBranch(await this.host.forge.getPull(repository, number)); } catch (error) { this.host.logger.error('could not read #' + number + ' to name its branch:', error.message); }
    }
    const ticket = /^ai\/issue-(\d+)$/.exec(branch);
    if (!ticket) return undefined;
    // The await above lets another event make the record meanwhile: that one is used, not a second record for the same merge.
    const existing = this.revertOf(repository, number);
    if (existing) return existing;
    const record: RevertRecord = { repository: name, number, issue: Number(ticket[1]), sha: String(merge.sha || ''), state: 'started', at: this.host.now() };
    this.host.jobs.reverts.push(record);
    this.host.logger.error(name + '#' + number + ': the record of its revert was missing, made again from the ledger (ticket #' + record.issue + ')');
    return record;
  }

  // The revert of an agent's merge is merged (by ForgeHands or by a human; seen on the push to the default branch that merged it). Once per revert:
  // the ticket is reopened (its work was undone), one comment says what broke and quotes the revert's own account (redacted), and the worker route
  // starts again, as a newly added label does, while REVERT_RETRIES allows it. Then the ticket gets BLOCKED_LABEL and the human is called. Each step
  // is recorded, so a step that failed is tried again on the next push, and the steps done are not repeated. Returns whether it closed something.
  // Pushes are handled concurrently (the server does not wait for closeMergedTickets), so two events can see the same revert before either has
  // recorded a step: the first one in flight does the work, a second one for the same merge returns at once (false), and a step that failed is
  // left for a later push, as before.
  async revertMerged(repository: string, revert: Json, number: number): Promise<boolean> {
    const key = repository.toLowerCase() + '#' + number;
    if (this.revertsInFlight.has(key)) return false;
    this.revertsInFlight.add(key);
    try {
      return await this.revertMergedNow(repository, revert, number);
    } finally {
      this.revertsInFlight.delete(key);
    }
  }

  private async revertMergedNow(repository: string, revert: Json, number: number): Promise<boolean> {
    const record = this.revertOf(repository, number) ?? await this.recoverRevert(repository, number);
    if (!record || record.state === 'handled' || !this.host.config.forgejo) return false;
    const name = repository.toLowerCase();
    const ticket = record.issue;
    const branch = revert.base?.ref || 'the default branch';
    record.revert = Number(revert.number);
    record.state = 'merged';
    if (!record.reopened) {
      try {
        await this.host.forge.reopenIssue(repository, ticket);
        record.reopened = true;
      } catch (error) {
        this.host.logger.error('could not reopen #' + ticket + ' of ' + repository + ' after its revert #' + revert.number + ', trying again on the next push:', error.message);
        return false;
      }
    }
    if (!record.commented) {
      let body = '';
      try { body = String((await this.host.forge.getPull(repository, Number(revert.number)))?.body || ''); } catch (error) { this.host.logger.error('could not read #' + revert.number + ':', error.message); }
      const cause = redact(body.slice(0, 1200), this.host.secretValues()).trim();
      const quoted = (cause || 'The revert pull request has no text: read the failed run of the default branch.').split('\n').map((line) => '> ' + line).join('\n');
      try {
        await this.host.forge.addComment(repository, ticket, 'ForgeHands: the merge of #' + record.number + ' turned the CI of ' + branch + ' red (commit ' + record.sha.slice(0, 8)
          + '); it was reverted by #' + revert.number + '. Fix the cause, do not repeat the change that broke it. Cause as the revert run found it:\n\n' + quoted, 'issue');
        record.commented = true;
      } catch (error) {
        this.host.logger.error('could not comment on #' + ticket + ' after its revert:', error.message);
        return false;
      }
    }
    const used = this.host.jobs.reverts.filter((entry) => entry !== record && entry.repository === name && entry.issue === ticket && entry.restarted).length;
    if (!record.restarted && !record.blocked) {
      if (used < this.host.config.revertRetries) {
        const label = this.host.lastRunLabel(name, ticket);
        if (!label) { this.host.logger.error(name + '#' + ticket + ': no run of the ticket to start again after its revert, nothing started'); await this.markNeededHuman(repository, record.number); }
        else {
          try {
            const issue = await this.host.forge.getIssue(repository, ticket);
            const result = await this.host.enqueueOne({ type: 'issues.labeled', source: this.host.forge.kind, action: 'revert_retry', label, revert_retry: true,
              repository: { full_name: repository, clone_url: null, html_url: null, default_branch: revert.base?.repo?.default_branch || null },
              issue: { number: ticket, title: String(issue?.title || '').slice(0, 1000), body: String(issue?.body || '').slice(0, 50000), html_url: issue?.html_url || null, comments: 0, labels: [label] },
              sender: { login: null } });
            if (result.status === 'queued' || result.status === 'waiting' || result.status === 'duplicate_job') {
              record.restarted = true;
              metrics.inc('forgehands_revert_retries_total');
              this.host.logger.error(repository + '#' + ticket + ': reverted by #' + revert.number + ', running ' + label + ' again');
            }
          } catch (error) {
            this.host.logger.error('could not start ' + name + '#' + ticket + ' again after its revert:', error.message);
            return false;
          }
        }
      } else {
        try {
          const blocked = await this.host.forge.findOrCreateLabel(repository, this.host.config.blockedLabel, '#b60205');
          await this.host.forge.addLabels(repository, ticket, [blocked], 'issue');
          await this.host.forge.addComment(repository, ticket, mentionOf(this.host.config) + 'ForgeHands: the merge of #' + record.number + ' turned the CI red again and was reverted by #'
            + revert.number + '. The ticket was started again ' + used + ' times already (REVERT_RETRIES=' + this.host.config.revertRetries + '). It is blocked (' + this.host.config.blockedLabel + '): a human has to look at it.', 'issue');
          this.host.tell('blocked', { repository: { full_name: repository, clone_url: null, html_url: null, default_branch: branch }, type: 'ci.main_failure', source: this.host.forge.kind,
            sender: { login: null }, issue: { number: ticket, title: '', body: '', html_url: null, comments: 0, labels: [] } }, { why: 'revert_retries' });
          record.blocked = true;
          await this.markNeededHuman(repository, record.number);
        } catch (error) {
          this.host.logger.error('could not block #' + ticket + ' after its revert:', error.message);
          return false;
        }
      }
    }
    record.state = 'handled';
    try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
    return true;
  }

  // REVERT_ON_RED: a CI run failed on the default branch for a commit that ForgeHands merged (the ledger knows it, see Merger.recordMerge). Once per
  // commit: the merged pull request is told, the human is told at once, and a route of kind main_red (when one exists) starts a run that reverts
  // the merge in a pull request ai/revert-<n>. Without that route the human is called on the pull request. A red revert only tells the human: no
  // revert of a revert. A failure outside the window or of a commit ForgeHands did not merge does nothing.
  async onMainFailure(event: ForgeEvent): Promise<{ status: string }> {
    if (!this.host.config.revertOnRed) return { status: 'revert_off' };
    if (!this.host.config.forgejo) return { status: 'no_forgejo_access' };
    const repository = event.repository.full_name;
    const sha = event.ci!.commit_sha.toLowerCase();
    const merge = this.host.jobs.merges.find((entry) => entry.repository === repository.toLowerCase() && entry.sha?.toLowerCase() === sha);
    if (!merge) return { status: 'not_our_merge' };
    if (this.host.now() - merge.merged_at > this.host.config.revertWindowMinutes * 60000) return { status: 'outside_window' };
    if (await this.host.commitRecovered(event)) return { status: 'ci_not_red' };
    const key = 'main_red:' + repository.toLowerCase() + '@' + sha;
    if (this.host.jobs.noted(key)) return { status: 'duplicate' };
    this.host.jobs.note(key, this.host.now());
    try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
    const number = merge.number;
    const short = sha.slice(0, 8);
    const branch = event.repository.default_branch || 'the default branch';
    let title = '';
    let pull: Json | undefined;
    try { pull = await this.host.forge.getPull(repository, number); title = String(pull?.title || ''); } catch (error) { this.host.logger.error('could not read #' + number + ':', error.message); }
    // The branch of the merged pull request: the ledger's name, unless it holds a pull request ref (refs/pull/<n>/head, as Forgejo reports a merged
    // pull request whose branch is deleted); then the pull request itself names the branch.
    const head = isPullRef(merge.branch) ? pullBranch(pull) || merge.branch : merge.branch;
    // The pull request as the notice names it: the merged one, or the revert that went red (whose merge was a revert).
    const told = { ...event, issue: { ...event.issue, number, title: title.slice(0, 1000), html_url: null }, pull_request: { number, head_ref: head, html_url: null } };
    if (REVERT_BRANCH.test(head)) {
      // The revert went red: the merge it undid stays undone by a human, not by ForgeHands.
      await this.markNeededHuman(repository, Number(/\d+$/.exec(head)![0]));
      this.host.tell('failed', told, { why: 'revert_red' });
      return { status: 'revert_red_told' };
    }
    // A red check that was already red on the commit before the merge (or cannot be compared with it) is not this merge's doing: no revert.
    const cause = await this.preExistingFailure(event, repository, sha);
    if (cause.verdict === 'recovered') {
      // Green on the second read: nothing to do. The key is dropped, so a red run of this commit that comes again is judged again.
      this.host.jobs.dedupe.delete(key);
      try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
      return { status: 'ci_not_red' };
    }
    if (cause.verdict === 'pre_existing') {
      merge.pre_existing = true;
      try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
      this.host.tell('failed', told, { why: 'pre_existing' });
      const checks = cause.checks.length ? ' (' + cause.checks.map((name) => name.slice(0, 200)).join(', ') + ')' : '';
      try {
        await this.host.forge.addComment(repository, number, 'ForgeHands: CI failed on ' + branch + ' after this merge (commit ' + short + '), but it already failed on the commit before it'
          + ' (' + String(cause.parent).slice(0, 8) + ')' + checks + '. A pre-existing failure: no revert is started.');
      } catch (error) {
        this.host.logger.error('could not comment on #' + number + ':', error.message);
      }
      return { status: 'pre_existing' };
    }
    if (cause.verdict === 'unknown') {
      // Without the commit before the merge a revert could undo a change that was not at fault: the human decides.
      this.host.tell('failed', told, { why: 'unknown_cause' });
      try {
        await this.host.forge.addComment(repository, number, mentionOf(this.host.config) + 'ForgeHands: CI failed on ' + branch + ' after this merge (commit ' + short + '), and the commit before it'
          + ' could not be read, so it is not known whether this merge caused it. No revert is started. A human has to look at it.');
      } catch (error) {
        this.host.logger.error('could not comment on #' + number + ':', error.message);
      }
      await this.markNeededHuman(repository, number);
      return { status: 'unknown_cause' };
    }
    // RERUN_TIMEOUT_MINUTES: the failed run is rerun once before a revert (a failure that was green before the merge may be flaky).
    let rerunNote = '';
    if (cause.verdict === 'regression' && this.host.config.rerunTimeoutMinutes) {
      const rerun = await this.rerunBeforeRevert(event, repository, sha, number);
      if ('status' in rerun) return { status: 'rerun_started' };
      if (rerun.state === 'green') return { status: 'ci_not_red' };
      rerunNote = ' ' + RERUN_NOTE[rerun.state];
    }
    const route = [...this.host.config.routes].find(([, entry]) => entry.kind === 'main_red')?.[0];
    this.host.tell('failed', told, { why: 'main_red' });
    try {
      await this.host.forge.addComment(repository, number, (route ? '' : mentionOf(this.host.config)) + 'ForgeHands: CI failed on ' + branch + ' after this merge (commit ' + short + ').'
        + (route ? ' A revert is started.' : ' A human has to look at it.') + rerunNote);
    } catch (error) {
      this.host.logger.error('could not comment on #' + number + ':', error.message);
    }
    if (!route) {
      await this.markNeededHuman(repository, number);
      return { status: 'handed_to_human' };
    }
    // REVERT_RETRIES: the revert of an agent's merge is recorded, so that its merged revert can reopen and restart the ticket (see revertMerged).
    const ticket = /^ai\/issue-(\d+)$/.exec(head);
    const record = this.host.config.revertRetries && ticket ? { repository: repository.toLowerCase(), number, issue: Number(ticket[1]), sha, state: 'started' as const, at: this.host.now() } : null;
    if (record) this.host.jobs.reverts.push(record);
    const job = this.host.jobs.add({ key: repository.toLowerCase() + '!pr' + number + ':' + route + ':' + short, label: route, status: 'queued', created: this.host.now(),
      event: { type: 'ci.main_failure', source: this.host.forge.kind, action: 'main_red', label: route, repository: event.repository,
        issue: { number, title: title.slice(0, 1000), body: '', html_url: null, comments: 0, labels: [] }, ci: event.ci, sender: event.sender } });
    try {
      await this.host.jobs.persist(this.host.now());
    } catch (error) {
      this.host.jobs.remove(job.id); // not durable: the retried delivery must be able to start it again
      this.host.jobs.dedupe.delete(key);
      if (record) this.host.jobs.reverts.splice(this.host.jobs.reverts.indexOf(record), 1);
      throw error;
    }
    this.host.tick().catch((error) => this.host.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
  }

  // RERUN_TIMEOUT_MINUTES: a red default branch that was green before the merge gets one rerun of its failed run, once per commit (the ledger's
  // reruns). The run is rerun and the event waits (checkReruns resumes it when the run has finished or the time is up). When no rerun can be
  // started, the caller reverts as it did before reruns existed, and says so in its comment.
  async rerunBeforeRevert(event: ForgeEvent, repository: string, sha: string, number: number): Promise<{ status: 'started' } | { state: 'red' | 'timeout' | 'unavailable' | 'green' }> {
    const name = repository.toLowerCase();
    const known = this.host.jobs.reruns.find((entry) => entry.repository === name && entry.sha === sha);
    if (known) return known.state === 'running' ? { status: 'started' } : { state: known.state as 'red' | 'timeout' | 'unavailable' | 'green' };
    const runId = event.ci?.run_id ?? null;
    const record: RerunRecord = { repository: name, number, sha, run_id: runId, at: this.host.now(), state: 'running', event };
    if (runId === null || !this.host.forge.rerunRun) record.state = 'unavailable';
    else {
      try { await this.host.forge.rerunRun(repository, runId); } catch (error) {
        this.host.logger.error('could not rerun run ' + runId + ' of ' + repository + ':', error.message);
        record.state = 'unavailable';
      }
    }
    this.host.jobs.reruns.push(record);
    try { await this.host.jobs.persist(this.host.now()); } catch (error) { this.host.logger.error('persist failed:', error.message); }
    if (record.state === 'running') return { status: 'started' };
    return { state: record.state as 'unavailable' };
  }

  // The reruns that run (RERUN_TIMEOUT_MINUTES): a finished run resumes its red default branch event. Green ends it with no revert; red or
  // timeout reverts, once. The commit's key is dropped first, so the event is judged again. A run the forge cannot read is looked at again.
  async checkReruns(now: number): Promise<boolean> {
    const limit = this.host.config.rerunTimeoutMinutes * 60000;
    let changed = false;
    for (const record of this.host.jobs.reruns.filter((entry) => entry.state === 'running')) {
      const repository = record.event.repository.full_name;
      let state: RerunRecord['state'] | null = null;
      if (now - record.at > limit) state = 'timeout';
      else {
        try {
          const status = await this.host.forge.runStatus?.(repository, record.run_id as number | string);
          if (status && !RUN_UNFINISHED.has(status)) state = status === 'success' ? 'green' : 'red';
        } catch (error) {
          this.host.logger.error('could not read run ' + record.run_id + ' of ' + repository + ':', error.message);
        }
      }
      if (!state) continue;
      record.state = state;
      changed = true;
      this.host.jobs.dedupe.delete('main_red:' + record.repository + '@' + record.sha);
      try { await this.onMainFailure(record.event); } catch (error) { this.host.logger.error('rerun outcome failed:', error.message); }
    }
    return changed;
  }

  // REVERT_ON_RED, the first-parent check: a red default branch is this merge's doing only when a check that is red on the merge commit was green
  // on the commit before it (its first parent). A check that was red there too, or is not reported there, is pre-existing. The commit is read
  // once more first: green then (a re-run that passed) is recovered. A parent that cannot be read gives unknown, and nothing is reverted.
  async preExistingFailure(event: ForgeEvent, repository: string, sha: string): Promise<PreExisting> {
    const unknown: PreExisting = { verdict: 'unknown', checks: [] };
    let current: CommitStatus;
    try {
      current = await this.host.forge.commitStatus(repository, sha);
    } catch (error) {
      this.host.logger.error('commit status failed:', error.message);
      return unknown;
    }
    if (current?.state === 'pending' || current?.state === 'success') return { verdict: 'recovered', checks: [] };
    if (!this.host.forge.commitParents) return unknown;
    let before: CommitStatus;
    let parent: string;
    try {
      [parent] = await this.host.forge.commitParents(repository, sha);
      if (!parent) return unknown;
      before = await this.host.forge.commitStatus(repository, parent);
    } catch (error) {
      this.host.logger.error('could not read the commit before ' + sha.slice(0, 8) + ':', error.message);
      return unknown;
    }
    // The state of one check on a commit; without the per-check list the combined state stands for every check.
    const stateOf = (status: CommitStatus, context: string | undefined): string | undefined => status.statuses?.length
      ? status.statuses.find((check) => check.context === context)?.status ?? status.statuses.find((check) => check.context === context)?.state
      : status.state;
    const reds = (current?.statuses ?? []).filter((check) => (check.status ?? check.state) === 'failure' || (check.status ?? check.state) === 'error');
    if (!reds.length) return { verdict: before.state === 'success' ? 'regression' : 'pre_existing', parent, checks: [] };
    const checks = reds.map((check) => String(check.context || 'check'));
    const regressed = reds.some((check) => stateOf(before, check.context) === 'success');
    return { verdict: regressed ? 'regression' : 'pre_existing', parent, checks };
  }
}
