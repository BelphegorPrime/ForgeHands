import { createForge, createTransport } from '../forge/index.ts';
import { Merger } from './merge.ts';
import { pullBranch } from './bot.ts';
import { DryLog, isDry, isWrite } from '../dry.ts';
import { Reminder } from './remind.ts';
import { Workspace } from './workspace.ts';
import { LedgerSync } from './ledger-sync.ts';
import { ReviewSweep } from './review-sweep.ts';
import { TicketPreflight } from './preflight.ts';
import { HandbackRouter } from './handback.ts';
import { EpicGaps } from './epic-gaps.ts';
import { ledgerEpics } from './epic-sweep.ts';
import { isOperatorTicket } from './operator.ts';
import type { OperatorEntry } from './operator.ts';
import { RecurringFindings } from './recurring.ts';
import { Notifier, mentionOf, pullUrl } from '../notify/index.ts';
import { collectDigest, collectFixes, digestDue } from '../notify/digest.ts';
import { digestIsEmpty, digestMessage, immediateMessage } from '../notify/texts.ts';
import type { Facts } from '../notify/texts.ts';
import { metrics, known, CLONE_BREAKER_STATES } from '../metrics.ts';
import { CloneBreaker } from './clone-breaker.ts';
import type { CloneFailureReport, CloneTrialOutcome } from './clone-breaker.ts';
import { isBotPull } from './bot.ts';
import type { BranchPushEvent, CloneBreakerState, DirectConfig, Route, Fetch, ForgeEvent, Job, Json, Logger, NormalizedEvent, PushEvent } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../forge/index.ts';
import type { Issue } from '../types/forge.ts';
import { Nudger } from './nudge.ts';
import { ROUND_KINDS, ACTIVE_STATUSES } from './run-states.ts';
import { WaitKeeper } from './wait-keeper.ts';
import { RevertKeeper } from './revert-keeper.ts';
import { BranchRefresher } from './branch-refresh.ts';
import { SecurityReview } from './security-review.ts';
import { DeliveryCheck } from './delivery.ts';
import { TicketCleanup } from './ticket-cleanup.ts';
import { IdleReporter } from './idle.ts';
import { RunWatcher } from './run-watcher.ts';
import { Scheduler } from './scheduler.ts';
export { conversationCost, tokenUsage } from './run-states.ts';


// Starts OpenHands conversations for queued issues and keeps the load inside the configured limits.
export class Dispatcher {
  config: DirectConfig;
  jobs: JobStore;
  send: Fetch;
  logger: Logger;
  now: () => number;
  current: Promise<void> | null = null;
  timer: NodeJS.Timeout | undefined;
  merger: Merger;
  forge: Forge;
  transport: ReturnType<typeof createTransport>;
  dry: DryLog;
  reminder: Reminder;
  notifier: Notifier;
  /** The workspace cleanup and the disk guard (WORKSPACE_CLEANUP_DIR); off unless that is set. */
  workspace: Workspace;
  /** Closes the tickets the forge has closed (LEDGER_SYNC_HOURS); off unless that is set. */
  ledgerSync: LedgerSync;
  /** The ticket pre-flight (TICKET_PREFLIGHT): a worker's ticket that breaks a rule starts no run. See src/agent/preflight.ts. */
  preflight: TicketPreflight;
  /** Hand-backs: a worker run that hands its ticket back by a comment is run again, escalated or sent to the planner. See src/agent/handback.ts. */
  handback: HandbackRouter;
  /** The epic review found the epic open (EPIC_GAP_REPLAN): the planner again, then the human. See src/agent/epic-gaps.ts. */
  epicGaps: EpicGaps;
  /** The reconciler of REVIEW_SWEEP_MINUTES: starts the review of a head that has none in the ledger. */
  sweep: ReviewSweep;
  /** RECURRING_REASON_MIN: counts the NOT OK points of the changes rounds and files a check ticket for a recurring one. See src/agent/recurring.ts. */
  recurring: RecurringFindings;
  /** The digest of this local date is done (sent, or nothing to send) in a dry run, where the ledger is not written. */
  digestDone: string | undefined;
  /** The tickets the end-to-end suite created ("repo#n", lower case): the ticket watchdog leaves them alone (see exemptE2eTicket). */
  e2eTickets = new Set<string>();
  /** When a job last started (a start of this process counts from its start): the stall alert measures the quiet time from it. */
  lastStart: number;
  /** The shared clone breaker: one sandbox outage holds every new start until one successful trial. Hydrated once in the first pass. */
  cloneBreaker: CloneBreaker;
  cloneBreakerHydrated = false;

  nudger: Nudger = new Nudger(this);
  waitKeeper: WaitKeeper = new WaitKeeper(this);
  revertKeeper: RevertKeeper = new RevertKeeper(this);
  branchRefresher: BranchRefresher = new BranchRefresher(this);
  securityReview: SecurityReview = new SecurityReview(this);
  deliveryCheck: DeliveryCheck = new DeliveryCheck(this);
  ticketCleanup: TicketCleanup = new TicketCleanup(this);
  idleReporter: IdleReporter = new IdleReporter(this);
  runWatcher: RunWatcher = new RunWatcher(this);
  scheduler: Scheduler = new Scheduler(this);
  constructor(config: DirectConfig, jobs: JobStore, send: Fetch = fetch, logger: Logger = console, now: () => number = Date.now, notifier?: Notifier) {
    this.config = config;
    this.jobs = jobs;
    this.send = send;
    this.logger = logger;
    this.now = now;
    this.cloneBreaker = new CloneBreaker(jobs, now, logger);
    this.lastStart = now();
    this.dry = new DryLog(logger);
    this.transport = createTransport(config, send, this.dry);
    this.forge = createForge(config, (repository, method, path, body) => this.forgejoCall({ repository: { full_name: repository } }, method, path, body));
    this.merger = new Merger(config, send, logger, undefined, this.dry);
    // The holds of two-key merges live in the ledger and are timed by the dispatch tick (see pass).
    this.merger.ledger = jobs;
    this.merger.now = now;
    this.merger.securityPending = (repository, number, sha) => this.jobs.list(true).some((job) => this.config.routes.get(job.label)?.kind === 'sensitive_review'
      && job.event.repository.full_name.toLowerCase() === repository.toLowerCase() && job.event.pull_request?.number === number && job.event.ci?.commit_sha === sha);
    this.notifier = notifier ?? Notifier.fromConfig(config, send, logger);
    this.merger.notifier = this.notifier;
    this.reminder = new Reminder(config, jobs, send, logger, this.merger, this.dry);
    this.reminder.notifier = this.notifier;
    this.workspace = new Workspace(config, jobs, { logger, now, notifier: this.notifier });
    this.ledgerSync = new LedgerSync(config, jobs, this.forge, logger, (ticket) => this.ticketCleanup.markClosed(ticket), now, (ticket) => this.ticketCleanup.dropDeletedTicket(ticket),
      (repository, number) => this.ticketCleanup.ticketGone(repository, number));
    this.reminder.deleted = (repository, number) => this.ticketCleanup.checkAndDropDeleted(repository, number);
    // The watchdog of STUCK_PR_MINUTES (see ReviewSweep.watchStuck) hands a pull request to a human the same way a round that ran out does.
    this.sweep = new ReviewSweep(config, jobs, this.forge, this.merger, (event) => this.enqueue(event), logger, now, {
      block: (event, text, why) => this.markForHuman(event, text, why),
      rounds: (event) => this.rounds(event),
      exempt: (repository, number) => this.e2eTickets.has(repository.toLowerCase() + '#' + number)
    }, {
      startReview: (event, epic) => this.startEpicReview(event, epic)
    });
    this.merger.note = (ticket, fact) => this.noteTicket(ticket, fact === 'merged' ? { merged_at: this.now(), merged_by: 'agent' } : { blocked_at: this.now() });
    this.preflight = new TicketPreflight({ config, jobs, forge: this.forge, logger, now, tell: (kind, event, facts) => this.tell(kind, event, facts) });
    this.handback = new HandbackRouter({ config, jobs, forge: this.forge, logger, now, tell: (kind, event, facts) => this.tell(kind, event, facts),
      note: (event, patch) => this.noteTicket(this.issueKey(event), patch), secrets: () => this.secretValues() });
    this.epicGaps = new EpicGaps(config, jobs, this.forge, logger, now, {
      hand: (event, text, reason, facts) => this.markForHuman(event, text, reason, facts),
      created: (planner, dependencies) => this.plannerCreated(planner, dependencies),
      isPlanner: (label) => this.isPlannerLabel(label),
      startReview: (event, epic) => this.startEpicReview(event, epic)
    });
    this.recurring = new RecurringFindings(config, jobs, this.forge, logger, now);
  }

  // Facts for the summary on the status page (merged, handed to a human, split), kept on the ticket's newest job. Best effort.
  noteTicket(ticket: string, patch: Parameters<JobStore['noteTicket']>[1]): void {
    if (isDry(this.config, ticket.split(/[#!]/)[0])) return; // nothing really happened in a dry run
    if (this.jobs.noteTicket(ticket, patch)) this.jobs.persist(this.now()).catch((error) => this.logger.error('persist failed:', error.message));
  }

  // The ledger key of the work on an issue; a dependency bot's pull request has no issue and is kept per pull request ("repo!pr<n>").
  issueKey(event: ForgeEvent): string {
    return event.repository.full_name.toLowerCase() + (event.bot ? '!pr' + event.pull_request!.number : '#' + event.issue.number);
  }

  // Follow-up rounds allowed on the work of this event: MAX_ROUNDS per issue, BOT_FIX_ROUNDS per bot pull request.
  roundLimit(event: ForgeEvent): number {
    return event.bot ? this.config.botFixRounds : this.config.maxRounds;
  }

  static labelsOf(payload: Json, allowedRepos: Set<string>): { key: string; labels: string[] } | null {
    const name = payload?.repository?.full_name;
    // A pull request has its own labels, kept under its own key.
    const pull = payload?.pull_request && !payload?.issue;
    const subject = pull ? payload.pull_request : payload?.issue;
    const number = subject?.number;
    if (typeof name !== 'string' || !allowedRepos.has(name.toLowerCase()) || !Number.isSafeInteger(number)) return null;
    if (!Array.isArray(subject.labels)) return null;
    return {
      key: name.toLowerCase() + (pull ? '#pr' : '#') + number,
      labels: subject.labels.map((entry: Json) => typeof entry === 'string' ? entry : entry?.name).filter((value: unknown): value is string => typeof value === 'string')
    };
  }

  // The labels last seen on the issue of this payload (null when unknown). Read only.
  labelsBefore(payload: Json, allowedRepos: Set<string>): string[] | null {
    const seen = Dispatcher.labelsOf(payload, allowedRepos);
    return seen ? this.jobs.getLabels(seen.key) : null;
  }

  // Remember the labels of this payload. Called once an event has been handled, never when handling failed, so that a
  // retried delivery still sees what changed.
  recordLabels(payload: Json, allowedRepos: Set<string>): void {
    const seen = Dispatcher.labelsOf(payload, allowedRepos);
    if (seen && this.jobs.setLabels(seen.key, seen.labels, this.now())) {
      this.jobs.persist(this.now()).catch((error) => this.logger.error('persist failed:', error.message));
    }
  }

  // Which trigger label does this event start a run for? A label change on an existing issue does not say which label
  // was added, so it is the trigger labels that are new compared with the last labels seen on the issue. Without that
  // knowledge it is the first trigger label that never ran.
  pickLabel(event: ForgeEvent): string | undefined {
    if (!event.label_event) return event.label;
    const base = this.issueKey(event);
    const kind = event.pull_request ? 'pull_request' : 'issue';
    const present = [...this.config.routes.keys()].filter((label) => (this.config.routes.get(label)?.kind || 'issue') === kind && event.issue.labels.includes(label));
    const previous = event.previous_labels;
    if (Array.isArray(previous)) return present.find((label) => !previous.includes(label));
    return present.find((label) => !this.jobs.list().some((job) => job.key === base + ':' + label));
  }

  // The human acted on a pull request (set a label, pushed a commit: the CI run of his commit names him as sender): the follow-up rounds
  // so far no longer count, the pull request starts with a fresh budget, and a block set for used-up rounds comes off. Best effort.
  async humanTookOver(event: ForgeEvent): Promise<void> {
    const login = this.config.humanLogin?.toLowerCase();
    if (!login || !event.pull_request || event.sender?.login?.toLowerCase() !== login) return;
    const base = this.issueKey(event) + ':';
    const spent = this.jobs.list().filter((job) => job.key.startsWith(base) && !job.round_reset && ROUND_KINDS.has(this.config.routes.get(job.label)?.kind));
    if (spent.length) {
      for (const job of spent) job.round_reset = true;
      await this.jobs.persist(this.now());
      this.logger.error(this.issueKey(event) + ': ' + login + ' acted on the pull request, the rounds start again');
    }
    // The block (BLOCKED_LABEL) has other causes than used-up rounds too (a review that ended twice without a verdict, an approval that was not
    // trusted, a failed run): none of them outlasts the human looking at the pull request, and a merge refuses while the label is on.
    if (!this.config.forgejo) return;
    try {
      const repository = event.repository.full_name;
      const labels = await this.forge.labelsOf(repository, event.pull_request.number);
      const blocked = (labels || []).find((label) => label.name === this.config.blockedLabel);
      if (blocked) await this.forge.removeLabel(repository, event.pull_request.number, blocked);
    } catch (error) {
      this.logger.error('could not lift the block of #' + event.pull_request.number + ':', error.message);
    }
  }

  // A green commit starts every review route (on: ci_success), once per commit each: a second reviewer is a second route. The event names
  // the first one; the others are the same event under their own label.
  async enqueue(event: ForgeEvent): Promise<{ status: string }> {
    // An operator ticket starts no run, whatever route label it also carries (see agent/operator.ts).
    if (isOperatorTicket(event, this.config)) return this.onOperatorTicket(event);
    if (event.type === 'ci.main_failure') return this.revertKeeper.onMainFailure(event);
    if (event.type !== 'ci.success') {
      const result = await this.enqueueOne(event);
      // An approval label on a pull request that did not start the merge (the event was taken for a round, or it was a duplicate): said once, so that
      // a silent drop shows in the log and on the status page. A label change that adds the approval reaches approve() (see normalizePullRequest).
      if (event.type === 'pull_request.labeled' && event.pull_request && !event.ci && event.issue.labels.includes(this.config.approvedLabel)) {
        this.merger.report(event.repository.full_name, event.pull_request.number, result.status === 'queued' ? 'round_started' : result.status, null);
      }
      return result;
    }
    const labels = [...this.config.routes].filter(([, entry]) => entry.kind === 'ci_success').map(([label]) => label);
    const results: { status: string }[] = [];
    for (const label of labels) results.push(await this.enqueueOne({ ...event, label }));
    return results.find((result) => result.status === 'queued') ?? results.find((result) => result.status === 'deferred') ?? results[0] ?? { status: 'duplicate_job' };
  }

  // REVIEW_WITHOUT_CI: a commit arrived on a branch (a push, or a pull request opened or updated). When it is the head of an open pull request of
  // an agent or a listed bot, in a repository that has no CI at that commit, no CI run will ever report, so the review starts as a green run
  // would have: the same event, the same key per commit, the same security review. Anything unclear (the forge cannot be read, the pull request
  // is gone or has moved on) starts nothing; the next event tries again.
  async onBranchPush(event: BranchPushEvent): Promise<string> {
    if (!this.config.reviewWithoutCi || !this.config.forgejo) return 'review_without_ci_off';
    const label = [...this.config.routes].find(([, route]) => route.kind === 'ci_success')?.[0];
    if (!label) return 'no_review_route';
    const repository = event.repository.full_name;
    let pr: Json;
    try {
      if (event.pull_request) pr = await this.forge.getPull(repository, event.pull_request);
      else pr = (await this.forge.listPulls(repository, { state: 'open', limit: 50 })).find((entry: Json) => pullBranch(entry) === event.branch && entry.state === 'open');
    } catch (error) {
      this.logger.error('could not look for the pull request of ' + repository + ' ' + event.branch + ':', error.message);
      return 'pull_unreadable';
    }
    if (!pr || pr.state !== 'open' || pr.merged || pullBranch(pr) !== event.branch) return 'no_open_pull';
    if (pr.head?.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return 'not_an_agent_branch';
    const bot = isBotPull({ authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos }, pr, repository);
    const match = /^ai\/issue-(\d+)$/.exec(pullBranch(pr));
    if (!bot && !match) return 'not_an_agent_branch';
    // As for a CI outcome: an agent's commit counts only from a sender who may trigger runs; a bot is let in by BOT_AUTHORS.
    if (!bot && this.config.allowedSenders && !this.config.allowedSenders.has(String(event.sender.login || '').toLowerCase())) return 'sender_not_allowed';
    const sha: string = pr.head.sha;
    // The head of the pull request is read from the forge; an event for another commit is older or newer news and says nothing about it.
    if (typeof sha !== 'string' || sha.toLowerCase() !== event.after.toLowerCase()) return 'stale_push';
    try {
      const status = await this.forge.commitStatus(repository, sha);
      if (status?.total_count > 0) return 'ci_expected';
    } catch (error) {
      this.logger.error('commit status failed:', error.message);
      return 'ci_unknown';
    }
    if (!(await this.merger.noWorkflows(repository, sha))) return 'ci_expected';
    const number = pr.number;
    const issue = { number: bot ? number : Number(match![1]), title: String(pr.title || '').slice(0, 1000), body: String(pr.body || '').slice(0, 50000),
      html_url: pr.html_url || null, comments: Number.isSafeInteger(pr.comments) && pr.comments > 0 ? pr.comments : 0, labels: [] as string[] };
    const ci: ForgeEvent = {
      type: 'ci.success', source: this.forge.kind, action: 'no_ci', ...(bot ? { bot: true } : {}), label,
      repository: event.repository, issue, pull_request: { number, head_ref: pullBranch(pr), html_url: pr.html_url || null },
      ci: { run_id: null, workflow: '', commit_sha: sha, status: 'no_ci', html_url: null }, sender: event.sender
    };
    const result = await this.enqueue(ci);
    // One line per commit that started something; a duplicate (the push and the pull request event of one commit) says nothing more.
    if (result.status === 'queued' || result.status === 'deferred') this.logger.error(repository + '#' + number + ': no CI in ' + repository + ', reviewing ' + sha.slice(0, 7) + ' without it');
    return result.status;
  }

  // A native review (VERDICT_SOURCE review or both) arrived. An approval asks the merger to look at the reviews of the head commit; the merger
  // decides, so the event itself is only a trigger. A rejection starts the next round, once the reviews of the head commit say so too: a
  // review of somebody who may not request changes (a stranger, an outdated commit) starts nothing.
  async onReview(event: ForgeEvent, approved: boolean): Promise<string> {
    // The review of HUMAN_LOGIN in comment mode (see onHumanReview). Nobody else's review is an event in comment mode.
    if (event.review?.human) return this.onHumanReview(event);
    if (event.type === 'pull_request.review_comment') return 'ignored_review';
    if (approved) return this.merger.handle(event);
    if (!this.config.forgejo || !event.pull_request) return 'no_forgejo_access';
    const repository = event.repository.full_name;
    try {
      const pr = await this.forge.getPull(repository, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      const review = await this.merger.reviewOf(repository, event.pull_request.number, pr.head.sha);
      if (review.reason !== 'changes_requested') return 'ignored_review';
    } catch (error) {
      this.logger.error('could not check the review of #' + event.pull_request.number + ':', error.message);
      return 'review_unreadable';
    }
    return this.startChangesRound(event);
  }

  // The changes round of a pull request, as the changes label starts it. A bot's pull request gets none without BOT_FIX_ROUNDS: a human is called.
  async startChangesRound(event: ForgeEvent): Promise<string> {
    // No worker fixes a bot's pull request (BOT_FIX_ROUNDS is 0): a human has to look at it.
    if (event.bot && !this.config.botFixRounds) {
      await this.markForHuman(event, 'ForgeHands: a review asks for changes to this dependency update, and no worker fixes bot pull requests. A human has to look at it.', 'bot_pull_request');
      return 'handed_to_human';
    }
    if (!this.config.routes.get(this.config.changesLabel) || this.config.routes.get(this.config.changesLabel)!.kind !== 'pull_request') return 'no_round_route';
    // The NOT OK points of this round count towards RECURRING_REASON_MIN (off by default; best effort, it never blocks the round).
    if (!event.bot && event.pull_request) await this.recurring.observe(event.repository.full_name, event.pull_request.number);
    return (await this.enqueueOne({ ...event, label: this.config.changesLabel })).status;
  }

  // In comment mode a review of HUMAN_LOGIN on an agent pull request (see normalizeReview). His request for changes on the
  // head commit starts the changes round, as the changes label does (humanTookOver applies: his action starts the rounds again). An approval or a
  // comment starts nothing and merges nothing: the merge stays driven by the label and the verdict. Anything unclear starts nothing.
  async onHumanReview(event: ForgeEvent): Promise<string> {
    if (event.type !== 'pull_request.review_rejected') return 'human_review_no_round';
    if (!this.config.forgejo || !event.pull_request) return 'no_forgejo_access';
    const repository = event.repository.full_name;
    const number = event.pull_request.number;
    const human = String(this.config.humanLogin || '').toLowerCase();
    let sha: string;
    try {
      const pr = await this.forge.getPull(repository, number);
      if (!pr || pr.state !== 'open' || pr.merged) return 'not_open';
      sha = pr.head.sha;
      // Only his request on the head commit counts: a review of an older commit, or one he has since replaced, says nothing about the head.
      if (!(await this.merger.nativeReviews(repository, number, sha)).changes.includes(human)) return 'ignored_review';
    } catch (error) {
      this.logger.error('could not check the review of #' + number + ':', error.message);
      return 'review_unreadable';
    }
    const review = { ...event.review, reviewer: event.review?.reviewer ?? null, commit: sha };
    // One round per review and head commit: the same review again (a redelivery under another delivery id) starts nothing. The ledger keeps it.
    const base = this.issueKey(event) + ':';
    if (this.jobs.list().some((job) => job.key.startsWith(base) && job.event.review?.human === true && job.event.review.id === review.id && job.event.review.commit === sha)) return 'duplicate_review';
    // The approval was given for a commit that is now rejected: it comes off (best effort; the next green commit is reviewed again as usual).
    try {
      const approved = ((await this.forge.labelsOf(repository, number)) || []).find((label) => label.name === this.config.approvedLabel);
      if (approved) {
        await this.forge.removeLabel(repository, number, approved);
        this.logger.error(this.issueKey(event) + ': ' + human + ' asked for changes, ' + this.config.approvedLabel + ' is taken off');
      }
    } catch (error) {
      this.logger.error('could not take ' + this.config.approvedLabel + ' off #' + number + ':', error.message);
    }
    return this.startChangesRound({ ...event, review });
  }

  // A comment of HUMAN_LOGIN on an open issue starts the last run of that issue again when that run failed or was handed to the human. The label of
  // that run starts again exactly as if it had just been added (enqueueOne: quota fallback, tiers, same-files and dependency waits all apply). Only
  // the latest run of the issue counts, and only when no run of it is active and the label is still on the issue. At most COMMENT_RESTARTS
  // restarts per issue and label; then one notice on the issue and nothing more. A comment starts at most one run (its id is kept in the ledger).
  async onComment(event: ForgeEvent): Promise<string> {
    const human = this.config.humanLogin?.toLowerCase();
    if (!human || !event.comment || (!this.config.commentRestarts && !this.config.planAnswerRestarts)) return 'comment_restarts_off';
    if (String(event.comment.login || '').toLowerCase() !== human) return 'not_the_human';
    if (!this.config.forgejo) return 'no_forgejo_access';
    const repository = event.repository.full_name;
    const ticket = this.issueKey(event);
    const commentKey = 'comment:' + ticket + '#' + event.comment.id;
    if (this.jobs.noted(commentKey)) return 'duplicate_comment';
    // The runs of the issue itself: a worker or planner label (kind issue). Round, review and epic runs are not restarted by a comment.
    const runs = this.jobs.list().filter((job) => job.key.startsWith(ticket + ':') && this.config.routes.get(job.label)?.kind === 'issue');
    if (runs.some((job) => ACTIVE_STATUSES.has(job.status))) return 'run_active';
    const latest = runs.at(-1);
    // The run that ended last must have failed (any result) or been handed to the human; otherwise the comment may answer a planner (see planAnswer).
    if (!latest || (latest.status !== 'failed' && !latest.blocked_at)) return this.planAnswer(event, runs, commentKey);
    if (!this.config.commentRestarts) return 'comment_restarts_off';
    // Only now the forge is asked: the issue must be open and still carry the label of that run.
    let issue: Json;
    try {
      issue = await this.forge.getIssue(repository, event.issue.number);
    } catch (error) {
      this.logger.error('could not read #' + event.issue.number + ' after a comment:', error.message);
      return 'issue_unreadable';
    }
    if (!issue || issue.state !== 'open' || issue.pull_request) return 'not_open';
    const labels: string[] = (Array.isArray(issue.labels) ? issue.labels : []).map((label: Json) => label?.name).filter((name: unknown): name is string => typeof name === 'string');
    const label = latest.label;
    if (!labels.includes(label)) return 'label_gone';
    const now = this.now();
    const restarts = runs.filter((job) => job.label === label && job.event?.comment).length;
    if (restarts >= this.config.commentRestarts) {
      const noticeKey = 'limit:' + ticket + ':' + label;
      if (!this.jobs.noted(noticeKey)) {
        try {
          await this.commentLimit(event, label, restarts);
        } catch (error) {
          this.logger.error('could not write the notice of ' + ticket + ':', error.message);
          return 'notice_failed';
        }
        this.jobs.note(noticeKey, now);
      }
      this.jobs.note(commentKey, now);
      await this.jobs.persist(now);
      return 'restarts_used_up';
    }
    const result = await this.enqueueOne({ ...event, type: 'issues.labeled', label, issue: { ...event.issue, labels } });
    if (result.status !== 'queued' && result.status !== 'waiting') return result.status;
    this.jobs.note(commentKey, now);
    await this.jobs.persist(now);
    metrics.inc('forgehands_comment_restarts_total');
    this.logger.error(repository + '#' + event.issue.number + ': ' + event.comment.login + ' commented, running ' + label + ' again');
    return result.status;
  }

  // A planner label: SPLIT_LABEL or an EPIC_LABEL with a route of kind issue (the planner's run). ai:close has no route, so it is none.
  isPlannerLabel(label: string): boolean {
    return this.config.routes.get(label)?.kind === 'issue' && (label === this.config.splitLabel || this.config.epicLabels.has(label));
  }

  // PLAN_ANSWER_RESTARTS: a planner that finished without sub-issues asked the operator questions (its prompt says so), and his comment answers
  // them: the planner starts again. Only when the newest run of a planner label is done, the issue is open and still carries that label, and it
  // has created no sub-issues: no dependency of the issue that was not there when the planner run started (Job.deps_before). Issues it blocks say
  // nothing about the planner and never stop an answer (see plannerCreated). A planner that is still running is not restarted (the active check in
  // onComment); an unreadable forge or an unclear answer means nothing happens. Once per comment, and at most N times per ticket and label, then one
  // notice on the issue. An answer that starts nothing after a finished planner is logged and counted (ignoredAnswer).
  async planAnswer(event: ForgeEvent, runs: Job[], commentKey: string): Promise<string> {
    const limit = this.config.planAnswerRestarts;
    if (!limit) return 'plan_answers_off';
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const ticket = this.issueKey(event);
    const planner = runs.filter((job) => this.isPlannerLabel(job.label));
    const last = planner.at(-1);
    const label = last?.label;
    // No finished planner is the answer a comment has always got when nothing failed ('no_failed_run').
    if (!label || last!.status !== 'done') return 'no_failed_run';
    let issue: Json; let dependencies: unknown;
    try {
      issue = await this.forge.getIssue(repository, number);
      dependencies = await this.forge.dependencies(repository, number);
    } catch (error) {
      this.logger.error('could not read #' + number + ' after a comment, not restarting its plan:', error.message);
      return this.ignoredAnswer(event, 'issue_unreadable');
    }
    if (!issue || issue.state !== 'open' || issue.pull_request) return this.ignoredAnswer(event, 'not_open');
    const labels: string[] = (Array.isArray(issue.labels) ? issue.labels : []).map((entry: Json) => entry?.name).filter((name: unknown): name is string => typeof name === 'string');
    if (!labels.includes(label)) return this.ignoredAnswer(event, 'label_gone');
    // A read that does not give a list is unknown, and unknown means nothing happens.
    if (!Array.isArray(dependencies)) return this.ignoredAnswer(event, 'links_unknown');
    if (this.plannerCreated(last!, dependencies).length) return this.ignoredAnswer(event, 'has_sub_issues');
    const now = this.now();
    const restarts = planner.filter((job) => job.label === label && job.event?.plan_answer).length;
    if (restarts >= limit) {
      const noticeKey = 'planlimit:' + ticket + ':' + label;
      if (!this.jobs.noted(noticeKey)) {
        try {
          await this.planLimit(event, label, restarts);
        } catch (error) {
          this.logger.error('could not write the notice of ' + ticket + ':', error.message);
          return 'notice_failed';
        }
        this.jobs.note(noticeKey, now);
      }
      this.jobs.note(commentKey, now);
      await this.jobs.persist(now);
      return this.ignoredAnswer(event, 'plan_answers_used_up');
    }
    // The comment is the trigger, not part of the run: the COMMENT_RESTARTS line and its count do not apply to it.
    const { comment: answer, ...rest } = event;
    const result = await this.enqueueOne({ ...rest, type: 'issues.commented', label, plan_answer: true, issue: { ...event.issue, labels } });
    if (result.status !== 'queued' && result.status !== 'waiting') return result.status;
    this.jobs.note(commentKey, now);
    await this.jobs.persist(now);
    metrics.inc('forgehands_plan_answer_restarts_total');
    this.logger.error(repository + '#' + number + ': ' + answer!.login + ' commented on a plan without sub-issues, running ' + label + ' again');
    return result.status;
  }

  // The sub-issues the planner run created: the dependencies that were not there when it started. A job without the snapshot (before it existed)
  // counts the dependencies created after the run started, when the forge gives their creation time; without one, every dependency counts.
  plannerCreated(planner: Job, dependencies: Json[]): Json[] {
    const before = planner.deps_before;
    if (Array.isArray(before)) return dependencies.filter((issue) => !before.includes(issue?.number));
    const started = planner.started;
    return dependencies.filter((issue) => {
      const created = typeof issue?.created_at === 'string' ? Date.parse(issue.created_at) : NaN;
      if (!started || Number.isNaN(created)) return true;
      return created >= started;
    });
  }

  // An answer that starts nothing is said once in the log and counted (forgehands_comment_ignored_total{reason}), so that a silent ignore is visible.
  ignoredAnswer(event: ForgeEvent, reason: string): string {
    metrics.inc('forgehands_comment_ignored_total', { reason });
    this.logger.error(event.repository.full_name + '#' + event.issue.number + ': ' + event.comment?.login + ' commented, not restarting the plan: ' + reason);
    return reason;
  }

  // The notice that PLAN_ANSWER_RESTARTS is used up: one comment on the issue and a notification, as COMMENT_RESTARTS does.
  // It does not mark the ticket blocked: a blocked newest run is read as a failed one by onComment, and the answers would leave the plan path.
  async planLimit(event: ForgeEvent, label: string, restarts: number): Promise<void> {
    this.tell('blocked', event, { why: 'plan_answer_restarts' });
    await this.forge.addComment(event.repository.full_name, event.issue.number, mentionOf(this.config) + 'ForgeHands: ' + label + ' was started again by answers '
      + restarts + ' times already (PLAN_ANSWER_RESTARTS=' + this.config.planAnswerRestarts + '). Answers start no more runs of it; a human has to look at this issue.', 'issue');
  }

  // The notice that COMMENT_RESTARTS is used up: one comment on the issue, with the hand-over mention rules (HUMAN_MENTION) and a notification.
  async commentLimit(event: ForgeEvent, label: string, restarts: number): Promise<void> {
    metrics.inc('forgehands_blocks_total', { reason: 'comment_restarts' });
    this.noteTicket(this.issueKey(event), { blocked_at: this.now() });
    this.tell('blocked', event, { why: 'comment_restarts' });
    await this.forge.addComment(event.repository.full_name, event.issue.number, mentionOf(this.config) + 'ForgeHands: ' + label + ' was started again by comments ' + restarts
      + ' times already (COMMENT_RESTARTS=' + this.config.commentRestarts + '). Comments start no more runs of it; a human has to look at this issue.', 'issue');
  }

  async enqueueOne(event: ForgeEvent): Promise<{ status: string }> {
    const label = this.pickLabel(event);
    if (!label) return { status: 'duplicate_job' };
    if (!this.config.routes.get(label)) throw new Error('no route for label ' + label);
    await this.humanTookOver(event);
    // A CI outcome belongs to one commit: the same commit starts one run, whatever the outcome of each workflow.
    const key = this.issueKey(event) + ':' + label + (event.ci ? ':' + event.ci.commit_sha.slice(0, 8) : '');
    if (event.ci ? this.jobs.list().some((job) => job.key === key) : this.jobs.activeByKey(key)) return { status: 'duplicate_job' };
    const kind = this.config.routes.get(label)!.kind;
    if (this.config.epicLabels.has(label) && !event.pull_request && !event.ci && !event.plan_answer && !event.revert_retry && event.type.startsWith('issues.')) await this.endOriginalPull(event, label);
    if (event.ci) {
      // While an agent still works on the issue (it will push again) the outcome is not acted on, but kept: it is looked at again
      // when that run ends (see releaseDeferred), because CI often finishes seconds before the agent's last step.
      const base = this.issueKey(event) + ':';
      if (this.jobs.list(true).some((job) => job.key.startsWith(base) && !job.waiting_for_run && !this.parallelReview(job, event))) {
        const deferred = this.jobs.add({ key, label, event: { ...event, label }, status: 'waiting', waiting_for_run: true, created: this.now() });
        try {
          await this.jobs.persist(this.now());
        } catch (error) {
          this.jobs.remove(deferred.id);
          throw error;
        }
        return { status: 'deferred' };
      }
      // A commit that is no longer the head of the pull request says nothing (the run was replaced by a newer push).
      if (await this.isStale(event)) return { status: 'stale_run' };
    }
    if (kind === 'ci_success' && !(await this.commitGreen(event))) return { status: 'ci_not_green' };
    // A run killed from outside is reported as failure; if the commit is pending or green again there is nothing to fix.
    if (kind === 'ci_failure' && (await this.commitRecovered(event))) return { status: 'ci_not_red' };
    if (event.pull_request && ROUND_KINDS.has(kind) && this.rounds(event) >= this.roundLimit(event)) {
      await this.roundsUsedUp(event);
      return { status: 'rounds_exceeded' };
    }
    // A worker's ticket that breaks the pre-flight rules starts no run (src/agent/preflight.ts). Planners and pull requests are not checked.
    if (!event.pull_request && kind === 'issue' && !this.isPlannerLabel(label) && await this.preflight.rejects(event, label)) return { status: 'ticket_rejected' };
    // An issue that depends on open issues waits until the last of them closes (Forgejo's issue dependencies).
    const open = !event.pull_request && kind === 'issue' ? await this.openDependencies(event, event.issue.number) : [];
    const job = this.jobs.add({ key, label, event: { ...event, label }, status: open.length ? 'waiting' : 'queued', ...(open.length ? { waiting_for: open } : {}), created: this.now() });
    try {
      await this.jobs.persist(this.now());
    } catch (error) {
      this.jobs.remove(job.id); // not durable: the retried delivery must be able to enqueue it again
      throw error;
    }
    if (open.length) return { status: 'waiting' };
    // The earlier approval does not cover what this run will push or review.
    if (event.pull_request) await this.merger.clearApproval(event);
    if (kind === 'ci_success') await this.securityReview.startSecurityReview(event);
    this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
  }

  // A ticket labelled OPERATOR_LABEL: no run, and the human is told once, when ForgeHands first sees it.
  async onOperatorTicket(event: ForgeEvent): Promise<{ status: string }> {
    const repository = event.repository.full_name;
    if (this.noteOperator(repository, event.issue.number, event.issue.title ?? '')) {
      await this.jobs.persist(this.now());
      this.tellOperator(repository, event.issue.number, event.issue.title ?? '', event.issue.html_url ?? null);
    }
    return { status: 'operator_prerequisite' };
  }

  // Keeps an operator ticket in the ledger until it is closed. True when it was not known before (the human is told then).
  noteOperator(repository: string, number: number, title: string): boolean {
    const key = repository.toLowerCase() + '#' + number;
    if (this.jobs.operatorTickets.has(key)) return false;
    this.jobs.operatorTickets.set(key, { repository, issue: number, title: title.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300), at: this.now() });
    this.logger.error(repository + '#' + number + ': an operator prerequisite (' + this.config.operatorLabel + '), no run starts on it, the human is told');
    return true;
  }

  // One message to the human (kind handover, reason operator_prerequisite) about an operator ticket.
  tellOperator(repository: string, number: number, title: string, link: string | null): void {
    if (!this.notifier.wants('handover')) return;
    this.notifier.notify(immediateMessage(this.config.notify.language, 'handover', { repository, number, title, link: link ?? undefined, why: 'operator_prerequisite' }), repository);
  }

  // One confirmed clone failure; when it opens the breaker from closed, the incident's one hand-over is claimed and sent.
  async reportCloneFailure(report: CloneFailureReport, repository: string): Promise<boolean> {
    const from = this.cloneBreaker.state();
    const changed = await this.cloneBreaker.reportFailure(report);
    const to = this.cloneBreaker.state();
    this.cloneTransition(from, to);
    if (from === 'closed' && to === 'open' && await this.cloneBreaker.claimNotification()) this.tellCloneBreaker(repository);
    return changed;
  }

  async admitCloneTrial(owner: string): Promise<boolean> {
    const from = this.cloneBreaker.state();
    const admitted = await this.cloneBreaker.admitTrial(owner);
    this.cloneTransition(from, this.cloneBreaker.state());
    return admitted;
  }

  async confirmCloneTrial(owner: string, conversation: string): Promise<boolean> {
    const from = this.cloneBreaker.state();
    const confirmed = await this.cloneBreaker.confirmTrial(owner, conversation);
    this.cloneTransition(from, this.cloneBreaker.state());
    return confirmed;
  }

  async abandonCloneTrial(owner: string): Promise<boolean> {
    const from = this.cloneBreaker.state();
    const abandoned = await this.cloneBreaker.abandonTrial(owner);
    this.cloneTransition(from, this.cloneBreaker.state());
    return abandoned;
  }

  async settleCloneTrial(conversation: string, outcome: CloneTrialOutcome): Promise<boolean> {
    const from = this.cloneBreaker.state();
    const settled = await this.cloneBreaker.settleTrial(conversation, outcome);
    this.cloneTransition(from, this.cloneBreaker.state());
    return settled;
  }

  private cloneTransition(from: CloneBreakerState, to: CloneBreakerState): void {
    if (from === to) return;
    metrics.inc('forgehands_clone_breaker_transitions_total', { from: known(from, CLONE_BREAKER_STATES), to: known(to, CLONE_BREAKER_STATES) });
  }

  // One hand-over per incident: the claim is durable, so a restart or a reopen sends nothing.
  private tellCloneBreaker(repository: string): void {
    if (!this.notifier.wants('handover')) return;
    this.notifier.notify(immediateMessage(this.config.notify.language, 'handover', { repository, number: 0, title: 'ForgeHands: new starts are paused', why: 'clone_breaker' }), repository);
  }

  // The operator tickets for /status (waiting_for_human): the ones not closed yet, with their titles.
  operatorWaiting(): OperatorEntry[] {
    return [...this.jobs.operatorTickets.values()].map((record) => ({ repository: record.repository, issue: record.issue, pr: null, since: record.at,
      reason: 'operator_prerequisite', title: record.title }));
  }

  // The open operator tickets an issue depends on. A failed read counts as none (the run is judged as it always was).
  async operatorDependencies(repository: string, number: number): Promise<Issue[]> {
    try {
      const dependencies = await this.forge.dependencies(repository, number);
      return (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open' && (issue.labels || []).some((label) => label.name === this.config.operatorLabel));
    } catch (error) {
      this.logger.error('could not read the dependencies of #' + number + ':', error.message);
      return [];
    }
  }

  // A worker made an operator ticket for what it needs and its ticket depends on it: the ticket waits for it (no hand-back, no retry). The run is
  // not a failed delivery; when the operator ticket is closed, onClosed starts the waiting job again like any other dependent.
  async waitForOperator(job: Job, prerequisites: Issue[]): Promise<void> {
    const repository = job.event.repository.full_name;
    for (const issue of prerequisites) {
      if (this.noteOperator(repository, issue.number, issue.title ?? '')) this.tellOperator(repository, issue.number, issue.title ?? '', issue.html_url ?? null);
    }
    Object.assign(job, { status: 'waiting', waiting_for: prerequisites.map((issue) => issue.number), started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
    await this.jobs.persist(this.now());
  }

  // A review of the same commit by another reviewer route: it pushes nothing, so the reviewers of one commit run side by side.
  parallelReview(job: Job, event: ForgeEvent): boolean {
    return this.config.routes.get(job.label)?.kind === 'ci_success' && this.config.routes.get(event.label ?? '')?.kind === 'ci_success'
      && !!event.ci && job.event.ci?.commit_sha === event.ci.commit_sha;
  }

  // Follow-up runs (pull request routes) already made for the issue of this event.
  rounds(event: ForgeEvent): number {
    const base = this.issueKey(event) + ':';
    return this.jobs.list().filter((job) => job.key.startsWith(base) && this.countsAsRound(job)
      && (job.started || job.status === 'queued' || job.status === 'running')).length;
  }

  // A follow-up round that counts against MAX_ROUNDS: not one the human reset, and not a failure escalation (stage B), which is an extra try
  // on the same commit and must not use up a round.
  countsAsRound(job: Job): boolean {
    return ROUND_KINDS.has(this.config.routes.get(job.label)?.kind) && !job.round_reset && !job.failure_escalation;
  }

  // The round this job is: the rounds of its issue that come before it in the ledger (oldest first), plus itself. Only the ledger is read, so it is the same before
  // and after the start. A round whose route has "escalate_to" runs with the profile and tier of that route from ESCALATE_FROM_ROUND on.
  escalationTarget(job: Job): Route | undefined {
    const own = this.config.routes.get(job.label);
    if (!own?.escalateTo) return undefined;
    const target = this.config.routes.get(own.escalateTo);
    // An issue run is escalated only by checkDelivery (no delivery twice): from then on the job is `escalated` and runs on the target.
    if (!job.event.pull_request) return own.kind === 'issue' && job.escalated ? target : undefined;
    if (!ROUND_KINDS.has(own.kind)) return undefined;
    if (job.escalated) return target;
    const base = this.issueKey(job.event) + ':';
    const all = this.jobs.list();
    const before = all.slice(0, all.indexOf(job)).filter((other) => other.key.startsWith(base) && this.countsAsRound(other)
      && (other.started || other.status === 'queued' || other.status === 'running')).length;
    return before + 1 >= this.config.escalateFromRound ? target : undefined;
  }

  // The tier a job runs in (or will run in): the one of the escalation target for an escalated round.
  tierOf(job: Job): string | undefined {
    if (job.fell_back) return this.config.routes.get(job.fell_back)?.tier;
    return (this.escalationTarget(job) ?? this.config.routes.get(job.label))?.tier;
  }

  // The route a job starts with: the escalation target or its own route; when the tier of that is on a quota hold and the route has a
  // "fallback_to" whose tier is free, the fallback route (profile and tier; the limits, branch, kind and prompt stay those of the own route).
  effectiveRoute(job: Job, now: number): { route: Route; fellBack?: string } {
    const base = this.escalationTarget(job) ?? this.route(job.label);
    if (base.fallbackTo && (this.scheduler.cooldowns.get(base.tier) || 0) > now) {
      const fallback = this.config.routes.get(base.fallbackTo);
      if (fallback && (this.scheduler.cooldowns.get(fallback.tier) || 0) <= now) return { route: fallback, fellBack: base.fallbackTo };
    }
    return { route: base };
  }

  // The wire of the dispatcher's forge: every call it makes passes here (and below that, through the dry run gate of the transport).
  forgejoCall(event: { repository: { full_name: string } }, method: string, path: string, body?: unknown): Promise<Json> {
    return this.transport(event.repository.full_name, method, path, body);
  }

  // The reviewer approved the pull request (label): merge it when the operator's policy for the repository allows.
  async approve(event: ForgeEvent): Promise<string> {
    if (Array.isArray(event.previous_labels) && event.previous_labels.includes(this.config.approvedLabel)) {
      this.merger.report(event.repository.full_name, event.pull_request?.number ?? 0, 'already_approved', null);
      return 'already_approved';
    }
    return this.merger.handle(event);
  }

  // The open issues the given issue depends on. Without Forgejo access, or when the call fails, none: the issue is not held back.
  // A 404 here is not a read error: the ticket's own read tells a deleted ticket (its waiting jobs are dropped, and a job of it is `deleted` when the
  // caller looks again) from a ticket without dependencies (nothing to wait for). Only a 404 of the ticket itself counts as deleted.
  async openDependencies(event: NormalizedEvent, number: number): Promise<number[]> {
    if (!this.config.forgejo) return [];
    try {
      const dependencies = await this.forge.dependencies(event.repository.full_name, number);
      // An issue marked deleted in the forge (see LedgerSync) cannot be waited for, whatever the dependency list still says.
      return (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open' && !this.jobs.isDeletedInForge(event.repository.full_name + '#' + issue.number))
        .map((issue) => issue.number);
    } catch (error) {
      if (/HTTP 404\b/.test(error.message) && !('pull_request' in event && event.pull_request)) {
        await this.ticketCleanup.checkAndDropDeleted(event.repository.full_name, number);
        return [];
      }
      this.logger.error('could not read the dependencies of #' + number + ':', error.message);
      return [];
    }
  }

  // A ticket the end-to-end suite created is left to the suite: the ticket watchdog does not restart or block it (src/e2e, ReviewSweep.watchStalled).
  // It is kept for the life of the process; a closed ticket is no candidate of the watchdog anyway.
  exemptE2eTicket(repository: string, number: number): void {
    this.e2eTickets.add(repository.toLowerCase() + '#' + number);
  }

  // An epic: an issue with an epic label, or one the ledger knows as an epic (it had a run of an epic label or of the epic review, see epic-sweep.ts).
  // An epic that carries another label (ai:changes after an earlier review) is an epic all the same.
  isEpic(repository: string, issue: Json): boolean {
    if ((issue.labels || []).some((label: Json) => this.config.epicLabels.has(label.name))) return true;
    return ledgerEpics(this.config, this.jobs, repository).numbers.has(issue.number);
  }

  // An issue closed: what depended on it may start now (a waiting job), and an epic whose last dependency this was is reviewed.
  async onClosed(event: ForgeEvent): Promise<string> {
    const ticket = event.repository.full_name.toLowerCase() + '#' + event.issue.number;
    if (this.jobs.operatorTickets.delete(ticket)) await this.jobs.persist(this.now());
    await this.ticketCleanup.markClosed(ticket);
    if (!this.config.forgejo) return 'no_forgejo_access';
    await this.waitKeeper.releaseFileWaitsNow();
    let blocked: Json;
    try { blocked = await this.forge.blocks(event.repository.full_name, event.issue.number); }
    catch (error) { this.logger.error('could not read what #' + event.issue.number + ' blocks:', error.message); return 'blocks_unknown'; }
    const outcome: string[] = [];
    let changed = false;
    for (const target of Array.isArray(blocked) ? blocked : []) {
      if (target.state !== 'open') continue;
      if ((await this.openDependencies(event, target.number)).length) continue;
      const base = event.repository.full_name.toLowerCase() + '#' + target.number + ':';
      const waiting = this.jobs.list(true).filter((job) => job.status === 'waiting' && job.key.startsWith(base));
      if (waiting.length) {
        for (const job of waiting) { job.status = 'queued'; delete job.waiting_for; }
        outcome.push('started #' + target.number);
        changed = true;
      } else if (this.isEpic(event.repository.full_name, target)) {
        if (await this.startEpicReview(event, target)) { outcome.push('epic #' + target.number + ' review'); changed = true; }
      }
    }
    if (changed) {
      await this.jobs.persist(this.now());
      this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    }
    return outcome.join(', ') || 'nothing_ready';
  }

  // A pull request of an agent issue (branch ai/issue-<n>) that was merged by somebody else (a human, for protected paths) leaves its ticket
  // open, because the agents' pull request texts do not always say "Closes #n"; the tickets that wait for it then wait for ever. After a
  // push to the default branch, close the tickets whose agent pull request was merged into it. Closing sends the usual "issue closed"
  // event, which starts what waits. Best effort.
  async closeMergedTickets(event: PushEvent): Promise<number> {
    if (!this.config.forgejo) return 0;
    await this.waitKeeper.releaseFileWaitsNow();
    const repository = event.repository.full_name;
    let closed = 0;
    try {
      const pulls = await this.forge.listPulls(repository, { state: 'closed', sort: 'recentupdate', limit: 20 });
      for (const pr of Array.isArray(pulls) ? pulls : []) {
        const reverted = /^ai\/revert-(\d+)$/.exec(pullBranch(pr));
        if (reverted && pr.merged && (!event.repository.default_branch || !pr.base?.ref || pr.base.ref === event.repository.default_branch)) {
          await this.revertKeeper.markRevertedMerge(repository, Number(reverted[1]), Number(pr.number));
          closed += (await this.revertKeeper.revertMerged(repository, pr, Number(reverted[1]))) ? 1 : 0;
          continue;
        }
        const match = /^ai\/issue-(\d+)$/.exec(pullBranch(pr));
        if (!match || !pr.merged || (event.repository.default_branch && pr.base?.ref && pr.base.ref !== event.repository.default_branch)) continue;
        // A merged pull request whose change was reverted: its ticket is reopened by the revert, not closed again here.
        if (this.revertKeeper.revertOf(repository, Number(pr.number))) continue;
        const number = Number(match[1]);
        const issue = await this.forge.getIssue(repository, number);
        if (issue && issue.state === 'closed' && !issue.pull_request) await this.ticketCleanup.markClosed(repository.toLowerCase() + '#' + number);
        if (!issue || issue.state !== 'open' || issue.pull_request) continue;
        // A forge may refuse to close the ticket (Forgejo answers 412 while issues it depends on are open). That must neither stop the other
        // tickets of this pass nor repeat every push (and comment every time): the refusal is remembered for six hours.
        const ticket = repository.toLowerCase() + '#' + number;
        if ((this.ticketCleanup.closeRefused.get(ticket) || 0) > this.now()) continue;
        try {
          await this.forge.closeIssue(repository, number);
        } catch (error) {
          this.ticketCleanup.closeRefused.set(ticket, this.now() + 6 * 3600000);
          this.logger.error('could not close #' + number + ' of ' + repository + ' (its pull request #' + pr.number + ' is merged), trying again in six hours:', error.message);
          continue;
        }
        await this.forge.addComment(repository, number, 'ForgeHands: closed, the pull request #' + pr.number + ' for this ticket is merged.', 'issue');
        await this.ticketCleanup.markClosed(ticket);
        this.noteTicket(ticket, { merged_at: Date.parse(pr.merged_at as string) || this.now(), merged_by: 'human' });
        closed += 1;
      }
    } catch (error) {
      this.logger.error('could not close the tickets of merged pull requests:', error.message);
    }
    return closed;
  }

  // The worker label of the ticket's last run: the trigger that starts it again (an issue route, not a planner's label; the newest run wins).
  lastRunLabel(repository: string, issue: number): string | undefined {
    const runs = this.jobs.list().filter((job) => job.key.startsWith(repository + '#' + issue + ':') && this.config.routes.get(job.label)?.kind === 'issue');
    return runs.at(-1)?.label;
  }

  // The secret values a comment must not contain (AGENT_SECRETS and the forge token).
  secretValues(): string[] {
    return [...Object.values(this.config.agentSecrets || {}), this.config.forgejo?.token].filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  // All dependencies of the epic are closed: have it reviewed (and closed when its criteria are met). Once per run.
  async startEpicReview(event: ForgeEvent, epic: Json): Promise<boolean> {
    const route = [...this.config.routes].find(([, entry]) => entry.kind === 'epic_done')?.[0];
    if (!route) return false;
    const key = event.repository.full_name.toLowerCase() + '#' + epic.number + ':' + route;
    if (this.jobs.activeByKey(key)) return false;
    let children: { number: number; title: string }[] = [];
    try {
      children = (await this.forge.dependencies(event.repository.full_name, epic.number)).map((issue: Json) => ({ number: issue.number, title: String(issue.title || '').slice(0, 200) }));
    } catch (error) { this.logger.error('could not list the sub-issues of #' + epic.number + ':', error.message); }
    this.jobs.add({
      key, label: route, status: 'queued', created: this.now(),
      event: {
        type: 'epic.done', source: this.forge.kind, action: 'dependencies_closed', label: route, repository: event.repository,
        issue: { number: epic.number, title: String(epic.title || '').slice(0, 1000), body: String(epic.body || '').slice(0, 50000), html_url: epic.html_url || null, comments: epic.comments || 0, labels: (epic.labels || []).map((label: Json) => label.name) },
        epic: { children }, sender: event.sender
      }
    });
    return true;
  }

  // Is the commit of a CI run no longer the head of its pull request? Unknown (no access, error) counts as not stale.
  async isStale(event: ForgeEvent): Promise<boolean> {
    if (!this.config.forgejo) return false;
    try {
      const pr = await this.forge.getPull(event.repository.full_name, event.pull_request!.number);
      // A pull request that closed meanwhile has nothing left to fix or review (Gitea's run event does not say whether it is open).
      if (pr?.state === 'closed' || pr?.merged === true) return true;
      return Boolean(pr?.head?.sha) && pr.head.sha !== event.ci!.commit_sha;
    } catch (error) {
      this.logger.error('could not read the head of #' + event.pull_request!.number + ':', error.message);
      return false;
    }
  }

  // Forgejo sends one event per finished workflow run. All workflows of the commit have to be green: the combined commit
  // status says so (a repository without any workflow file needs no green run, see REVIEW_WITHOUT_CI). Without Forgejo access ForgeHands cannot tell and starts no review.
  async commitGreen(event: ForgeEvent): Promise<boolean> {
    if (!this.config.forgejo) {
      this.logger.error('ci success of ' + this.issueKey(event) + ' ignored: FORGEJO_URL and FORGEJO_TOKEN are needed to check the commit status');
      return false;
    }
    try {
      return Boolean(await this.merger.ciGreen(event.repository.full_name, event.ci!.commit_sha));
    } catch (error) {
      this.logger.error('commit status failed:', error.message);
      return false;
    }
  }

  // Is the commit of a failed CI run pending (a re-run is under way) or green? Then there is nothing to fix. Unknown counts as still red.
  async commitRecovered(event: ForgeEvent): Promise<boolean> {
    if (!this.config.forgejo) return false;
    try {
      const status = await this.forge.commitStatus(event.repository.full_name, event.ci!.commit_sha);
      return status?.state === 'pending' || status?.state === 'success';
    } catch (error) {
      this.logger.error('commit status failed:', error.message);
      return false;
    }
  }

  // The last allowed round has ended. Nothing else looks at a pull request whose round pushed nothing: the next round is what would call the human
  // (enqueueOne), and no event asks for that round. So when the head the round left still has a NOT OK verdict, the human is called now, as that
  // refused start would have done. A head the round pushed is not judged here: its CI and review come next, and a NOT OK on it calls the human then.
  async checkRoundsAfterRun(job: Job): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event?.pull_request || this.rounds(event) < this.roundLimit(event)) return;
    try {
      const repository = event.repository.full_name;
      const pr = await this.forge.getPull(repository, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged) return;
      const names = (pr.labels || []).map((label: Json) => label.name);
      if ([this.config.approvedLabel, this.config.blockedLabel].some((name) => names.includes(name))) return;
      const verdict = await this.merger.reviewOf(repository, event.pull_request.number, pr.head.sha);
      if (verdict.ok || (verdict.reason !== 'not_ok' && verdict.reason !== 'changes_requested')) return;
      await this.roundsUsedUp(event);
    } catch (error) {
      this.logger.error('could not check the last round of #' + event.pull_request.number + ':', error.message);
    }
  }

  // The rounds are used up: say so on the pull request and mark it for a human. Best effort, a failure is only logged.
  async roundsUsedUp(event: ForgeEvent): Promise<void> {
    const limit = this.roundLimit(event);
    this.logger.error(this.issueKey(event) + ': ' + limit + ' rounds used up, not starting another');
    await this.markForHuman(event, 'ForgeHands: ' + limit + ' follow-up rounds for ' + (event.bot ? 'this dependency update' : 'issue #' + event.issue.number) + ' are used up. A human has to look at this pull request now.', 'rounds_used_up');
  }

  // Say why on the pull request (or, for an epic, on its issue) and label it for a human. Best effort, a failure is only logged.
  async markForHuman(event: ForgeEvent, text: string, reason = 'other', facts: Partial<Facts> = {}): Promise<void> {
    metrics.inc('forgehands_blocks_total', { reason });
    this.noteTicket(this.issueKey(event), { blocked_at: this.now() });
    this.tell(reason === 'conflict' ? 'conflict' : reason === 'failed_run' ? 'failed' : reason === 'epic_gaps' ? 'handover' : 'blocked', event, { why: reason, ...facts });
    if (!this.config.forgejo) return;
    // An epic has no pull request: its issue gets the comment and the label (the same number on Forgejo).
    const number = event.pull_request?.number ?? event.issue.number;
    const on = event.pull_request ? undefined : 'issue';
    const repository = event.repository.full_name;
    try {
      await this.forge.addComment(repository, number, mentionOf(this.config) + text, on);
      const label = await this.forge.findOrCreateLabel(repository, this.config.blockedLabel, '#b60205');
      await this.forge.addLabels(repository, number, [label], on);
    } catch (error) {
      this.logger.error('could not mark the pull request:', error.message);
    }
  }

  // A message for the human about the pull request (or, without one, the issue) of this event: kind handover, blocked, conflict or failed.
  tell(kind: string, event: ForgeEvent, facts: Partial<Facts> = {}): void {
    if (!this.notifier.wants(kind)) return;
    const repository = event.repository.full_name;
    const number = event.pull_request?.number ?? event.issue.number;
    const link = event.pull_request ? pullUrl(this.config, repository, number, event.pull_request.html_url) : event.issue.html_url;
    this.notifier.notify(immediateMessage(this.config.notify.language, kind, { repository, number, title: event.issue.title, link: link ?? undefined, ...facts }), repository);
  }

  // Once a day, at NOTIFY_DIGEST in NOTIFY_TIMEZONE (the first pass after that time), one message with what is for the human; none when there is
  // nothing. The date of the last one is kept in the ledger, so a restart neither repeats the day nor skips it. A dry run keeps it in memory only.
  async sendDigest(now: number): Promise<boolean> {
    const { digest, timezone, language } = this.config.notify;
    if (!digest || !this.notifier.wants('digest')) return false;
    const dry = isDry(this.config);
    const { due, date } = digestDue(digest, timezone, now, dry ? this.digestDone : this.jobs.meta.digest_sent);
    if (!due) return false;
    try {
      const data = collectDigest(this.config, this.jobs, [...this.reminder.waiting.values()], this.scheduler.cooldowns, now);
      // The follow-up figure is read from the forge only when a digest goes out: it is shown in a digest and never sends one by itself.
      if (!digestIsEmpty(data)) data.fixes = await collectFixes(this.config, this.jobs, this.forge, now, this.logger);
      const message = digestMessage(language, data, this.config.allowedRepos.size > 1);
      if (message) this.notifier.notify(message);
    } catch (error) {
      this.logger.error('could not build the digest:', error.message);
      return false;
    }
    if (dry) { this.digestDone = date; return false; }
    this.jobs.meta.digest_sent = date;
    return true;
  }

  async start(intervalMs = this.config.pollMs): Promise<void> {
    if (this.scheduler.clearQuotaHolds()) await this.jobs.persist(this.now());
    this.timer = setInterval(() => this.tick().catch((error) => this.logger.error('dispatch failed:', error.message)), intervalMs);
    this.timer.unref?.();
    this.workspace.start();
    this.ledgerSync.start();
    this.sweep.start();
    return this.tick();
  }
  stop(): void { clearInterval(this.timer); this.workspace.stop(); this.ledgerSync.stop(); this.sweep.stop(); }

  // Every OpenHands call passes here. A write of a dry run (DRY_RUN) is stopped: logged, never sent (the body can hold secrets, so it is not
  // logged), and answered with a stand-in. `repository` says whose dry run applies; without it any dry run does. Reads are real.
  async api(method: string, path: string, body?: unknown, repository?: string, timeoutMs = this.config.timeoutMs): Promise<Response> {
    if (isWrite(method) && isDry(this.config, repository)) {
      this.dry.record('OpenHands', method, path);
      return new Response('{}', { status: 200 });
    }
    const response = await this.send(this.config.apiUrl + path, {
      method,
      headers: { 'X-Session-API-Key': this.config.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    }).catch((error) => { metrics.apiError('openhands', null); throw error; });
    if (!response.ok) metrics.apiError('openhands', response.status);
    return response;
  }

  // Ticks never overlap: a caller waits for the running one and then runs a fresh pass.
  async tick(): Promise<void> {
    while (this.current) await this.current.catch(() => {});
    this.current = this.pass();
    try { await this.current; } finally { this.current = null; }
  }

  async pass(): Promise<void> {
    if (!this.cloneBreakerHydrated) {
      this.cloneBreakerHydrated = true;
      await this.cloneBreaker.hydrate();
    }
    let changed = false;
    const now = this.now();
    // The disk guard is read first: a hold set here keeps the queued jobs waiting in the loop below.
    await this.workspace.poll();
    for (const job of this.jobs.list('running')) {
      if (await this.runWatcher.poll(job, now)) changed = true;
    }
    for (const job of this.jobs.list(true).filter((entry) => entry.status === 'waiting' && entry.waiting_for_run)) {
      if (await this.scheduler.releaseDeferred(job, now)) changed = true;
    }
    this.waitKeeper.depReads = 0;
    if (await this.waitKeeper.breakWaitCycles()) changed = true;
    // Each queued job is tried at most once per pass; what to try next is decided by pickNext.
    const tried = new Set<string>();
    let started = 0;
    for (;;) {
      const job = this.scheduler.pickNext(now, tried);
      if (!job) break;
      tried.add(job.id);
      if (await this.scheduler.startJob(job, now)) changed = true;
      if (job.started === now) started += 1;
    }
    if (started) this.lastStart = now;
    this.idleReporter.reportIdle(now, started);
    this.idleReporter.checkStall(now);
    if (await this.branchRefresher.refreshMoved(now)) changed = true;
    // Two-key merges on hold (TWO_KEYS_HOLD_MINUTES): the due ones are looked at, the merge comes when the hold has ended.
    if (await this.merger.recheckHolds()) changed = true;
    if (await this.ticketCleanup.archiveOld(now)) changed = true;
    if (await this.ticketCleanup.deleteOld(now)) changed = true;
    if (await this.ticketCleanup.sweepClosed(now)) changed = true;
    if (await this.epicGaps.sweep(now)) changed = true;
    if (await this.reminder.run(now)) changed = true;
    if (await this.sendDigest(now)) changed = true;
    if (await this.revertKeeper.checkRevertRate(now)) changed = true;
    if (await this.revertKeeper.checkReruns(now)) changed = true;
    if (changed) await this.jobs.persist(this.now());
  }

  // A ticket was sent to the planner (an epic label): its original agent pull request is closed (the branch stays), because the slices
  // would build the same thing again, and its queued or waiting jobs other than the planner's go. A worker running on it is left alone.
  // Best effort; without forge access, or without an open pull request, nothing changes.
  async endOriginalPull(event: ForgeEvent, label: string): Promise<void> {
    if (!this.config.forgejo) return;
    const repository = event.repository.full_name;
    const number = event.issue.number;
    try {
      const pulls = await this.forge.listPulls(repository, { state: 'open', limit: 50 });
      const pr = (Array.isArray(pulls) ? pulls : []).find((entry) => pullBranch(entry) === 'ai/issue-' + number && entry.state === 'open');
      if (!pr) return;
      if (isDry(this.config, repository)) {
        this.logger.error('DRY RUN: pull request #' + pr.number + ' of #' + number + ' would be closed, the ticket went to ' + label);
        return;
      }
      await this.forge.addComment(repository, pr.number, 'ForgeHands: the ticket was sent to the planner to be split; this pull request is closed so that the slices do not build the same thing twice. Its work stays in the branch.', 'pull');
      await this.forge.closePull(repository, pr.number);
      const base = this.issueKey(event) + ':';
      let removed = 0;
      for (const job of this.jobs.list(true).filter((entry) => entry.key.startsWith(base) && !this.config.epicLabels.has(entry.label))) {
        if (job.status === 'running') { this.logger.error(job.key + ' is running and is left alone, its ticket went to ' + label); continue; }
        if (job.status === 'queued' || job.status === 'waiting') { this.jobs.remove(job.id); removed += 1; }
      }
      if (removed) await this.jobs.persist(this.now());
    } catch (error) {
      this.logger.error('could not end the pull request of #' + number + ' after it went to ' + label + ':', error.message);
    }
  }

  // The route of a label; a label without one is a mistake in the ledger or the config, and throws. Shared with RunWatcher.
  route(label: string): Route {
    const route = this.config.routes.get(label);
    if (!route) throw new Error('no route for label ' + label);
    return route;
  }

  // One message into a conversation, without a run call (run: false). Throws when OpenHands does not take it (HTTP status in the message) or the call
  // times out; shared by resume (the normal timeout) and the nudge (its own, longer timeout, see nudgeIfNoBranch).
  async sendMessage(job: Job, text: string, timeoutMs?: number): Promise<void> {
    const response = await this.api('POST', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events', { role: 'user', content: [{ type: 'text', text }], run: false }, job.event.repository.full_name, timeoutMs);
    if (!response.ok) throw new Error('HTTP ' + response.status);
  }

  // Whether a branch exists in the forge. A missing branch is HTTP 404 (false); any other failure throws, so that the caller treats it as unknown.
  async branchExists(repository: string, branch: string): Promise<boolean> {
    try {
      return (await this.forge.branchTip(repository, branch)) !== null;
    } catch (error) {
      if (/HTTP 404\b/.test(error.message)) return false;
      throw error;
    }
  }

  // Reached from other modules and from the tests; the work is done by Nudger (nudge.ts).
  get nudgeInflight(): Nudger['nudgeInflight'] { return this.nudger.nudgeInflight; }

  // Reached from other modules and from the tests; the work is done by WaitKeeper (wait-keeper.ts).
  releaseFileWaits(...args: Parameters<WaitKeeper['releaseFileWaits']>): ReturnType<WaitKeeper['releaseFileWaits']> { return this.waitKeeper.releaseFileWaits(...args); }

  // Reached from other modules and from the tests; the work is done by RevertKeeper (revert-keeper.ts).
  checkRevertRate(...args: Parameters<RevertKeeper['checkRevertRate']>): ReturnType<RevertKeeper['checkRevertRate']> { return this.revertKeeper.checkRevertRate(...args); }
  checkReruns(...args: Parameters<RevertKeeper['checkReruns']>): ReturnType<RevertKeeper['checkReruns']> { return this.revertKeeper.checkReruns(...args); }

  // Reached from other modules and from the tests; the work is done by BranchRefresher (branch-refresh.ts).
  get lastUpdate(): BranchRefresher['lastUpdate'] { return this.branchRefresher.lastUpdate; }
  onMainMoved(...args: Parameters<BranchRefresher['onMainMoved']>): ReturnType<BranchRefresher['onMainMoved']> { return this.branchRefresher.onMainMoved(...args); }
  refreshPull(...args: Parameters<BranchRefresher['refreshPull']>): ReturnType<BranchRefresher['refreshPull']> { return this.branchRefresher.refreshPull(...args); }
  checkBranchAfterRun(...args: Parameters<BranchRefresher['checkBranchAfterRun']>): ReturnType<BranchRefresher['checkBranchAfterRun']> { return this.branchRefresher.checkBranchAfterRun(...args); }

  // Reached from other modules and from the tests; the work is done by DeliveryCheck (delivery.ts).
  checkDelivery(...args: Parameters<DeliveryCheck['checkDelivery']>): ReturnType<DeliveryCheck['checkDelivery']> { return this.deliveryCheck.checkDelivery(...args); }
  checkVerdict(...args: Parameters<DeliveryCheck['checkVerdict']>): ReturnType<DeliveryCheck['checkVerdict']> { return this.deliveryCheck.checkVerdict(...args); }

  // Reached from other modules and from the tests; the work is done by TicketCleanup (ticket-cleanup.ts).
  dropQueuedOf(...args: Parameters<TicketCleanup['dropQueuedOf']>): ReturnType<TicketCleanup['dropQueuedOf']> { return this.ticketCleanup.dropQueuedOf(...args); }
  sweepClosed(...args: Parameters<TicketCleanup['sweepClosed']>): ReturnType<TicketCleanup['sweepClosed']> { return this.ticketCleanup.sweepClosed(...args); }
  archiveOld(...args: Parameters<TicketCleanup['archiveOld']>): ReturnType<TicketCleanup['archiveOld']> { return this.ticketCleanup.archiveOld(...args); }
  deleteOld(...args: Parameters<TicketCleanup['deleteOld']>): ReturnType<TicketCleanup['deleteOld']> { return this.ticketCleanup.deleteOld(...args); }

  // Reached from other modules and from the tests; the work is done by IdleReporter (idle.ts).
  idleCounts(...args: Parameters<IdleReporter['idleCounts']>): ReturnType<IdleReporter['idleCounts']> { return this.idleReporter.idleCounts(...args); }
  idleState(...args: Parameters<IdleReporter['idleState']>): ReturnType<IdleReporter['idleState']> { return this.idleReporter.idleState(...args); }

  // Reached from other modules and from the tests; the work is done by RunWatcher (run-watcher.ts).
  poll(...args: Parameters<RunWatcher['poll']>): ReturnType<RunWatcher['poll']> { return this.runWatcher.poll(...args); }
  escalateFailure(...args: Parameters<RunWatcher['escalateFailure']>): ReturnType<RunWatcher['escalateFailure']> { return this.runWatcher.escalateFailure(...args); }
  failed(...args: Parameters<RunWatcher['failed']>): ReturnType<RunWatcher['failed']> { return this.runWatcher.failed(...args); }
  reportFailure(...args: Parameters<RunWatcher['reportFailure']>): ReturnType<RunWatcher['reportFailure']> { return this.runWatcher.reportFailure(...args); }
  tierRunEnded(...args: Parameters<RunWatcher['tierRunEnded']>): ReturnType<RunWatcher['tierRunEnded']> { return this.runWatcher.tierRunEnded(...args); }

  // Reached from other modules and from the tests; the work is done by Scheduler (scheduler.ts).
  get cooldowns(): Scheduler['cooldowns'] { return this.scheduler.cooldowns; }
  pickNext(...args: Parameters<Scheduler['pickNext']>): ReturnType<Scheduler['pickNext']> { return this.scheduler.pickNext(...args); }
  holdOf(...args: Parameters<Scheduler['holdOf']>): ReturnType<Scheduler['holdOf']> { return this.scheduler.holdOf(...args); }
  earliestStart(...args: Parameters<Scheduler['earliestStart']>): ReturnType<Scheduler['earliestStart']> { return this.scheduler.earliestStart(...args); }
  startJob(...args: Parameters<Scheduler['startJob']>): ReturnType<Scheduler['startJob']> { return this.scheduler.startJob(...args); }
  clearQuotaHolds(...args: Parameters<Scheduler['clearQuotaHolds']>): ReturnType<Scheduler['clearQuotaHolds']> { return this.scheduler.clearQuotaHolds(...args); }
}
