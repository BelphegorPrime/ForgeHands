import { createForge, createTransport } from '../forge/index.ts';
import { Merger } from './merge.ts';
import { isBotPull } from './bot.ts';
import { DryLog } from '../dry.ts';
import { metrics } from '../metrics.ts';
import { NO_NOTIFY, mentionOf, pullUrl } from '../notify/index.ts';
import type { Notify } from '../notify/index.ts';
import { immediateMessage } from '../notify/texts.ts';
import type { DirectConfig, Fetch, Json, Logger } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../forge/index.ts';

const DAY_MS = 86400000;
// Forgejo calls stay bounded: per pass this many agent pull requests are looked at (comments and more are read for each), this many
// reminders are written, and this many waiting jobs are checked.
const MAX_PULLS = 20;
const MAX_REMINDERS = 10;
const MAX_WAITING_JOBS = 20;
// How ForgeHands recognises its own comments (after the optional mention), and its reminders among them.
const OWN = /^(?:@\S+\s+)?ForgeHands:/;
const REMINDER = /^(?:@\S+\s+)?ForgeHands: reminder \d+ of \d+/;

export interface Waiting { repository: string; issue: number; pr: number; since: number; reason: string }

// Reminds the human of what waits for him. Once a day (REMIND_AFTER_DAYS) ForgeHands looks at the open agent pull requests that were
// handed to him (blocked, approved and green on a protected path) or that nobody touched for that long, and writes one comment that
// mentions HUMAN_LOGIN (nobody else), at most one per REMIND_AFTER_DAYS per pull request and REMIND_MAX in all. It also starts the jobs
// whose dependencies are all closed already (a lost close event). The comments of the pull request are the memory, so a restart forgets
// nothing but the list that /status shows until the next pass.
export class Reminder {
  config: DirectConfig;
  jobs: JobStore;
  send: Fetch;
  logger: Logger;
  merger: Merger;
  dry: DryLog;
  forge: Forge;
  transport: ReturnType<typeof createTransport>;
  last = 0;
  // Tells the human by a message of ForgeHands' own (src/notify); the dispatcher sets it. Off by default.
  notifier: Notify = NO_NOTIFY;
  waiting = new Map<string, Waiting>(); // repository#pr -> what waits for the human (shown by /status)

  constructor(config: DirectConfig, jobs: JobStore, send: Fetch, logger: Logger, merger: Merger, dry: DryLog = new DryLog(logger)) {
    this.dry = dry;
    this.config = config;
    this.jobs = jobs;
    this.send = send;
    this.logger = logger;
    this.merger = merger;
    this.transport = createTransport(config, send, this.dry);
    this.forge = createForge(config, (repository, method, path, body) => this.call(repository, method, path, body));
  }

  call(repository: string, method: string, path: string, body?: unknown): Promise<Json> {
    return this.transport(repository, method, path, body);
  }

  // At most once a day. Returns true when a waiting job was started (the ledger changed).
  async run(now: number): Promise<boolean> {
    if (!this.config.remindAfterDays || !this.config.forgejo || !this.config.humanLogin || (this.last && now - this.last < DAY_MS)) return false;
    this.last = now;
    const changed = await this.startForgotten();
    const seen = new Map<string, Waiting>();
    let written = 0;
    for (const repository of this.config.allowedRepos) {
      try { written += await this.remindRepository(repository, now, seen, MAX_REMINDERS - written); }
      catch (error) { this.logger.error('could not look for waiting pull requests of ' + repository + ':', error.message); }
    }
    this.waiting = seen;
    return changed;
  }

  // A job that waits for dependencies that are all closed should not exist (the close event was lost): start it.
  async startForgotten(): Promise<boolean> {
    let changed = false;
    const waiting = this.jobs.list(true).filter((job) => job.status === 'waiting' && !job.waiting_for_run).slice(0, MAX_WAITING_JOBS);
    for (const job of waiting) {
      try {
        const dependencies = await this.forge.dependencies(job.event.repository.full_name, job.event.issue.number);
        if (!Array.isArray(dependencies) || dependencies.some((issue: Json) => issue.state === 'open')) continue;
        job.status = 'queued';
        delete job.waiting_for;
        changed = true;
        this.logger.error(job.key + ' waited for dependencies that are all closed, starting it');
      } catch (error) {
        this.logger.error('could not read the dependencies of #' + job.event.issue.number + ':', error.message);
      }
    }
    return changed;
  }

  // Why this agent pull request waits for a human, or null. Cheap checks first: the extra calls only happen for an approved pull request.
  async reasonFor(repository: string, pr: Json, labels: string[], now: number): Promise<string | null> {
    const { blockedLabel, approvedLabel, remindAfterDays } = this.config;
    if (labels.includes(blockedLabel)) return 'it is marked ' + blockedLabel;
    const policy = this.config.mergePolicy.get(repository.toLowerCase());
    if (labels.includes(approvedLabel) && policy) {
      const status = await this.forge.commitStatus(repository, pr.head.sha);
      if (status?.state === 'success' && status.total_count > 0) {
        const files = await this.merger.changedFiles(repository, pr.number);
        if (files.some((name) => policy.deny.some((pattern) => pattern.test(name)))) return 'it is approved and green, but touches protected paths, so it is left to you to merge';
      }
    }
    const issue = Number(/^ai\/issue-(\d+)$/.exec(pr.head.ref)![1]);
    const base = repository.toLowerCase() + '#' + issue + ':';
    if (this.jobs.list(true).some((job) => job.key.startsWith(base) && (job.status === 'queued' || job.status === 'running' || job.status === 'waiting'))) return null;
    const touched = Date.parse(pr.updated_at);
    if (Number.isFinite(touched) && touched <= now - remindAfterDays * DAY_MS) return 'nothing has happened on it for ' + remindAfterDays + ' days and no run is active';
    return null;
  }

  async remindRepository(repository: string, now: number, seen: Map<string, Waiting>, budget: number): Promise<number> {
    const { remindAfterDays: days, remindMax: max, humanLogin } = this.config;
    const pulls = await this.forge.listPulls(repository, { state: 'open', limit: 50 });
    let written = 0;
    let looked = 0;
    for (const pr of Array.isArray(pulls) ? pulls : []) {
      const match = /^ai\/issue-(\d+)$/.exec(pr?.head?.ref || '');
      // A dependency bot's pull request (BOT_AUTHORS) has no ticket: it is reminded only when it is marked blocked.
      const bot = !match && isBotPull({ authors: this.config.botAuthors, prefixes: this.config.botBranchPrefixes, repos: this.config.botRepos }, pr, repository);
      if ((!match && !bot) || pr.state !== 'open' || pr.merged) continue;
      if (pr.head?.repo?.full_name && pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) continue;
      if (looked++ >= MAX_PULLS) break;
      try {
        const labels: string[] = (pr.labels || []).map((label: Json) => label.name);
        const reason = bot ? (labels.includes(this.config.blockedLabel) ? 'it is marked ' + this.config.blockedLabel : null) : await this.reasonFor(repository, pr, labels, now);
        if (!reason) continue;
        const comments = ((await this.forge.listComments(repository, pr.number, 100)) || []) as Json[];
        const at = (comment: Json) => Date.parse(comment.created_at) || 0;
        const newest = (list: Json[]) => list.map(at).reduce((a, b) => Math.max(a, b), 0);
        const own = comments.filter((comment) => OWN.test(String(comment.body || '').trimStart()));
        const reminders = own.filter((comment) => REMINDER.test(String(comment.body).trimStart()));
        // What the human did last (a comment of his) starts the count again: reminders before it do not count.
        const human = newest(comments.filter((comment) => String(comment.user?.login || '').toLowerCase() === humanLogin!.toLowerCase()));
        const streak = reminders.filter((comment) => at(comment) > human);
        const handover = newest(own.filter((comment) => !reminders.includes(comment)));
        const since = handover || (streak.length ? at(streak[0]) - days * DAY_MS : Date.parse(pr.updated_at) || now);
        seen.set(repository.toLowerCase() + '#' + pr.number, { repository, issue: match ? Number(match[1]) : pr.number, pr: pr.number, since, reason });
        if (written >= budget || streak.length >= max) continue;
        if (human && now - human < days * DAY_MS) continue;
        if (now - (newest(own) || Date.parse(pr.updated_at) || 0) < days * DAY_MS) continue;
        const number = streak.length + 1;
        const text = mentionOf(this.config) + 'ForgeHands: reminder ' + number + ' of ' + max + ': this pull request has been waiting for you since '
          + new Date(since).toISOString().slice(0, 10) + ' (' + reason + ').' + (number >= max ? ' This is the last reminder.' : '');
        await this.forge.addComment(repository, pr.number, text);
        written += 1;
        metrics.inc('forgehands_reminders_total');
        if (this.notifier.wants('reminder')) {
          this.notifier.notify(immediateMessage(this.config.notify.language, 'reminder', { repository, number: pr.number, title: pr.title, link: pullUrl(this.config, repository, pr.number, pr.html_url),
            days: Math.floor((now - since) / DAY_MS), nth: number, of: max }), repository);
        }
        if (number >= max && this.config.staleLabel) await this.addLabel(repository, pr.number, this.config.staleLabel);
      } catch (error) {
        this.logger.error('could not remind of #' + pr.number + ':', error.message);
      }
    }
    return written;
  }

  async addLabel(repository: string, number: number, name: string): Promise<void> {
    const label = await this.forge.findOrCreateLabel(repository, name, '#cccccc');
    await this.forge.addLabels(repository, number, [label]);
  }
}
