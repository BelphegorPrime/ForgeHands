import { randomUUID } from 'node:crypto';
import { buildPrompt } from './prompt.ts';
import { parseDeclaredFiles } from './files.ts';
import { anyOverlap } from '../utils/path-overlap.ts';
import { createForge, createTransport } from '../forge/index.ts';
import { Merger } from './merge.ts';
import { REVERT_BRANCH } from './bot.ts';
import { DryLog, isDry, isWrite } from '../dry.ts';
import { Reminder } from './remind.ts';
import { Workspace } from './workspace.ts';
import { LedgerSync } from './ledger-sync.ts';
import { ReviewSweep } from './review-sweep.ts';
import { Notifier, mentionOf, pullUrl } from '../notify/index.ts';
import { collectDigest, collectFixes, digestDue } from '../notify/digest.ts';
import { digestIsEmpty, digestMessage, immediateMessage, stallMessage } from '../notify/texts.ts';
import type { Facts } from '../notify/texts.ts';
import { known, metrics } from '../metrics.ts';
import { isBotPull } from './bot.ts';
import type { BranchPushEvent, DirectConfig, IdleCounts, IdleState, Route, TokenTotals, Fetch, ForgeEvent, Job, Json, Logger, NewJob, NormalizedEvent, PushEvent } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../forge/index.ts';
import { cycleText, findCycles, ticketKey, waitGraph } from './waits.ts';

// `paused` counts: the run stopped (an OpenHands restart, or POST /pause). It is an interruption, so it is resumed (see resume), not a verdict on the ticket.
const TERMINAL = new Set(['finished', 'error', 'stuck', 'deleted', 'paused', 'max_iterations']);
const RETRY_BASE_MS = 60000;
const MAX_ATTEMPTS = 3;
// Routes that count as a follow-up round of an issue (a review run does not).
const ROUND_KINDS = new Set<string | undefined>(['pull_request', 'ci_failure', 'conflict']);
const ERROR_RETRY_DELAY_MS = 60000;
// Errors of a gateway that has no model left to ask: treated like a quota that is used up.
const UNAVAILABLE_CODES = new Set(['LLMServiceUnavailableError', 'BadGatewayError', 'LLMTimeoutError']);
// The last this many started runs decide what a repository has had so far (see pickNext).
const RECENT_STARTS = 50;
// WAIT_FOR_SAME_FILES looks at no more open pull requests than this per check.
const FILE_PULLS_LOOKED_AT = 20;
const ACTIVE_STATUSES = new Set(['waiting', 'queued', 'running']);
// Stage A (RESUME_ATTEMPTS): the states a run is continued in, on its own conversation. A run that reached its iteration limit is not among
// them: nothing in the API raises that limit of a conversation, so the same run would end the same way (see resume).
const RESUMABLE = new Set(['stuck', 'timeout']);
// A paused run (PAUSE_RESUMES) is continued with its own message: nothing went wrong with the ticket, the agent was interrupted.
const PAUSE_MESSAGE = 'The run was interrupted (the agent server was restarted or the conversation was paused). Continue from where you stopped: check the state of the branch and of your last step, then finish the task and end with the finish tool.';
// A continued run is given this long before its state counts again: the state it stopped in may still be reported for a moment.
const RESUME_SETTLE_MS = 60000;
// Stage B (FAILURE_ESCALATE): the states after which a round starts once more on the profile of its escalate_to route (see escalateFailure).
// `no_delivery` is not one of them: it is only ever reported for issue runs, which have no escalate_to.
const ESCALATABLE = new Set(['stuck', 'timeout', 'max_iterations']);
// Nudge (NUDGE_AT_PERCENT): a run's actions are counted at most once a minute, and not before the run is three minutes old.
const NUDGE_CHECK_EVERY_MS = 60000;
const NUDGE_MIN_RUN_MS = 180000;
// A nudge is sent at most this many times without a trace of it in the events (the first send and one resend after a timeout).
const NUDGE_TRIES = 2;
// The idle line is logged again after this long when nothing about the waiting work has changed (see reportIdle).
const IDLE_LOG_EVERY_MS = 15 * 60000;
// After a stall alert no other one for this long, unless nothing waits any more (see checkStall).
const STALL_REPEAT_MS = 6 * 3600000;
// The open dependencies of a ticket that has no waiting job in the ledger are read from the forge, at most once per ticket per this long (cached).
const DEP_CACHE_MS = 10 * 60000;
// And at most this many such reads per pass: beyond that a ticket's edges are unknown for now (no edges, nothing is broken).
const DEP_READS_PER_PASS = 40;

// The route kinds, as the token counter labels them (a known set, see metrics.known).
const ROUTE_KINDS = ['issue', 'pull_request', 'ci_failure', 'ci_success', 'epic_done', 'conflict', 'sensitive_review', 'main_red'];
const TOKEN_TYPES = ['prompt', 'completion', 'cache_read', 'reasoning'] as const;

// Tokens of a conversation (stats.usage_to_metrics: one entry per usage id, each with its LLM calls in token_usages), summed. Null when the
// conversation carries no usage at all.
export function tokenUsage(data: Json): TokenTotals | null {
  const usage = data?.stats?.usage_to_metrics ?? data?.metrics?.usage_to_metrics;
  if (!usage || typeof usage !== 'object') return null;
  const totals: TokenTotals = { prompt: 0, completion: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
  for (const entry of Object.values(usage) as Json[]) {
    for (const call of Array.isArray(entry?.token_usages) ? entry.token_usages as Json[] : []) {
      totals.prompt += Number(call?.prompt_tokens) || 0;
      totals.completion += Number(call?.completion_tokens) || 0;
      totals.cache_read += Number(call?.cache_read_tokens) || 0;
      totals.cache_write += Number(call?.cache_write_tokens) || 0;
      totals.reasoning += Number(call?.reasoning_tokens) || 0;
    }
  }
  return totals;
}

// Accumulated LLM cost (USD) of a conversation, summed over all of its LLMs.
export function conversationCost(data: Json): number | null {
  // OpenHands reports it under `stats`; `metrics` is null in the conversation response.
  const usage = data?.stats?.usage_to_metrics ?? data?.metrics?.usage_to_metrics;
  if (!usage || typeof usage !== 'object') return null;
  return (Object.values(usage) as Json[]).reduce((sum: number, entry) => sum + (Number(entry?.accumulated_cost) || 0), 0);
}

// The idle line: how many waiting jobs wait for what (see Dispatcher.reportIdle). `could_start` is only named when it is not 0.
function idleLine(reasons: IdleCounts, tiers: string[]): string {
  const total = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  return 'idle: ' + total + ' waiting: ' + reasons.dependencies + ' on dependencies, ' + reasons.files + ' on files of older tickets, '
    + reasons.quota + ' held (quota ' + (tiers.join('/') || 'none') + '), ' + reasons.disk + ' held (low disk), '
    + reasons.hourly + ' over the hourly limit, ' + reasons.concurrency + ' over a concurrency limit'
    + (reasons.could_start ? ', ' + reasons.could_start + ' could start but did not' : '')
    + (reasons.cycle ? ', ' + reasons.cycle + ' in a dependency cycle' : '');
}

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
  /** The reconciler of REVIEW_SWEEP_MINUTES: starts the review of a head that has none in the ledger. */
  sweep: ReviewSweep;
  /** The digest of this local date is done (sent, or nothing to send) in a dry run, where the ledger is not written. */
  digestDone: string | undefined;
  lastArchive = 0;
  /** Earliest time of the next look for closed issues (sweepClosed) and when each ticket was last found open. */
  nextClosedSweep = 0;
  closedChecked = new Map<string, number>();
  closeRefused = new Map<string, number>(); // repository#issue -> until when a refused close is not tried again
  lastUpdate = new Map<string, number>(); // repository#pr -> when ForgeHands last updated its branch (the cooldown)
  mainMoved = new Map<string, { at: number; event: PushEvent }>(); // repository -> { at, event }: the default branch moved, look at the pull requests after the delay
  cooldowns = new Map<string, number>(); // tier -> until when its model is out of quota (not kept across a restart: the next error sets it again)
  nudgeChecks = new Map<string, number>(); // job id -> when the actions of its run were last counted (NUDGE_AT_PERCENT); in memory only
  // job id -> the nudge being delivered in the background (see startNudge): the poll path never waits for a nudge; in memory only.
  nudgeInflight = new Map<string, Promise<void>>();
  /** What holds the work back in the last pass that started nothing while something waited (null: nothing waits or the last pass started something). */
  idle: IdleState | null = null;
  idleLogged: { key: string; at: number } | null = null; // the composition last logged and when
  // Same-files waits not taken ("repo#j>repo#t") and dependency cycles logged: each once, in memory.
  cyclePairs = new Set<string>();
  cyclesLogged = new Set<string>();
  // The open dependencies read from the forge for the wait graph: ticket key -> when read and what was open (a failed read is an empty answer).
  depCache = new Map<string, { at: number; open: string[] }>();
  depReads = 0; // reads spent in the current pass
  /** When a job last started (a start of this process counts from its start): the stall alert measures the quiet time from it. */
  lastStart: number;
  stallAlertAt: number | null = null; // when the last stall alert went out; cleared when nothing waits any more

  constructor(config: DirectConfig, jobs: JobStore, send: Fetch = fetch, logger: Logger = console, now: () => number = Date.now, notifier?: Notifier) {
    this.config = config;
    this.jobs = jobs;
    this.send = send;
    this.logger = logger;
    this.now = now;
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
    this.ledgerSync = new LedgerSync(config, jobs, this.forge, logger, (ticket) => this.markClosed(ticket), now, (ticket) => this.dropDeletedTicket(ticket));
    this.reminder.deleted = (repository, number) => this.checkAndDropDeleted(repository, number);
    this.sweep = new ReviewSweep(config, jobs, this.forge, this.merger, (event) => this.enqueue(event), logger, now);
    this.merger.note = (ticket, fact) => this.noteTicket(ticket, fact === 'merged' ? { merged_at: this.now(), merged_by: 'agent' } : { blocked_at: this.now() });
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
    if (event.type === 'ci.main_failure') return this.onMainFailure(event);
    if (event.type !== 'ci.success') return this.enqueueOne(event);
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
      else pr = (await this.forge.listPulls(repository, { state: 'open', limit: 50 })).find((entry: Json) => entry?.head?.ref === event.branch && entry.state === 'open');
    } catch (error) {
      this.logger.error('could not look for the pull request of ' + repository + ' ' + event.branch + ':', error.message);
      return 'pull_unreadable';
    }
    if (!pr || pr.state !== 'open' || pr.merged || pr.head?.ref !== event.branch) return 'no_open_pull';
    if (pr.head?.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) return 'not_an_agent_branch';
    const bot = isBotPull({ authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos }, pr, repository);
    const match = /^ai\/issue-(\d+)$/.exec(pr.head.ref);
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
      repository: event.repository, issue, pull_request: { number, head_ref: pr.head.ref, html_url: pr.html_url || null },
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
    // The review of HUMAN_LOGIN in comment mode (HUMAN_REVIEW_ROUNDS, see onHumanReview). Nobody else's review is an event in comment mode.
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
    return (await this.enqueueOne({ ...event, label: this.config.changesLabel })).status;
  }

  // HUMAN_REVIEW_ROUNDS in comment mode: a review of HUMAN_LOGIN on an agent pull request (see normalizeReview). His request for changes on the
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
  // has no sub-issues (its dependencies and the issues it blocks are both empty). A planner that is still running is not restarted (the active
  // check in onComment); an unreadable forge or an unclear answer means nothing happens. Once per comment, and at most N times per ticket and label,
  // then one notice on the issue.
  async planAnswer(event: ForgeEvent, runs: Job[], commentKey: string): Promise<string> {
    const limit = this.config.planAnswerRestarts;
    if (!limit) return 'plan_answers_off';
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const ticket = this.issueKey(event);
    const planner = runs.filter((job) => this.isPlannerLabel(job.label));
    const label = planner.at(-1)?.label;
    // No finished planner is the answer a comment has always got when nothing failed ('no_failed_run').
    if (!label || planner.at(-1)!.status !== 'done') return 'no_failed_run';
    let issue: Json; let dependencies: unknown; let blocks: unknown;
    try {
      issue = await this.forge.getIssue(repository, number);
      dependencies = await this.forge.dependencies(repository, number);
      blocks = await this.forge.blocks(repository, number);
    } catch (error) {
      this.logger.error('could not read #' + number + ' after a comment, not restarting its plan:', error.message);
      return 'issue_unreadable';
    }
    if (!issue || issue.state !== 'open' || issue.pull_request) return 'not_open';
    const labels: string[] = (Array.isArray(issue.labels) ? issue.labels : []).map((entry: Json) => entry?.name).filter((name: unknown): name is string => typeof name === 'string');
    if (!labels.includes(label)) return 'label_gone';
    // A read that does not give a list is unknown, and unknown means nothing happens.
    if (!Array.isArray(dependencies) || !Array.isArray(blocks)) return 'links_unknown';
    if (dependencies.length || blocks.length) return 'has_sub_issues';
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
      return 'plan_answers_used_up';
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
    if (this.config.epicLabels.has(label) && !event.pull_request && !event.ci && !event.plan_answer && event.type.startsWith('issues.')) await this.endOriginalPull(event, label);
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
    if (kind === 'ci_success') await this.startSecurityReview(event);
    this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
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
    if (!own?.escalateTo || !job.event.pull_request || !ROUND_KINDS.has(own.kind)) return undefined;
    const target = this.config.routes.get(own.escalateTo);
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
    if (base.fallbackTo && (this.cooldowns.get(base.tier) || 0) > now) {
      const fallback = this.config.routes.get(base.fallbackTo);
      if (fallback && (this.cooldowns.get(fallback.tier) || 0) <= now) return { route: fallback, fellBack: base.fallbackTo };
    }
    return { route: base };
  }

  // When a job that hit a quota hold may start again: the earliest end of the holds of the routes it can run on (its own or escalated route
  // and that route's fallback), or undefined when one of them is free now (a fallback takes over at once).
  earliestStart(job: Job, now: number): number | undefined {
    const base = this.escalationTarget(job) ?? this.route(job.label);
    const tiers = [base.tier, ...(base.fallbackTo && this.config.routes.get(base.fallbackTo) ? [this.config.routes.get(base.fallbackTo)!.tier] : [])];
    const earliest = Math.min(...tiers.map((tier) => this.cooldowns.get(tier) || 0));
    return earliest > now ? earliest : undefined;
  }

  // The wire of the dispatcher's forge: every call it makes passes here (and below that, through the dry run gate of the transport).
  forgejoCall(event: { repository: { full_name: string } }, method: string, path: string, body?: unknown): Promise<Json> {
    return this.transport(event.repository.full_name, method, path, body);
  }

  // The reviewer approved the pull request (label): merge it when the operator's policy for the repository allows.
  async approve(event: ForgeEvent): Promise<string> {
    if (Array.isArray(event.previous_labels) && event.previous_labels.includes(this.config.approvedLabel)) return 'already_approved';
    return this.merger.handle(event);
  }

  // The open issues the given issue depends on. Without Forgejo access, or when the call fails, none: the issue is not held back.
  // A 404 here is not a read error: the ticket's own read tells a deleted ticket (its waiting jobs are dropped, and a job of it is `deleted` when the
  // caller looks again) from a ticket without dependencies (nothing to wait for). Only a 404 of the ticket itself counts as deleted.
  async openDependencies(event: NormalizedEvent, number: number): Promise<number[]> {
    if (!this.config.forgejo) return [];
    try {
      const dependencies = await this.forge.dependencies(event.repository.full_name, number);
      return (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open').map((issue) => issue.number);
    } catch (error) {
      if (/HTTP 404\b/.test(error.message) && !('pull_request' in event && event.pull_request)) {
        await this.checkAndDropDeleted(event.repository.full_name, number);
        return [];
      }
      this.logger.error('could not read the dependencies of #' + number + ':', error.message);
      return [];
    }
  }

  // Whether the forge has no such issue: a 404 on GET /issues/{n}. Any other failure throws.
  async ticketGone(repository: string, number: number): Promise<boolean> {
    try {
      await this.forge.getIssue(repository, number);
      return false;
    } catch (error) {
      if (/HTTP 404\b/.test(error.message)) return true;
      throw error;
    }
  }

  // The ticket is checked and, when the forge says it is deleted, its waiting and queued jobs are dropped. Best effort: a failed read changes nothing.
  async checkAndDropDeleted(repository: string, number: number): Promise<boolean> {
    try {
      if (!(await this.ticketGone(repository, number))) return false;
    } catch (error) {
      this.logger.error('could not check whether #' + number + ' of ' + repository + ' still exists:', error.message);
      return false;
    }
    return this.dropDeleted(repository, number, false);
  }

  // A ticket (or, with `pull`, a pull request) is deleted in the forge: its waiting and queued jobs end as `deleted`, with no comment, no hand-over
  // and no mail. An issue's jobs are closed on the status page too (archived_view); running jobs are left alone. One log line per ticket.
  // Dry runs change nothing.
  async dropDeleted(repository: string, number: number, pull: boolean): Promise<boolean> {
    if (isDry(this.config, repository)) return false;
    const name = repository.toLowerCase();
    const ticket = name + '#' + number;
    const jobs = this.jobs.list(true).filter((job) => (job.status === 'waiting' || job.status === 'queued')
      && job.event.repository.full_name.toLowerCase() === name
      && (pull ? job.event.pull_request?.number === number : job.key.split(':')[0] === ticket));
    if (!jobs.length) return false;
    const now = this.now();
    for (const job of jobs) {
      Object.assign(job, { status: 'deleted', finished: now, result: 'deleted' });
      delete job.waiting_for; delete job.waiting_for_files;
    }
    if (!pull) this.jobs.markClosed(ticket);
    metrics.inc('forgehands_deleted_tickets_total');
    this.logger.error(repository + (pull ? '!pr' : '#') + number + ': deleted in the forge, its waiting jobs are dropped');
    await this.jobs.persist(now);
    return true;
  }

  // The same for a ticket of the ledger ("repo#n" or "repo!pr<n>"), as the ledger sync names it.
  async dropDeletedTicket(ticket: string): Promise<boolean> {
    const match = /^(.+?)([#!])(?:pr)?(\d+)$/.exec(ticket);
    if (!match) return false;
    return this.dropDeleted(match[1], Number(match[3]), match[2] === '!');
  }

  // An issue closed: what depended on it may start now (a waiting job), and an epic whose last dependency this was is reviewed.
  async onClosed(event: ForgeEvent): Promise<string> {
    await this.markClosed(event.repository.full_name.toLowerCase() + '#' + event.issue.number);
    if (!this.config.forgejo) return 'no_forgejo_access';
    await this.releaseFileWaitsNow();
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
      } else if ((target.labels || []).some((label: Json) => this.config.epicLabels.has(label.name))) {
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
    await this.releaseFileWaitsNow();
    const repository = event.repository.full_name;
    let closed = 0;
    try {
      const pulls = await this.forge.listPulls(repository, { state: 'closed', sort: 'recentupdate', limit: 20 });
      for (const pr of Array.isArray(pulls) ? pulls : []) {
        const match = /^ai\/issue-(\d+)$/.exec(String(pr?.head?.ref || ''));
        if (!match || !pr.merged || (event.repository.default_branch && pr.base?.ref && pr.base.ref !== event.repository.default_branch)) continue;
        const number = Number(match[1]);
        const issue = await this.forge.getIssue(repository, number);
        if (issue && issue.state === 'closed' && !issue.pull_request) await this.markClosed(repository.toLowerCase() + '#' + number);
        if (!issue || issue.state !== 'open' || issue.pull_request) continue;
        // A forge may refuse to close the ticket (Forgejo answers 412 while issues it depends on are open). That must neither stop the other
        // tickets of this pass nor repeat every push (and comment every time): the refusal is remembered for six hours.
        const ticket = repository.toLowerCase() + '#' + number;
        if ((this.closeRefused.get(ticket) || 0) > this.now()) continue;
        try {
          await this.forge.closeIssue(repository, number);
        } catch (error) {
          this.closeRefused.set(ticket, this.now() + 6 * 3600000);
          this.logger.error('could not close #' + number + ' of ' + repository + ' (its pull request #' + pr.number + ' is merged), trying again in six hours:', error.message);
          continue;
        }
        await this.forge.addComment(repository, number, 'ForgeHands: closed, the pull request #' + pr.number + ' for this ticket is merged.', 'issue');
        await this.markClosed(ticket);
        this.noteTicket(ticket, { merged_at: Date.parse(pr.merged_at as string) || this.now(), merged_by: 'human' });
        closed += 1;
      }
    } catch (error) {
      this.logger.error('could not close the tickets of merged pull requests:', error.message);
    }
    return closed;
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

  // REVERT_ON_RED: a CI run failed on the default branch for a commit that ForgeHands merged (the ledger knows it, see Merger.recordMerge). Once per
  // commit: the merged pull request is told, the human is told at once, and a route of kind main_red (when one exists) starts a run that reverts
  // the merge in a pull request ai/revert-<n>. Without that route the human is called on the pull request. A red revert only tells the human: no
  // revert of a revert. A failure outside the window or of a commit ForgeHands did not merge does nothing.
  async onMainFailure(event: ForgeEvent): Promise<{ status: string }> {
    if (!this.config.revertOnRed) return { status: 'revert_off' };
    if (!this.config.forgejo) return { status: 'no_forgejo_access' };
    const repository = event.repository.full_name;
    const sha = event.ci!.commit_sha.toLowerCase();
    const merge = this.jobs.merges.find((entry) => entry.repository === repository.toLowerCase() && entry.sha?.toLowerCase() === sha);
    if (!merge) return { status: 'not_our_merge' };
    if (this.now() - merge.merged_at > this.config.revertWindowMinutes * 60000) return { status: 'outside_window' };
    if (await this.commitRecovered(event)) return { status: 'ci_not_red' };
    const key = 'main_red:' + repository.toLowerCase() + '@' + sha;
    if (this.jobs.noted(key)) return { status: 'duplicate' };
    this.jobs.note(key, this.now());
    try { await this.jobs.persist(this.now()); } catch (error) { this.logger.error('persist failed:', error.message); }
    const number = merge.number;
    const short = sha.slice(0, 8);
    const branch = event.repository.default_branch || 'the default branch';
    let title = '';
    try { title = String((await this.forge.getPull(repository, number))?.title || ''); } catch (error) { this.logger.error('could not read #' + number + ':', error.message); }
    // The pull request as the notice names it: the merged one, or the revert that went red (whose merge was a revert).
    const told = { ...event, issue: { ...event.issue, number, title: title.slice(0, 1000), html_url: null }, pull_request: { number, head_ref: merge.branch, html_url: null } };
    if (REVERT_BRANCH.test(merge.branch)) {
      this.tell('failed', told, { why: 'revert_red' });
      return { status: 'revert_red_told' };
    }
    const route = [...this.config.routes].find(([, entry]) => entry.kind === 'main_red')?.[0];
    this.tell('failed', told, { why: 'main_red' });
    try {
      await this.forge.addComment(repository, number, (route ? '' : mentionOf(this.config)) + 'ForgeHands: CI failed on ' + branch + ' after this merge (commit ' + short + ').'
        + (route ? ' A revert is started.' : ' A human has to look at it.'));
    } catch (error) {
      this.logger.error('could not comment on #' + number + ':', error.message);
    }
    if (!route) return { status: 'handed_to_human' };
    const job = this.jobs.add({ key: repository.toLowerCase() + '!pr' + number + ':' + route + ':' + short, label: route, status: 'queued', created: this.now(),
      event: { type: 'ci.main_failure', source: this.forge.kind, action: 'main_red', label: route, repository: event.repository,
        issue: { number, title: title.slice(0, 1000), body: '', html_url: null, comments: 0, labels: [] }, ci: event.ci, sender: event.sender } });
    try {
      await this.jobs.persist(this.now());
    } catch (error) {
      this.jobs.remove(job.id); // not durable: the retried delivery must be able to start it again
      this.jobs.dedupe.delete(key);
      throw error;
    }
    this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    return { status: 'queued' };
  }

  // A CI outcome kept while an agent worked on the issue. Once no run of the issue is active any more it is judged as if it had just
  // arrived: gone when its commit is no longer the head or the status is not green (a later event can come again), otherwise started.
  async releaseDeferred(job: Job, now: number): Promise<boolean> {
    const base = job.key.split(':')[0] + ':';
    if (this.jobs.list(true).some((other) => other.id !== job.id && !other.waiting_for_run && other.key.startsWith(base) && !this.parallelReview(other, job.event))) {
      if (job.created + this.config.maxRunMs < now) { this.jobs.remove(job.id); return true; }
      return false;
    }
    const event = job.event;
    const kind = this.config.routes.get(job.label)?.kind;
    let start = !(await this.isStale(event));
    if (start && (kind === 'ci_success' || kind === 'sensitive_review')) start = await this.commitGreen(event);
    if (start && kind === 'ci_failure') start = !(await this.commitRecovered(event));
    if (start && ROUND_KINDS.has(kind) && this.rounds(event) >= this.roundLimit(event)) {
      await this.roundsUsedUp(event);
      start = false;
    }
    if (!start) { this.jobs.remove(job.id); return true; }
    delete job.waiting_for_run;
    job.status = 'queued';
    await this.merger.clearApproval(event);
    if (kind === 'ci_success') await this.startSecurityReview(event);
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

  // A green commit of a pull request that changes a protected path (the deny list of the merge policy of its repository) also gets a
  // security review, once per commit, when a route of kind sensitive_review exists. It is advisory: no label, no round, no merge.
  async startSecurityReview(event: ForgeEvent): Promise<void> {
    const route = [...this.config.routes].find(([, entry]) => entry.kind === 'sensitive_review')?.[0];
    if (!route || !event.pull_request || !event.ci || !this.config.forgejo) return;
    const key = this.issueKey(event) + ':' + route + ':' + event.ci.commit_sha.slice(0, 8);
    if (this.jobs.list().some((job) => job.key === key)) return;
    const policy = this.config.mergePolicy.get(event.repository.full_name.toLowerCase());
    if (!policy) return;
    try {
      const files = await this.merger.changedFiles(event.repository.full_name, event.pull_request.number);
      const hit = [...new Set(files.filter((name) => policy.deny.some((pattern) => pattern.test(name))))];
      if (!hit.length) return;
      this.jobs.add({ key, label: route, event: { ...event, type: 'ci.sensitive', label: route, protected_files: hit.slice(0, 20) }, status: 'queued', created: this.now() });
      await this.jobs.persist(this.now());
    } catch (error) {
      this.logger.error('could not start the security review of ' + this.issueKey(event) + ':', error.message);
    }
  }

  // The security review is advisory: when its run ends without the comment, run it once more; after that it is only logged.
  async checkSecurityReview(job: Job): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || (pr.head?.sha && pr.head.sha !== event.ci.commit_sha)) return;
      if (await this.merger.securityReview(event.repository.full_name, event.pull_request.number, event.ci.commit_sha)) { await this.handOverAfterSecurity(job); return; }
      if (!job.verdict_retry) {
        Object.assign(job, { status: 'queued', verdict_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.logger.error('security review ' + job.key + ' ended without a comment, running it once more');
        return;
      }
      this.logger.error('security review ' + job.key + ' ended twice without a comment');
      await this.handOverAfterSecurity(job);
    } catch (error) {
      this.logger.error('could not check the security review of #' + event.pull_request.number + ':', error.message);
    }
  }

  // The hand-over of an approved protected-path pull request waits for its security review (see Merger.handle); when that run has ended
  // (with its comment, without one, or failed) the approval is looked at again, which hands the pull request over with what was found.
  async handOverAfterSecurity(job: Job): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || pr.head?.sha !== event.ci.commit_sha) return;
      const labelled = (pr.labels || []).some((label: Json) => label.name === this.config.approvedLabel);
      if (!labelled && !(this.config.verdictSource !== 'comment' && (await this.merger.reviewOf(event.repository.full_name, event.pull_request.number, pr.head.sha)).ok)) return;
      await this.merger.handle(event);
    } catch (error) {
      this.logger.error('could not hand #' + event.pull_request.number + ' over after its security review:', error.message);
    }
  }

  // The rounds are used up: say so on the pull request and mark it for a human. Best effort, a failure is only logged.
  async roundsUsedUp(event: ForgeEvent): Promise<void> {
    const limit = this.roundLimit(event);
    this.logger.error(this.issueKey(event) + ': ' + limit + ' rounds used up, not starting another');
    await this.markForHuman(event, 'ForgeHands: ' + limit + ' follow-up rounds for ' + (event.bot ? 'this dependency update' : 'issue #' + event.issue.number) + ' are used up. A human has to look at this pull request now.', 'rounds_used_up');
  }

  // Say why on the pull request and label it for a human. Best effort, a failure is only logged.
  async markForHuman(event: ForgeEvent, text: string, reason = 'other', facts: Partial<Facts> = {}): Promise<void> {
    metrics.inc('forgehands_blocks_total', { reason });
    this.noteTicket(this.issueKey(event), { blocked_at: this.now() });
    this.tell(reason === 'conflict' ? 'conflict' : reason === 'failed_run' ? 'failed' : 'blocked', event, { why: reason, ...facts });
    if (!this.config.forgejo) return;
    const { number } = event.pull_request!;
    const repository = event.repository.full_name;
    try {
      await this.forge.addComment(repository, number, mentionOf(this.config) + text);
      const label = await this.forge.findOrCreateLabel(repository, this.config.blockedLabel, '#b60205');
      await this.forge.addLabels(repository, number, [label]);
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
      const data = collectDigest(this.config, this.jobs, [...this.reminder.waiting.values()], this.cooldowns, now);
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

  // How long (ms) until the quota is back, when the run ended with a rate limit error; null for any other failure.
  // The error a run ended with, from its last events: whether the model was out of quota (and, when the gateway says, for how long), or
  // whether the agent reached its iteration limit. Null when there is no error event or it cannot be read.
  async lastError(job: Job): Promise<{ code: string; rateLimited: boolean; unavailable?: boolean; waitMs: number | null } | null> {
    try {
      const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/search?limit=10&sort_order=TIMESTAMP_DESC');
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
      this.logger.error('could not read the error of ' + job.key + ':', error.message);
      return null;
    }
  }

  // A worker run on a ticket that ends as `finished` is not a delivery. A model that answers in words without a tool call can "finish" in a minute
  // with nothing done, and the ticket then waits for ever (several tickets did). A run on an issue (not a plan or an epic) must leave a pull request
  // from the branch ai/issue-<n> that was created or changed since the run started, or a comment on the issue written since then, or close the issue.
  // Otherwise the run is made once more; after the second empty run a human is called. Best effort: when the forge cannot be read nothing happens.
  async checkDelivery(job: Job): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event || event.pull_request || event.type === 'epic.done' || !job.started) return;
    if (this.config.epicLabels.has(job.label) || (event.issue.labels || []).some((name) => this.config.epicLabels.has(name))) return;
    try {
      const since = job.started - 60000;
      const repository = event.repository.full_name;
      const issue = await this.forge.getIssue(repository, event.issue.number);
      if (!issue || issue.state !== 'open') return;
      const branch = 'ai/issue-' + event.issue.number;
      const pulls = await this.forge.listPulls(repository, { state: 'all', limit: 50, sort: 'recentupdate' });
      if (pulls.some((pr) => pr.head?.ref === branch && Date.parse(pr.updated_at) >= since)) return;
      const comments = await this.forge.listComments(repository, event.issue.number, 50);
      if (comments.some((comment) => Date.parse(comment.created_at) >= since)) return;
      const parent = await this.parentDelivery(event, since);
      if (parent) {
        Object.assign(job, { delivered_on: parent });
        this.logger.error(repository + '#' + event.issue.number + ': delivered as a comment on #' + parent);
        return;
      }
      if (!job.delivery_retry) {
        Object.assign(job, { status: 'queued', delivery_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.logger.error(job.key + ' finished without a pull request or a comment, running it once more');
        return;
      }
      Object.assign(job, { status: 'failed', result: 'no_delivery' });
      this.tierRunEnded(job, 'no_delivery');
      await this.reportFailure(job, 'no_delivery');
    } catch (error) {
      this.logger.error('could not check what ' + job.key + ' delivered:', error.message);
    }
  }

  // A worker on a ticket that blocks another (the parent, where its report belongs) may deliver by a comment of the agent on that parent. Returns
  // the number of the parent, or null. A read that fails counts as no comment: an unknown answer never reads as delivered.
  async parentDelivery(event: ForgeEvent, since: number): Promise<number | null> {
    let login: string | null;
    let parents: Json;
    try {
      login = (await this.forge.agentLogin?.()) ?? null;
      if (!login) return null;
      parents = await this.forge.blocks(event.repository.full_name, event.issue.number);
    } catch (error) {
      this.logger.error('could not read what #' + event.issue.number + ' blocks:', error.message);
      return null;
    }
    for (const parent of Array.isArray(parents) ? parents : []) {
      try {
        const comments = await this.forge.listComments(event.repository.full_name, parent.number, 50);
        if (comments.some((comment) => String(comment.user?.login || '').toLowerCase() === login && Date.parse(comment.created_at) >= since)) return parent.number;
      } catch (error) {
        this.logger.error('could not read the comments of #' + parent.number + ':', error.message);
      }
    }
    return null;
  }

  // A review run that ended without a verdict (neither the approval nor the changes label) would leave the pull request standing
  // for ever, green and unseen. Unless it moved on meanwhile, run it once more; after the second miss hand it to a human.
  async checkVerdict(job: Job): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event?.pull_request || !event.ci) return;
    try {
      const pr = await this.forge.getPull(event.repository.full_name, event.pull_request.number);
      if (!pr || pr.state !== 'open' || pr.merged || (pr.head?.sha && pr.head.sha !== event.ci.commit_sha)) return;
      const names = (pr.labels || []).map((label: Json) => label.name);
      // No worker fixes a bot's pull request (BOT_FIX_ROUNDS is 0): a review that asks for changes hands it to a human, as the reviewer should have.
      if (event.bot && !this.config.botFixRounds && names.includes(this.config.changesLabel) && ![this.config.approvedLabel, this.config.blockedLabel].some((name) => names.includes(name))) {
        await this.markForHuman(event, 'ForgeHands: the review of commit ' + event.ci.commit_sha.slice(0, 8) + ' asks for changes to this dependency update, and no worker fixes bot pull requests. A human has to look at it.', 'bot_pull_request');
        return;
      }
      if ([this.config.approvedLabel, this.config.changesLabel, this.config.blockedLabel].some((name) => names.includes(name)) && this.config.verdictSource !== 'review') return;
      // Native reviews: any approval or request for changes on the head commit is a verdict (the webhook of the review does the rest).
      if (this.config.verdictSource !== 'comment' && (await this.merger.nativeReviews(event.repository.full_name, event.pull_request.number, event.ci.commit_sha)).any) return;
      if (this.config.verdictSource === 'review' && names.includes(this.config.blockedLabel)) return;
      // The first time, review once more: such a run mostly ends early (a blind command, a spent iteration budget), not for good.
      if (!job.verdict_retry) {
        Object.assign(job, { status: 'queued', verdict_retry: 1, started: undefined, conversation_id: undefined, finished: undefined, result: undefined });
        this.logger.error('review ' + job.key + ' ended without a verdict, running it once more');
        return;
      }
      await this.markForHuman(event, 'ForgeHands: the review of commit ' + event.ci.commit_sha.slice(0, 8) + ' ended twice without a verdict (' + (this.config.verdictSource === 'review' ? 'no approving or rejecting review' : 'no ' + this.config.approvedLabel + ' and no ' + this.config.changesLabel) + '). A human has to look at this pull request, or push a commit to start the review again.', 'no_verdict');
    } catch (error) {
      this.logger.error('could not check the verdict of #' + event.pull_request.number + ':', error.message);
    }
  }

  // The hold on a tier lives in memory and is gone after a restart; the wait of a job that was queued again for a rate limit lives in the
  // ledger. A restart clears both, so that it means "try again now" (the quota may be back, or the model was changed). If the model is still
  // out of quota the first attempt fails again and sets the hold anew (a counter keeps that from going on for ever).
  clearQuotaHolds(): number {
    let cleared = 0;
    for (const job of this.jobs.list('queued')) {
      if (job.retry_at) { delete job.next_try; delete job.retry_at; cleared += 1; }
    }
    return cleared;
  }

  async start(intervalMs = this.config.pollMs): Promise<void> {
    if (this.clearQuotaHolds()) await this.jobs.persist(this.now());
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

  // A run ended for good (not queued again): count it by kind and end state and time it.
  runEnded(job: Job, state: string, now: number): void {
    const kind = this.config.routes.get(job.label)?.kind || 'issue';
    metrics.inc('forgehands_runs_finished_total', { kind, state: known(state, ['finished', 'error', 'stuck', 'deleted', 'paused', 'timeout']) });
    if (job.started) metrics.observe({ kind }, Math.max(0, now - job.started) / 1000);
    this.tierRunEnded(job, state);
  }

  // The same end, counted per repository and the tier the run really ran on (fallback and escalation included).
  tierRunEnded(job: Job, state: string): void {
    const tiers = new Set([...this.config.routes.values()].map((route) => route.tier));
    metrics.inc('forgehands_tier_runs_total', {
      repository: known(String(job.event?.repository?.full_name).toLowerCase(), this.config.allowedRepos), tier: known(this.tierOf(job), tiers),
      result: known(state, ['finished', 'max_iterations', 'error', 'stuck', 'timeout', 'no_delivery'])
    });
  }

  // Ticks never overlap: a caller waits for the running one and then runs a fresh pass.
  async tick(): Promise<void> {
    while (this.current) await this.current.catch(() => {});
    this.current = this.pass();
    try { await this.current; } finally { this.current = null; }
  }

  async pass(): Promise<void> {
    let changed = false;
    const now = this.now();
    // The disk guard is read first: a hold set here keeps the queued jobs waiting in the loop below.
    await this.workspace.poll();
    for (const job of this.jobs.list('running')) {
      if (await this.poll(job, now)) changed = true;
    }
    for (const job of this.jobs.list(true).filter((entry) => entry.status === 'waiting' && entry.waiting_for_run)) {
      if (await this.releaseDeferred(job, now)) changed = true;
    }
    this.depReads = 0;
    if (await this.breakWaitCycles()) changed = true;
    // Each queued job is tried at most once per pass; what to try next is decided by pickNext.
    const tried = new Set<string>();
    let started = 0;
    for (;;) {
      const job = this.pickNext(now, tried);
      if (!job) break;
      tried.add(job.id);
      if (await this.startJob(job, now)) changed = true;
      if (job.started === now) started += 1;
    }
    if (started) this.lastStart = now;
    this.reportIdle(now, started);
    this.checkStall(now);
    if (await this.refreshMoved(now)) changed = true;
    // Two-key merges on hold (TWO_KEYS_HOLD_MINUTES): the due ones are looked at, the merge comes when the hold has ended.
    if (await this.merger.recheckHolds()) changed = true;
    if (await this.archiveOld(now)) changed = true;
    if (await this.deleteOld(now)) changed = true;
    if (await this.sweepClosed(now)) changed = true;
    if (await this.reminder.run(now)) changed = true;
    if (await this.sendDigest(now)) changed = true;
    if (changed) await this.jobs.persist(this.now());
  }

  // The default branch of a repository moved. Remember the newest push and look at the pull requests once it has been quiet for a while.
  onMainMoved(event: PushEvent): string {
    if (!this.config.updateBranches || !this.config.forgejo) return 'branch_updates_off';
    this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.now(), event });
    return 'scheduled';
  }

  async refreshMoved(now: number): Promise<boolean> {
    let changed = false;
    for (const [repository, moved] of [...this.mainMoved]) {
      if (now - moved.at < this.config.branchUpdateDelayMs) continue;
      this.mainMoved.delete(repository);
      try { if (await this.refreshBranches(moved.event)) changed = true; }
      catch (error) { this.logger.error('could not look at the pull requests of ' + repository + ':', error.message); }
    }
    return changed;
  }

  // Open agent pull requests (branch ai/issue-<n>) that fell behind the default branch. What a rebase throws away is a review, so only a
  // pull request with neither an approval nor an OK review for its current commit is brought up to date, and only when no agent works on
  // its issue. A rebase that conflicts becomes a conflict round of the worker. Approved and reviewed pull requests are left alone: they
  // merge as they are, and a conflict shows when the merge is tried.
  async refreshBranches(event: PushEvent): Promise<boolean> {
    const tip = event.after;
    const pulls = await this.forge.listPulls(event.repository.full_name, { state: 'open', limit: 50 });
    let changed = false;
    let deferred = false;
    for (const pr of Array.isArray(pulls) ? pulls : []) {
      const outcome = await this.refreshPull(event, pr, tip);
      if (outcome.changed) changed = true;
      if (outcome.deferred) deferred = true;
    }
    // Look again later at what was postponed (the CI run ended, the cooldown passed).
    if (deferred) this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.now(), event });
    return changed;
  }

  // One open pull request against the default branch at `tip`: bring it up to date, or start a conflict round when the rebase conflicts.
  async refreshPull(event: PushEvent, pr: Json, tip: string): Promise<{ changed: boolean; deferred: boolean }> {
    const none = { changed: false, deferred: false };
    const base = event.repository.full_name.toLowerCase() + '#';
    const match = /^ai\/issue-(\d+)$/.exec(pr.head?.ref || '');
    if (!match || pr.state !== 'open' || pr.merged || !pr.merge_base || pr.merge_base === tip) return none;
    if (pr.head?.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== event.repository.full_name.toLowerCase()) return none;
    const issue = Number(match[1]);
    if (this.jobs.list(true).some((job) => job.key.startsWith(base + issue + ':'))) return none;
    const labels = (pr.labels || []).map((label: Json) => label.name);
    if (labels.includes(this.config.blockedLabel)) return none;
    const approved = labels.includes(this.config.approvedLabel);
    const prEvent = { ...event, pull_request: { number: pr.number, head_ref: pr.head.ref, html_url: pr.html_url || null },
      issue: { number: issue, title: String(pr.title || '').slice(0, 1000), body: String(pr.body || '').slice(0, 50000), html_url: pr.html_url || null, comments: 0, labels } };
    let reviewed = approved;
    if (!reviewed) { try { reviewed = (await this.merger.reviewOf(event.repository.full_name, pr.number, pr.head.sha)).ok; } catch { reviewed = false; } }
    // An approved or reviewed pull request is not brought up to date: that would throw the review away, and it merges as it is. But one
    // that conflicts can be merged by nobody (a human waiting to merge a protected path would find it so). Once the WIP marker is gone,
    // which approval removes, Forgejo's mergeable is reliable: a conflict starts a conflict round, after which CI and review run again.
    if (reviewed) {
      if (pr.mergeable === false && !this.forge.isWip(String(pr.title || '')) && (await this.startConflictRound(prEvent, tip))) return { changed: true, deferred: false };
      return none;
    }
    // An update changes the head commit: it cancels the CI run in progress and throws away a review. So it only happens where it
    // is needed (the branch and the default branch touch the same files) and not while CI runs or just after the last update.
    if (!(await this.touchesSameFiles(event, pr, tip))) return none;
    const hold = await this.updateHold(event, pr);
    if (hold) { this.logger.error(event.repository.full_name + '#' + pr.number + ': update postponed (' + hold + ')'); return { changed: false, deferred: true }; }
    this.lastUpdate.set(base + pr.number, this.now());
    try {
      if (await this.forge.updateBranch(event.repository.full_name, pr.number) === 'conflict') {
        metrics.inc('forgehands_branch_conflicts_total');
        if (await this.startConflictRound(prEvent, tip)) return { changed: true, deferred: false };
        return none;
      }
      this.logger.error(event.repository.full_name + '#' + pr.number + ' brought up to date with the default branch');
      metrics.inc('forgehands_branch_updates_total');
    } catch (error) {
      this.logger.error('could not update #' + pr.number + ':', error.message);
    }
    return none;
  }

  // The default branch may have moved while a run on this pull request was active (such a pull request is left alone, see refreshPull), and
  // no later push brings it back into view. When the run ends, look at the pull request once: the same update, the same conflict round.
  async checkBranchAfterRun(job: Job): Promise<void> {
    const event = job.event;
    // A dependency bot keeps its own branch current (Renovate rebases itself).
    if (!this.config.updateBranches || !this.config.forgejo || !event?.pull_request || event.bot) return;
    const kind = this.config.routes.get(job.label)?.kind;
    if (kind === 'conflict' || kind === 'sensitive_review') return;
    try {
      const branch = event.repository.default_branch;
      if (!branch) return;
      const tip = await this.forge.branchTip(event.repository.full_name, branch);
      if (typeof tip !== 'string' || !tip) return;
      const pr = await this.forge.getPull(event.repository.full_name, event.pull_request.number);
      const push = { type: 'push.default', source: this.forge.kind, repository: event.repository, sender: event.sender, after: tip } as unknown as PushEvent;
      const outcome = await this.refreshPull(push, pr, tip);
      if (outcome.deferred) this.mainMoved.set(event.repository.full_name.toLowerCase(), { at: this.now(), event: push });
      if (outcome.changed) this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    } catch (error) {
      this.logger.error('could not look at the branch of #' + event.pull_request.number + ' after its run:', error.message);
    }
  }

  // Can the rebase of this pull request conflict? Only if the default branch changed a file since the merge base that the pull request
  // changes too. Anything unclear (a failing call, a list that may be cut off) counts as yes.
  async touchesSameFiles(event: PushEvent, pr: Json, tip: string): Promise<boolean> {
    try {
      const compare = await this.forge.compare(event.repository.full_name, pr.merge_base, tip);
      const ours = await this.forge.pullFiles(event.repository.full_name, pr.number, 100);
      if (!Array.isArray(compare?.files) || !Array.isArray(ours) || ours.length >= 100 || ((compare.total_commits ?? 0) > 0 && compare.files.length === 0)) return true;
      const names = (list: Json[]) => list.flatMap((file) => [file.filename, file.previous_filename]).filter(Boolean);
      const theirs = new Set(names(compare.files));
      return names(ours).some((name) => theirs.has(name));
    } catch (error) {
      this.logger.error('could not compare #' + pr.number + ' with the default branch:', error.message);
      return true;
    }
  }

  // Why the update of this pull request has to wait, or null: CI still runs on its head commit, or its branch was updated recently.
  async updateHold(event: PushEvent, pr: Json): Promise<string | null> {
    const last = this.lastUpdate.get(event.repository.full_name.toLowerCase() + '#' + pr.number);
    if (last && this.now() - last < this.config.branchUpdateMinIntervalMs) return 'cooldown';
    try {
      const status = await this.forge.commitStatus(event.repository.full_name, pr.head.sha);
      if (status?.state === 'pending' && status.total_count > 0) return 'CI is still running';
    } catch (error) {
      this.logger.error('could not read the status of #' + pr.number + ':', error.message);
    }
    return null;
  }

  // The branch of a pull request conflicts with the default branch: a round of the worker resolves it (rebase and one force push are
  // allowed in this round and only here). Counts as a round; without a conflict route, or when the rounds are used up, a human is called.
  async startConflictRound(event: ForgeEvent, tip: string): Promise<boolean> {
    const route = [...this.config.routes].find(([, entry]) => entry.kind === 'conflict')?.[0];
    const number = event.pull_request!.number;
    if (!route) {
      await this.markForHuman(event, 'ForgeHands: the pull request conflicts with ' + (event.repository.default_branch || 'the default branch') + ' and no conflict round is configured. A human has to resolve it.', 'conflict');
      return false;
    }
    const key = this.issueKey(event) + ':' + route + ':' + tip.slice(0, 8);
    if (this.jobs.list().some((job) => job.key === key)) return false;
    if (this.rounds(event) >= this.roundLimit(event)) { await this.roundsUsedUp(event); return false; }
    this.jobs.add({ key, label: route, status: 'queued', created: this.now(), event: { ...event, type: 'pull_request.conflict', label: route, base_sha: tip } });
    await this.merger.clearApproval(event);
    this.logger.error(this.issueKey(event) + ': pull request #' + number + ' conflicts with the default branch, conflict round queued');
    return true;
  }

  // WAIT_FOR_SAME_FILES: the older issues (lower numbers) whose files this worker job's issue also declares, because they have an open agent
  // pull request that changes them, or a job in the ledger and the same declared files. The oldest goes first, so no ticket ever waits
  // for a newer one and two tickets cannot wait for each other. Any failing read means "not held": a ticket is never stuck on a guess.
  async filesBlockers(job: Job): Promise<number[]> {
    const event = job.event;
    const mine = parseDeclaredFiles(event.issue.body);
    if (!this.config.waitForSameFiles || !this.config.forgejo || !mine.length) return [];
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const blockers = new Set<number>();
    try {
      const pulls = await this.forge.listPulls(repository, { state: 'open', limit: FILE_PULLS_LOOKED_AT });
      for (const pr of (Array.isArray(pulls) ? pulls : []).slice(0, FILE_PULLS_LOOKED_AT)) {
        const other = Number(/^ai\/issue-(\d+)$/.exec(String(pr?.head?.ref || ''))?.[1]);
        if (!other || other >= number || blockers.has(other)) continue;
        const files = await this.forge.pullFiles(repository, pr.number, 100);
        const names = (Array.isArray(files) ? files : []).flatMap((file) => [file.filename, file.previous_filename].filter((name): name is string => !!name));
        if (anyOverlap(mine, names)) blockers.add(other);
      }
      for (const other of this.jobs.list(true)) {
        const issue = other.event?.issue;
        if (!issue || other.event.bot || other.event.repository.full_name.toLowerCase() !== repository.toLowerCase()) continue;
        if (issue.number >= number || blockers.has(issue.number) || !ACTIVE_STATUSES.has(other.status)) continue;
        if (this.config.epicLabels.has(other.label) || !anyOverlap(mine, parseDeclaredFiles(issue.body))) continue;
        if ((await this.forge.getIssue(repository, issue.number))?.state === 'open') blockers.add(issue.number);
      }
    } catch (error) {
      this.logger.error('could not compare the files of #' + number + ' with the open work, it is not held back:', error.message);
      return [];
    }
    // A blocker that already waits for this ticket (explicit dependencies and the waits in force) would make a cycle: it is not waited for.
    const me = repository.toLowerCase() + '#' + number;
    const kept: number[] = [];
    for (const other of [...blockers].sort((a, b) => a - b)) {
      const key = repository.toLowerCase() + '#' + other;
      if (!(await this.waitReaches(key, me, true))) kept.push(other);
      else this.noteCycle(me, key);
    }
    return kept;
  }

  // Whether `to` is waited for, directly or through other waits, starting from `from`: the waits in force (the ledger's waiting jobs, explicit and, with
  // `files`, same-files) and, for a ticket that has no waiting job with explicit dependencies, its open dependencies in the forge (forgeEdges).
  async waitReaches(from: string, to: string, files: boolean): Promise<boolean> {
    const ledger = waitGraph(this.jobs.list(), files);
    const explicit = waitGraph(this.jobs.list(), false);
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i += 1) {
      const node = queue[i];
      if (node === to) return true;
      const edges = new Set(ledger.get(node) ?? []);
      if (!explicit.has(node)) for (const next of await this.forgeEdges(node)) edges.add(next);
      for (const next of edges) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return false;
  }

  // The open dependencies of a ticket, read from the forge. Cached per ticket for DEP_CACHE_MS; a failed read counts as none (cached too, so the
  // ticket is not read again in that time); past DEP_READS_PER_PASS reads in a pass the answer is none for now (not cached). A ticket whose jobs are
  // all archived (closed on the status page) is not read: its open dependencies do not hold anything back.
  async forgeEdges(node: string): Promise<string[]> {
    const cached = this.depCache.get(node);
    if (cached && this.now() - cached.at < DEP_CACHE_MS) return cached.open;
    const own = this.jobs.list().filter((job) => ticketKey(job) === node);
    if (!this.config.forgejo || (own.length && own.every((job) => job.archived_view))) return [];
    if (this.depReads >= DEP_READS_PER_PASS) return [];
    this.depReads += 1;
    const at = own[0]?.event.repository.full_name ?? node.split('#')[0];
    const number = Number(node.split('#')[1]);
    let open: string[] = [];
    try {
      const dependencies = await this.forge.dependencies(at, number);
      open = (Array.isArray(dependencies) ? dependencies : []).filter((issue) => issue.state === 'open').map((issue) => node.split('#')[0] + '#' + issue.number);
    } catch (error) {
      this.logger.error('could not read the dependencies of #' + number + ', its waits are not known for now:', error.message);
    }
    this.depCache.set(node, { at: this.now(), open });
    return open;
  }

  // A same-files wait that closes a cycle is not taken: the older ticket already waits for this one, through explicit dependencies or other waits in
  // force. Logged and counted once per pair (`waiting` is a ticket key, `other` the older one).
  noteCycle(waiting: string, other: string): void {
    const pair = waiting + '>' + other;
    if (this.cyclePairs.has(pair)) return;
    this.cyclePairs.add(pair);
    metrics.inc('forgehands_wait_cycles_broken_total');
    const number = other.split('#')[1];
    this.logger.error(waiting + ': not waiting for #' + number + ' (same files): #' + number + ' is blocked by this ticket (cycle)');
  }

  // The waits in force are read from the ledger (no forge read): a same-files wait that closes a cycle is dropped, the explicit dependencies never. A job
  // left with no wait is queued again. True when something changed.
  async breakWaitCycles(): Promise<boolean> {
    if (!this.config.waitForSameFiles) return false;
    let changed = false;
    for (const job of this.jobs.list('waiting')) {
      if (!job.waiting_for_files?.length || job.waiting_for?.length || job.waiting_for_run || job.event.bot || job.event.pull_request) continue;
      const me = ticketKey(job);
      const repository = job.event.repository.full_name.toLowerCase();
      const kept: number[] = [];
      for (const number of job.waiting_for_files) {
        const other = repository + '#' + number;
        if (await this.waitReaches(other, me, true)) this.noteCycle(me, other);
        else kept.push(number);
      }
      if (kept.length === job.waiting_for_files.length) continue;
      changed = true;
      if (kept.length) job.waiting_for_files = kept;
      else {
        job.status = 'queued';
        delete job.waiting_for_files;
        this.logger.error(job.key + ' no longer waits for the files of older tickets (cycle)');
      }
    }
    return changed;
  }

  // Look again at the jobs that wait for the same files and queue those whose older tickets are gone. Called when something may have
  // been freed (a push to the default branch, a closed issue, a run that ended); startJob checks once more before a worker starts.
  async releaseFileWaits(): Promise<boolean> {
    if (!this.config.waitForSameFiles) return false;
    let changed = false;
    for (const job of this.jobs.list('waiting')) {
      if (!job.waiting_for_files?.length || job.waiting_for?.length) continue;
      const blockers = await this.filesBlockers(job);
      if (blockers.length) { job.waiting_for_files = blockers; continue; }
      job.status = 'queued';
      delete job.waiting_for_files;
      this.logger.error(job.key + ' no longer waits for the files of older tickets');
      changed = true;
    }
    return changed;
  }

  // The same, from outside a pass (a webhook): save and start what was released.
  async releaseFileWaitsNow(): Promise<void> {
    try {
      if (!(await this.releaseFileWaits())) return;
      await this.jobs.persist(this.now());
      this.tick().catch((error) => this.logger.error('dispatch failed:', error.message));
    } catch (error) {
      this.logger.error('could not release the tickets that wait for the same files:', error.message);
    }
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
      const pr = (Array.isArray(pulls) ? pulls : []).find((entry) => entry?.head?.ref === 'ai/issue-' + number && entry.state === 'open');
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

  // The issue ("repo#number") is closed in the forge: its jobs leave the waiting and failed lists of the status page (see JobStore.markClosed).
  async markClosed(ticket: string): Promise<boolean> {
    if (isDry(this.config, ticket.split('#')[0]) || !this.jobs.markClosed(ticket)) return false;
    await this.jobs.persist(this.now()).catch((error) => this.logger.error('persist failed:', error.message));
    return true;
  }

  // The events of a closed issue can be missed (closed by hand while ForgeHands was down, or before this was kept). Once a day and at start,
  // look at the tickets that are in a state the status page shows as a problem (failed run, rounds used up, waiting) and mark those that the
  // forge says are closed. At most 20 reads per pass; the rest follows in the next hourly pass. A read that fails changes nothing.
  async sweepClosed(now: number): Promise<boolean> {
    if (!this.config.forgejo || now < this.nextClosedSweep) return false;
    const tickets = new Map<string, Job[]>();
    for (const job of this.jobs.list()) if (!job.key.split(':')[0].includes('!')) tickets.set(job.key.split(':')[0], [...(tickets.get(job.key.split(':')[0]) || []), job]);
    const candidates = [...tickets].filter(([ticket, list]) => {
      if (isDry(this.config, ticket.split('#')[0]) || list.every((job) => job.archived_view) || list.some((job) => job.status === 'running' || job.status === 'queued')) return false;
      const checked = this.closedChecked.get(ticket);
      if (checked !== undefined && now - checked < 86400000) return false;
      const rounds = list.filter((job) => ROUND_KINDS.has(this.config.routes.get(job.label)?.kind) && (job.started || job.status !== 'failed')).length;
      return list.some((job) => job.status === 'failed' || job.status === 'waiting') || rounds >= this.config.maxRounds;
    });
    this.nextClosedSweep = now + (candidates.length > 20 ? 3600000 : 86400000);
    let changed = false;
    for (const [ticket, list] of candidates.slice(0, 20)) {
      const [repository, number] = [list[0].event.repository.full_name, Number(ticket.split('#')[1])];
      try {
        const issue = await this.forge.getIssue(repository, number);
        if (!issue) continue;
        if (issue.state === 'closed') { if (await this.markClosed(ticket)) changed = true; }
        else this.closedChecked.set(ticket, now);
      } catch (error) {
        this.logger.error('could not read #' + number + ' of ' + repository + ':', error.message);
      }
    }
    return changed;
  }

  // Archive the conversations of runs that ended a while ago: the tag archived=true is added, every other tag stays, so the runs can still
  // be found by issue, pull request and kind. At most once an hour and 20 at a time; a conversation that is deleted or running is skipped.
  async archiveOld(now: number): Promise<boolean> {
    const days = this.config.archiveAfterDays;
    if (!days || (this.lastArchive && now - this.lastArchive < 3600000)) return false;
    this.lastArchive = now;
    const before = now - days * 86400000;
    let changed = false;
    let done = 0;
    for (const job of this.jobs.list()) {
      if (job.archived || !job.conversation_id || !job.finished || job.finished > before || (job.status !== 'done' && job.status !== 'failed')) continue;
      if (isDry(this.config, job.event.repository.full_name)) continue; // a dry run archives nothing, and must not mark it as done
      if (done++ >= 20) break;
      try {
        const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id));
        if (response.status === 404) { job.archived = true; changed = true; continue; }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = (await response.json()) as Json;
        if ((data.execution_status || data.status) === 'running') continue;
        const patched = await this.api('PATCH', '/api/conversations/' + encodeURIComponent(job.conversation_id), { tags: { ...(data.tags || {}), archived: 'true' } }, job.event.repository.full_name);
        if (!patched.ok) throw new Error('HTTP ' + patched.status);
        job.archived = true;
        changed = true;
      } catch (error) {
        this.logger.error('could not archive the run of ' + job.key + ':', error.message);
      }
    }
    return changed;
  }

  // DELETE_AFTER_DAYS: the step after archiving. The OpenHands conversation of an archived run that ended long enough ago is deleted (its
  // trajectory goes); the ledger keeps the run, its result, cost and tokens, and the status page shows no conversation link for it. Kept: a run
  // that is not terminal, a conversation another job still uses (any job of that conversation must be terminal, archived and old enough), and a
  // ticket that is open with a nudge or a resume pending. At most DELETE_PER_PASS deletions per pass, once an hour; a failed delete is tried again on
  // the next pass. A dry run deletes nothing. 404 means the conversation is gone already, which counts as deleted.
  lastDelete = 0;
  async deleteOld(now: number): Promise<boolean> {
    const days = this.config.deleteAfterDays;
    if (!days || (this.lastDelete && now - this.lastDelete < 3600000)) return false;
    this.lastDelete = now;
    const perPass = 40;
    const cutoff = (status: string) => now - (status === 'done' ? days : this.config.deleteFailedAfterDays) * 86400000;
    const all = this.jobs.list();
    // The tickets with a nudge or a resume pending, and the tickets that are closed (every job of them marked archived_view).
    const pending = new Set(all.filter((job) => job.nudge_pending || job.resume_pending).map((job) => job.key.split(':')[0]));
    const closed = new Set(all.filter((job) => job.archived_view).map((job) => job.key.split(':')[0]));
    const byConversation = new Map<string, Job[]>();
    for (const job of all) if (job.conversation_id) byConversation.set(job.conversation_id, [...(byConversation.get(job.conversation_id) || []), job]);
    let deleted = 0;
    let kept = 0;
    let changed = false;
    for (const [conversation, jobs] of byConversation) {
      if (jobs.every((job) => job.conversation_deleted)) continue;
      // Every job of the conversation must be finished with it (terminal, archived, old enough), else a run still needs it.
      const aged = (job: Job) => !!job.archived && !!job.finished && (job.status === 'done' || job.status === 'failed' || job.status === 'deleted') && job.finished <= cutoff(job.status);
      if (!jobs.every((job) => job.conversation_deleted || aged(job))) continue;
      const ticket = jobs[0].key.split(':')[0];
      if (pending.has(ticket) && !closed.has(ticket)) { kept += 1; continue; }
      if (deleted >= perPass) { kept += 1; continue; }
      if (isDry(this.config, jobs[0].event.repository.full_name)) continue; // a dry run deletes nothing, and marks nothing
      try {
        const response = await this.api('DELETE', '/api/conversations/' + encodeURIComponent(conversation), undefined, jobs[0].event.repository.full_name);
        if (response.status !== 404 && !response.ok) throw new Error('HTTP ' + response.status);
        for (const job of jobs) job.conversation_deleted = true;
        deleted += 1;
        changed = true;
        metrics.inc('forgehands_conversations_deleted_total');
        this.logger.log?.(jobs[0].key + ': conversation deleted');
      } catch (error) {
        kept += 1;
        this.logger.error('could not delete the conversation of ' + jobs[0].key + ', trying again on the next pass:', error.message);
      }
    }
    this.logger.error('conversations: ' + deleted + ' deleted, ' + kept + ' kept');
    return changed;
  }

  private route(label: string): Route {
    const route = this.config.routes.get(label);
    if (!route) throw new Error('no route for label ' + label);
    return route;
  }

  // Which queued job gets the next free slot. Between repositories the starts are shared by weight (REPO_WEIGHTS, default 1; a higher weight
  // means more of the starts): the repository with the fewest recent starts per unit of weight goes first, so weights 2, 1 and 5 give 2 of 8,
  // 1 of 8 and 5 of 8 starts when all three have work. Within a repository see `before`: begun tickets first, then the oldest ticket (lowest
  // issue number) that can start now, not the one that was queued first. A repository without a startable job does not take a share: the others use it.
  pickNext(now: number, tried: Set<string>): Job | null {
    const heads = new Map<string, Job>();
    for (const job of this.jobs.list('queued')) {
      if (tried.has(job.id) || (job.next_try && job.next_try > now) || !this.hasRoom(job, now)) continue;
      const repo = job.event.repository.full_name.toLowerCase();
      const best = heads.get(repo);
      if (!best || this.before(job, best)) heads.set(repo, job);
    }
    if (!heads.size) return null;
    const recent = new Map<string, number>();
    for (const job of this.jobs.list().filter((entry) => entry.started).sort((a, b) => (b.started || 0) - (a.started || 0)).slice(0, RECENT_STARTS)) {
      const repo = job.event.repository.full_name.toLowerCase();
      recent.set(repo, (recent.get(repo) || 0) + 1);
    }
    let pick: { repo: string; job: Job; score: number; weight: number } | null = null;
    for (const [repo, job] of heads) {
      const weight = this.config.repoWeights.get(repo) ?? 1;
      const score = (recent.get(repo) || 0) / weight;
      if (!pick || score < pick.score || (score === pick.score && (weight > pick.weight || (weight === pick.weight && repo < pick.repo)))) pick = { repo, job, score, weight };
    }
    return pick!.job;
  }

  // Order within a repository: work on a ticket that has begun (a round, a review, a fix, a conflict, an epic review) before a new ticket, so
  // that what was started gets finished; then the lowest issue number; then the job that was queued first.
  before(a: Job, b: Job): boolean {
    const begun = (job: Job) => (job.event.pull_request || job.event.type === 'epic.done' ? 0 : 1);
    if (begun(a) !== begun(b)) return begun(a) < begun(b);
    if (a.event.issue.number !== b.event.issue.number) return a.event.issue.number < b.event.issue.number;
    return a.created < b.created;
  }

  hasRoom(job: Job, now: number): boolean {
    return this.holdOf(job, now) === null;
  }

  // The limit that keeps a queued job from starting now, checked in this order, or null when it may start: low disk space (DISK_MIN_FREE_GB, running
  // jobs are not touched), the global concurrency, the quota hold of its tier (`tier` is that tier), the concurrency of its tier, the hourly limit.
  holdOf(job: Job, now: number): { reason: 'disk' | 'quota' | 'concurrency' | 'hourly'; tier?: string } | null {
    if (this.workspace.holding) return { reason: 'disk' };
    const running = this.jobs.list('running');
    if (running.length >= this.config.maxConcurrent) return { reason: 'concurrency' };
    const effective = this.effectiveRoute(job, now).route;
    const tier = effective.tier;
    if ((this.cooldowns.get(tier) || 0) > now) return { reason: 'quota', tier };
    const tierLimit = effective.maxConcurrent ?? this.config.maxConcurrentPerTier;
    if (running.filter((other) => this.tierOf(other) === tier).length >= tierLimit) return { reason: 'concurrency' };
    const startedLastHour = this.jobs.list().filter((other) => other.started && other.started > now - 3600000).length;
    if (startedLastHour >= this.config.maxRunsPerHour) return { reason: 'hourly' };
    return null;
  }

  // What holds the waiting and queued jobs back right now, counted per job with the waits the dispatcher already decides: an issue that depends on
  // open issues (and a CI result kept while its run goes on) is a dependency wait; a ticket that shares files with an older one is a files wait; a queued
  // job is held by holdOf. A queued job with a retry timer (next_try: a failed start, an error that is run again) waits for its time, not for a limit,
  // and is not counted.
  idleCounts(now: number): { reasons: IdleCounts; tiers: string[]; cycles: string[] } {
    const reasons: IdleCounts = { dependencies: 0, files: 0, quota: 0, disk: 0, hourly: 0, concurrency: 0, could_start: 0, cycle: 0 };
    const tiers = new Set<string>();
    // Explicit dependencies only: a cycle of them is not broken by ForgeHands (the planner or a human made it), so its jobs wait for ever.
    const cycles = findCycles(waitGraph(this.jobs.list(), false));
    const inCycle = new Set(cycles.flat());
    for (const job of this.jobs.list(true)) {
      if (job.status === 'waiting') {
        if (job.waiting_for?.length && inCycle.has(ticketKey(job))) reasons.cycle += 1;
        else if (job.waiting_for?.length || job.waiting_for_run) reasons.dependencies += 1;
        else if (job.waiting_for_files?.length) reasons.files += 1;
        continue;
      }
      if (job.status !== 'queued' || (job.next_try && job.next_try > now)) continue;
      const hold = this.holdOf(job, now);
      if (!hold) { reasons.could_start += 1; continue; }
      reasons[hold.reason] += 1;
      if (hold.tier) tiers.add(hold.tier);
    }
    return { reasons, tiers: [...tiers].sort(), cycles: cycles.map(cycleText) };
  }

  // The idle line of a pass in which something waits and nothing could start (`started` is the number of jobs this pass started). It is logged
  // when its composition changes and at most every 15 minutes otherwise; the same numbers are on /status.json and in the idle gauge.
  reportIdle(now: number, started: number): void {
    const { reasons, tiers, cycles } = this.idleCounts(now);
    const total = Object.values(reasons).reduce((sum, count) => sum + count, 0);
    // A dependency cycle is logged once, when it is found.
    for (const text of cycles) {
      if (this.cyclesLogged.has(text)) continue;
      this.cyclesLogged.add(text);
      this.logger.error(text + ', none of its tickets can start: a human has to break it');
    }
    if (started) this.idleLogged = null;
    if (started || !total) this.idle = null;
    if (!total) { this.stallAlertAt = null; this.idleLogged = null; }
    if (started || !total) return;
    this.idle = { since: this.idle?.since ?? now, reasons, tiers, cycles };
    const key = JSON.stringify([reasons, tiers]);
    if (this.idleLogged?.key === key && now - this.idleLogged.at < IDLE_LOG_EVERY_MS) return;
    this.idleLogged = { key, at: now };
    this.logger.error(idleLine(reasons, tiers));
  }

  idleState(): IdleState | null {
    return this.idle;
  }

  // STALL_ALERT_MINUTES: work waits on a hold that is not a dependency (quota, disk, a limit, or a job that could start and did not), no run is running,
  // and nothing has started for that long: one notification (kind stalled), and not again for six hours unless nothing waits any more. The waits on
  // dependencies and on files do not count: a chain of tickets is normal.
  checkStall(now: number): void {
    const minutes = this.config.stallAlertMinutes;
    if (!minutes || !this.idle) return;
    const { reasons, tiers, cycles } = this.idle;
    // A dependency cycle is not a normal chain: its jobs count as a hold too (the notification names the tickets).
    if (!(reasons.quota + reasons.disk + reasons.hourly + reasons.concurrency + reasons.could_start + reasons.cycle)) return;
    if (this.jobs.list('running').length || now - this.lastStart < minutes * 60000) return;
    if (this.stallAlertAt !== null && now - this.stallAlertAt < STALL_REPEAT_MS) return;
    if (!this.notifier.wants('stalled')) return;
    this.stallAlertAt = now;
    const quiet = Math.round((now - this.lastStart) / 60000);
    this.logger.error('stall alert: nothing has started for ' + quiet + ' min and no run is running. ' + idleLine(reasons, tiers));
    this.notifier.notify(stallMessage(this.config.notify.language, { minutes: quiet, reasons, tiers, cycles }));
  }

  async startJob(job: Job, now: number): Promise<boolean> {
    // Dependencies are looked at when the job is queued, but an edge may be added afterwards (a ticket labelled before its dependencies were
    // set): look again before a worker starts, so that the order the edges give is kept.
    if (this.config.routes.get(job.label)?.kind === 'issue' && !job.event.pull_request && this.config.forgejo) {
      const open = await this.openDependencies(job.event, job.event.issue.number);
      // The ticket was found deleted (and its jobs dropped): nothing starts for it.
      if (job.status === 'deleted') return true;
      if (open.length) {
        Object.assign(job, { status: 'waiting', waiting_for: open });
        this.logger.error(job.key + ' waits for ' + open.map((number) => '#' + number).join(', ') + ' (dependencies added after it was queued)');
        return true;
      }
    }
    // WAIT_FOR_SAME_FILES: an older ticket or pull request that changes the same files goes first.
    if (this.config.waitForSameFiles && this.config.routes.get(job.label)?.kind === 'issue' && !job.event.pull_request && !this.config.epicLabels.has(job.label)) {
      const blockers = await this.filesBlockers(job);
      if (blockers.length) {
        Object.assign(job, { status: 'waiting', waiting_for_files: blockers });
        this.logger.error(job.key + ' waits for ' + blockers.map((number) => '#' + number).join(', ') + ' (same files)');
        return true;
      }
      delete job.waiting_for_files;
    }
    if (job.event.ci && this.config.routes.get(job.label)?.kind === 'ci_failure' && (await this.commitRecovered(job.event))) {
      this.jobs.remove(job.id);
      return true;
    }
    const route = this.route(job.label);
    // The last round goes to the stronger profile of "escalate_to": same branch, same kind, same prompt and the limits of its own route.
    const target = this.escalationTarget(job);
    if (target && !job.escalated) {
      job.escalated = true;
      this.logger.error(job.key + ': round ' + this.rounds(job.event) + ' is escalated to ' + route.escalateTo);
      metrics.inc('forgehands_escalated_rounds_total');
    }
    const { route: effective, fellBack } = this.effectiveRoute(job, now);
    job.fell_back = fellBack;
    if (fellBack) this.logger.error(job.key + ': the tier of its route is out of quota, starting with the fallback route ' + fellBack);
    const body: Json = {
      workspace: { working_dir: this.config.workspaceDir },
      agent_profile_id: effective.profile,
      max_iterations: route.maxIterations,
      tags: { source: 'forgehands', ...(job.event.bot ? { bot: 'dependency' } : { issue: String(job.event.issue.number) }), ...(job.event.pull_request ? { pr: String(job.event.pull_request.number) } : {}), ...(job.event.ci ? { ci: job.event.type.slice(3) } : {}), ...(job.event.epic ? { epic: 'done' } : {}), ...(job.event.type === 'pull_request.conflict' ? { conflict: 'default-branch' } : {}) },
      initial_message: { role: 'user', run: true, content: [{ type: 'text', text: buildPrompt(job.event, this.config) }] }
    };
    if (route.maxBudget) body.max_budget_per_run = route.maxBudget;
    // Built per start from the environment; never stored in the ledger.
    // A route's own Forgejo token (the reviewer user) goes to its conversations only, as FORGEJO_TOKEN; no other conversation gets it.
    const claimed = new Set([...this.config.routes.values()].map((entry) => entry.forgejoTokenSecret).filter(Boolean));
    const own = route.forgejoTokenSecret ? this.config.agentSecrets[route.forgejoTokenSecret] : undefined;
    const secrets = [...Object.entries(this.config.agentSecrets || {}).filter(([name]) => !claimed.has(name) && !(own && name === 'FORGEJO_TOKEN')),
      ...(own ? [['FORGEJO_TOKEN', own] as [string, string]] : [])];
    if (secrets.length) {
      body.secrets = Object.fromEntries(secrets.map(([name, value]) => [name, { kind: 'StaticSecret', value, description: 'Provided by ForgeHands' }]));
    }
    // A dry run judges and schedules as usual, but starts nothing: the job ends as `dry` with the message the agent would have got.
    // `started` stays set so that the hourly limit and the round count behave as live.
    if (isDry(this.config, job.event.repository.full_name)) {
      Object.assign(job, { status: 'dry', started: now, finished: now, result: 'dry', dry_prompt: body.initial_message.content[0].text });
      this.logger.error('DRY RUN, not started: ' + job.key + ' (' + effective.profile + ', tier ' + effective.tier + ')');
      return true;
    }
    try {
      const response = await this.api('POST', '/api/conversations', body, job.event.repository.full_name);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const created = (await response.json()) as Json;
      if (!created?.id) throw new Error('response without conversation id');
      Object.assign(job, { status: 'running', conversation_id: created.id, started: now, error: undefined });
      // A new conversation gets its own resumes (the fields described Job.resumes belong to the one before).
      delete job.resumes; delete job.pause_resumes; delete job.resumed_from; delete job.resumed_at; delete job.resume_pending;
      // The nudge is once per conversation too (see nudgeIfNoBranch).
      delete job.nudged; delete job.nudge_settled; delete job.nudge_pending; delete job.nudge_gave_up; this.nudgeChecks.delete(job.id);
      delete job.tokens_seen;
      metrics.inc('forgehands_runs_started_total', { kind: this.route(job.label).kind });
    } catch (error) {
      job.attempts += 1;
      job.error = error.message;
      this.logger.error('starting conversation for ' + job.key + ' failed:', error.message);
      if (job.attempts >= MAX_ATTEMPTS) Object.assign(job, { status: 'failed', finished: now });
      else job.next_try = now + RETRY_BASE_MS * job.attempts;
    }
    return true;
  }

  async poll(job: Job, now: number): Promise<boolean> {
    // A continued run whose run call was not answered yet: the message is in its conversation already, so only the run call is repeated.
    // Past the run timeout the continuation is given up and the run counts as timed out, without a second message.
    if (job.resume_pending) {
      if (job.resumed_at! + this.config.maxRunMs >= now) {
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
      const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!));
      if (response.status === 404) state = 'deleted';
      else if (response.ok) {
        const data = (await response.json()) as Json;
        state = data.execution_status || data.status;
        const cost = conversationCost(data);
        if (cost !== null && cost !== job.cost) { job.cost = cost; costChanged = true; }
        usage = tokenUsage(data);
      }
    } catch (error) {
      this.logger.error('polling ' + job.key + ' failed:', error.message);
    }
    if (state === 'error') {
      const error = await this.lastError(job);
      // The model ran out of quota (the gateway answers with a rate limit, mostly with the time until it resets): not the ticket's fault
      // and no reason to call a human. Hold the tier back until then (at most QUOTA_HOLD_MAX_HOURS, 15 minutes when the gateway gives no
      // time) and run this job again afterwards; give up only when the quota has been out for QUOTA_GIVE_UP_HOURS.
      if (error?.rateLimited) {
        const since = job.rate_limited_since || now;
        if (now - since < this.config.quotaGiveUpMs) {
          // No time from the gateway: a quota without a reset time waits 15 minutes; "no model available" starts short and doubles (1, 2, 4, 8,
          // 16, then 30 minutes), because such a window may be over in a minute or last hours.
          const fallback = error.unavailable ? Math.min(60000 * 2 ** Math.min(job.rate_limited || 0, 5), 30 * 60000) : 15 * 60000;
          const wait = Math.min(Math.max(error.waitMs ?? fallback, 60000), this.config.quotaHoldMaxMs);
          const until = now + wait;
          this.countTokens(job, usage);
          this.cooldowns.set(this.tierOf(job) ?? this.route(job.label).tier, until);
          this.logger.error('model quota used up for ' + job.key + ', trying again after ' + new Date(until).toISOString());
          // The job may start again as soon as one of the routes it can run on is free: its own (or escalated) route, or that route's fallback.
          const next = this.earliestStart(job, now);
          Object.assign(job, { status: 'queued', started: undefined, fell_back: undefined, conversation_id: undefined, next_try: next, rate_limited: (job.rate_limited || 0) + 1, rate_limited_since: since, retry_at: next });
          return true;
        }
      }
      // The agent reached its iteration limit: OpenHands reports that as an error, but running it again does the same. It is a ticket that
      // is too big (see reportFailure and SPLIT_LABEL), not an error that passes.
      if (error?.code === 'MaxIterationsReached') state = 'max_iterations';
    }
    // An error ends a run for reasons that often pass (a failing model call, a restart of OpenHands): start it once more, after a pause.
    if (state === 'error' && (job.error_retry || 0) < this.config.errorRetries) {
      this.countTokens(job, usage);
      this.logger.error(job.key + ' ended with an error, running it once more');
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
      if (state === 'paused' && (job.pause_resumes || 0) < this.config.pauseResumes) {
        try { stopped = await this.pauseStop(job); }
        catch (error) { this.logger.error('could not read ' + job.key + ' to see whether it was stopped, trying again:', error.message); return false; }
      }
      if (stopped) {
        Object.assign(job, { status: 'failed', result: state, finished: now });
        this.logger.error(job.key + ': paused, ' + stopped + ': not resumed');
        this.runEnded(job, state, now);
        await this.releaseFileWaits();
        return true;
      }
      if (await this.resume(job, state, now)) return true;
      Object.assign(job, { status: state === 'finished' ? 'done' : 'failed', result: state, finished: now });
      this.runEnded(job, state, now);
      await this.checkBranchAfterRun(job);
      await this.releaseFileWaits();
      const done = this.config.routes.get(job.label)?.kind;
      if (done === 'ci_success') await this.checkVerdict(job);
      else if (done === 'sensitive_review') { if (state === 'finished') await this.checkSecurityReview(job); else await this.handOverAfterSecurity(job); }
      else if (state !== 'finished') { if (!(await this.escalateFailure(job, state))) await this.reportFailure(job, state); }
      else if (done === 'issue') await this.checkDelivery(job);
      return true;
    }
    // A running worker that has used much of its iteration limit without a branch is nudged (NUDGE_AT_PERCENT).
    if (state === 'running' && await this.nudgeIfNoBranch(job, now)) return true;
    if (costChanged) return true;
    // Free the slot of a run that never ends; the conversation itself is left alone unless the run is continued (see resume).
    // A continued run counts its timeout from the continuation.
    if (job.started && (job.resumed_at ?? job.started) + this.config.maxRunMs < now) {
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
    if (!this.config.forgejo) return null;
    const event = job.event;
    const repository = event.repository.full_name;
    const kind = this.config.routes.get(job.label)?.kind;
    const labelled = kind === 'issue' || kind === 'pull_request';
    if (event.pull_request) {
      const pull = await this.forge.getPull(repository, event.pull_request.number);
      if (pull.state === 'closed' || pull.merged) return 'the pull request is closed';
      return !labelled || (pull.labels || []).some((label) => label.name === job.label) ? null : 'the trigger label is gone';
    }
    const issue = await this.forge.getIssue(repository, event.issue.number);
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
    const budget = paused ? this.config.pauseResumes : this.config.resumeAttempts;
    if (!(paused || RESUMABLE.has(state)) || !job.conversation_id || used >= budget) return false;
    const repository = job.event.repository.full_name;
    const conversation = '/api/conversations/' + encodeURIComponent(job.conversation_id);
    // A timed out run is still running in OpenHands: it is paused first, so that the message does not go to a busy agent (best effort).
    if (state === 'timeout') {
      try { await this.api('POST', conversation + '/pause', undefined, repository); }
      catch (error) { this.logger.error('could not pause ' + job.key + ' before it is continued:', error.message); }
    }
    // The message and the run are two calls: a run call that is not answered is repeated on its own (startResumed), never the message.
    const text = paused ? PAUSE_MESSAGE : 'The run stopped as ' + state + '. Do not repeat what you did last. Look at the current state of the branch and of the checks, take a different approach, and end with the finish tool and a short summary.';
    try {
      await this.sendMessage(job, text);
    } catch (error) {
      this.logger.error(job.key + ': ' + state + ', the message to continue it was not sent (' + error.message + '), the next stage decides');
      return false;
    }
    const counted = paused ? { pause_resumes: used + 1 } : { resumes: used + 1 };
    Object.assign(job, { status: 'running', ...counted, resumed_from: state, resumed_at: now, resume_pending: true, finished: undefined, result: undefined });
    metrics.inc('forgehands_resumes_total', { kind: this.config.routes.get(job.label)?.kind || 'issue', state: known(state, [...RESUMABLE, 'paused']) });
    this.logger.error(job.key + ': ' + state + ', resuming the conversation (' + (used + 1) + '/' + budget + ')');
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
    const tiers = new Set([...this.config.routes.values()].map((route) => route.tier));
    const labels = {
      repository: known(String(job.event?.repository?.full_name).toLowerCase(), this.config.allowedRepos), tier: known(this.tierOf(job), tiers),
      kind: known(this.config.routes.get(job.label)?.kind || 'issue', ROUTE_KINDS)
    };
    for (const type of TOKEN_TYPES) if (delta[type] > 0) metrics.inc('forgehands_tokens_total', { ...labels, type }, delta[type]);
  }

  // One message into a conversation, without a run call (run: false). Throws when OpenHands does not take it (HTTP status in the message) or the call
  // times out; shared by resume (the normal timeout) and the nudge (its own, longer timeout, see nudgeIfNoBranch).
  async sendMessage(job: Job, text: string, timeoutMs?: number): Promise<void> {
    const response = await this.api('POST', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events', { role: 'user', content: [{ type: 'text', text }], run: false }, job.event.repository.full_name, timeoutMs);
    if (!response.ok) throw new Error('HTTP ' + response.status);
  }

  // NUDGE_AT_PERCENT: a worker run on an issue that has used that share of its route's iteration limit, and whose forge shows no branch ai/issue-<n>,
  // is told once (per conversation) to stop exploring and push. Only a running conversation is looked at. Every read is best effort: when the count,
  // the forge or OpenHands fails, nothing is sent and the next look comes a minute later. Returns true when the job changed (to be persisted).
  async nudgeIfNoBranch(job: Job, now: number): Promise<boolean> {
    const route = this.config.routes.get(job.label);
    // Planner, epic and split routes are not workers: they plan, they do not push a branch of their own.
    const worker = !!route && route.kind === 'issue' && !job.event.pull_request && !job.event.bot && job.event.type !== 'epic.done'
      && !this.config.epicLabels.has(job.label) && job.label !== this.config.splitLabel;
    if (!this.config.nudgeAtPercent || !worker || !this.config.forgejo || !job.started || !job.conversation_id || job.nudged !== undefined || job.nudge_settled
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
      this.logger.error(job.key + ': actions not counted, no nudge yet (' + error.message + ')');
      return false;
    }
    const max = route.maxIterations;
    if (used < Math.ceil(max * this.config.nudgeAtPercent / 100)) return false;
    let pushed: boolean;
    try {
      pushed = await this.branchExists(repository, 'ai/issue-' + number);
    } catch (error) {
      this.logger.error(job.key + ': the branch is not read, no nudge yet (' + error.message + ')');
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
      .catch((error) => this.logger.error(job.key + ': nudge failed: ' + error.message))
      .finally(() => {
        this.nudgeInflight.delete(job.id);
        this.jobs.persist(this.now()).catch((error) => this.logger.error('persist failed:', error.message));
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
          this.logger.error(job.key + ': nudge pending, the events could not be read (' + error.message + '), checking again on the next look');
          return;
        }
        if (stored) {
          this.logger.error(job.key + ': nudge confirmed in the events');
          return this.nudgeDelivered(job, pending);
        }
        if (pending.tries >= NUDGE_TRIES) {
          job.nudge_gave_up = true;
          delete job.nudge_pending;
          this.logger.error(job.key + ': the nudge was not delivered after ' + pending.tries + ' tries, no more nudges for this run');
          return;
        }
      }
      pending.tries += 1;
      try {
        await this.sendMessage(job, this.nudgeText(pending.used, pending.max, number) + ' ' + pending.marker, this.config.nudgeTimeoutMs);
      } catch (error) {
        // An answer with an HTTP status is a refusal: nothing was stored, and the next look tries again.
        if (/^HTTP \d+$/.test(error.message)) {
          delete job.nudge_pending;
          this.logger.error(job.key + ': nudge refused (' + error.message + '), trying again on the next look');
          return;
        }
        this.logger.error(job.key + ': nudge pending (timeout), checking the events');
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
    this.logger.error(job.key + ': nudged at ' + pending.used + '/' + pending.max + ' actions, no branch yet');
  }

  // Whether a user message with the marker is among the newest events of the conversation. Throws when the events cannot be read.
  async nudgeInEvents(job: Job, marker: string): Promise<boolean> {
    const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/search?limit=30&sort_order=TIMESTAMP_DESC', undefined, job.event.repository.full_name);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const items = ((await response.json()) as Json)?.items || [];
    return items.some((item: Json) => item?.source !== 'agent' && JSON.stringify(item).includes(marker));
  }

  // The agent actions of a conversation so far: OpenHands' event count, restricted to ActionEvent. Throws when the count cannot be read.
  async actionCount(job: Job): Promise<number> {
    const response = await this.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/events/count?kind=ActionEvent', undefined, job.event.repository.full_name);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = (await response.json()) as Json;
    const count = typeof data === 'number' ? data : Number(data?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('the answer carries no count');
    return count;
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

  // The nudge's text: the default, or NUDGE_MESSAGE with {used}, {max} and {branch} filled in.
  nudgeText(used: number, max: number, number: number): string {
    const branch = 'ai/issue-' + number;
    if (this.config.nudgeMessage) return this.config.nudgeMessage.replaceAll('{used}', String(used)).replaceAll('{max}', String(max)).replaceAll('{branch}', branch);
    return 'You have used ' + used + ' of ' + max + ' actions and have not pushed a branch yet. Stop exploring. Implement the smallest change that meets the acceptance check, '
      + 'commit and push it to the branch ' + branch + ' and open the draft pull request; or, if something blocks you, write a comment on the issue that names the exact blocker '
      + 'and finish. Do not start new investigations.';
  }

  // The run call of a continued conversation. 200 starts it, 409 says it runs already: both clear the pending call. 404 means the conversation is
  // gone (the next poll says so). Any other answer, or no answer, keeps the call pending for the next poll.
  async startResumed(job: Job): Promise<void> {
    try {
      const response = await this.api('POST', '/api/conversations/' + encodeURIComponent(job.conversation_id!) + '/run', undefined, job.event.repository.full_name);
      if (response.ok || response.status === 409) {
        delete job.resume_pending;
        job.resumed_at = this.now();
      } else if (response.status === 404) {
        delete job.resume_pending;
      } else {
        this.logger.error(job.key + ': the continued run was not started (HTTP ' + response.status + '), trying again');
      }
    } catch (error) {
      this.logger.error(job.key + ': the continued run was not started (' + error.message + '), trying again');
    }
  }

  // Stage B (FAILURE_ESCALATE): a round that is still stuck, timed out or out of iterations (after stage A, or at once for the iteration limit) starts
  // once more on the profile of its escalate_to route, on the same pull request and branch, with the own route's prompt and limits. It is one
  // extra try per head commit: a second failure on the same commit goes to the human, and it does not use up a MAX_ROUNDS round. The run is
  // queued like any run (the escalation is the same as the last-round escalation: the job is `escalated`). Returns true when it was queued.
  async escalateFailure(job: Job, state: string): Promise<boolean> {
    const route = this.config.routes.get(job.label);
    if (!this.config.failureEscalate || !route?.escalateTo || !ROUND_KINDS.has(route.kind) || !job.event.pull_request || job.escalated
      || !ESCALATABLE.has(state) || !this.config.forgejo) return false;
    const repository = job.event.repository.full_name;
    const number = job.event.pull_request.number;
    let head: string;
    try {
      const pr = await this.forge.getPull(repository, number);
      if (!pr || pr.state !== 'open' || pr.merged || typeof pr.head?.sha !== 'string') return false;
      head = pr.head.sha;
    } catch (error) {
      this.logger.error('could not read the head of #' + number + ', no escalation of ' + job.key + ':', error.message);
      return false;
    }
    const key = this.issueKey(job.event) + ':' + job.label + ':' + head.slice(0, 8);
    if (this.jobs.list().some((other) => other.key === key)) return false;
    this.jobs.add({ key, label: job.label, event: { ...job.event, label: job.label }, status: 'queued', created: this.now(),
      escalated: true, failure_escalation: true, escalated_after: state });
    metrics.inc('forgehands_failure_escalations_total');
    this.logger.error(job.key + ': ' + state + ', starting once more on ' + route.escalateTo + ' (head ' + head.slice(0, 8) + ')');
    return true;
  }

  // A run that ran out of time (a continuation that never started counts the same): it is either escalated (stage B) or reported (stage C, as before).
  async failed(job: Job, state: string, now: number): Promise<boolean> {
    Object.assign(job, { status: 'failed', result: state, finished: now });
    this.runEnded(job, state, now);
    if (!(await this.escalateFailure(job, state))) await this.reportFailure(job, state);
    return true;
  }

  // A run that failed for good must not vanish into the ledger. A worker run on an issue that ran out of iterations or time (max_iterations,
  // stuck, timeout) means a ticket that is too big: with SPLIT_LABEL the planner is asked to split it. A paused run is an interruption and is
  // never split. Everything else is handed to the human, on the pull request (label and mention) or, without one, as a comment on the issue.
  // Best effort: a failing call is only logged.
  async reportFailure(job: Job, state: string): Promise<void> {
    const event = job.event;
    if (!this.config.forgejo || !event || state === 'deleted' || state === 'finished') return;
    const kind = this.config.routes.get(job.label)?.kind;
    const what = state === 'no_delivery'
      ? 'the run for ' + job.label + ' finished twice without a pull request and without a comment, so nothing was delivered'
      : 'the run for ' + job.label + (event.pull_request ? ' on pull request #' + event.pull_request.number : '') + ' ended with "' + state + '"';
    try {
      const exhausted = state === 'max_iterations' || state === 'stuck' || state === 'timeout';
      if (this.config.splitLabel && kind === 'issue' && !event.pull_request && exhausted && job.label !== this.config.splitLabel && !this.config.epicLabels.has(job.label)) {
        const number = event.issue.number;
        const repository = event.repository.full_name;
        const split = await this.forge.findOrCreateLabel(repository, this.config.splitLabel, '#5319e7');
        const present = await this.forge.labelsOf(repository, number, 'issue');
        const failed = (present || []).find((entry) => entry.name === job.label);
        await this.forge.addComment(repository, number, 'ForgeHands: ' + what + ', so the ticket is probably too big for one run. It goes to the planner (' + this.config.splitLabel + ') to be split into slices.', 'issue');
        if (failed) await this.forge.removeLabel(repository, number, failed, 'issue');
        await this.forge.addLabels(repository, number, [split], 'issue');
        this.noteTicket(this.issueKey(event), { split_at: this.now() });
        return;
      }
      const text = what + '. A human has to look at it.';
      if (event.pull_request) await this.markForHuman(event, 'ForgeHands: ' + text, 'failed_run', { why: state });
      else {
        this.tell('failed', event, { why: state });
        await this.forge.addComment(event.repository.full_name, event.issue.number, mentionOf(this.config) + 'ForgeHands: ' + text, 'issue');
      }
    } catch (error) {
      this.logger.error('could not report the failure of ' + job.key + ':', error.message);
    }
  }
}
