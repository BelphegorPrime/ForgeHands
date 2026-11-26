// Closed and deleted tickets and old conversations: a ticket closed or deleted in the forge leaves the ledger's open work, and the
// conversations of runs that ended long ago are archived, then deleted.
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import type { Job, Json } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import { ROUND_KINDS } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What TicketCleanup reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type TicketCleanupHost = Pick<Dispatcher, 'api' | 'config' | 'forge' | 'jobs' | 'logger' | 'now'>;

export class TicketCleanup {
  host: TicketCleanupHost;
  lastArchive = 0;
  /** Earliest time of the next look for closed issues (sweepClosed) and when each ticket was last found open. */
  nextClosedSweep = 0;
  closedChecked = new Map<string, number>();
  closeRefused = new Map<string, number>(); // repository#issue -> until when a refused close is not tried again
  // DELETE_AFTER_DAYS: the step after archiving. The OpenHands conversation of an archived run that ended long enough ago is deleted (its
  // trajectory goes); the ledger keeps the run, its result, cost and tokens, and the status page shows no conversation link for it. Kept: a run
  // that is not terminal, a conversation another job still uses (any job of that conversation must be terminal, archived and old enough), and a
  // ticket that is open with a nudge or a resume pending. At most DELETE_PER_PASS deletions per pass, once an hour; a failed delete is tried again on
  // the next pass. A dry run deletes nothing. 404 means the conversation is gone already, which counts as deleted.
  lastDelete = 0;

  constructor(host: TicketCleanupHost) {
    this.host = host;
  }

  // Whether the forge has no such issue: a 404 on GET /issues/{n}. Any other failure throws.
  async ticketGone(repository: string, number: number): Promise<boolean> {
    try {
      await this.host.forge.getIssue(repository, number);
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
      this.host.logger.error('could not check whether #' + number + ' of ' + repository + ' still exists:', error.message);
      return false;
    }
    return this.dropDeleted(repository, number, false);
  }

  // A ticket (or, with `pull`, a pull request) is deleted in the forge: its waiting and queued jobs end as `deleted`, with no comment, no hand-over
  // and no mail. An issue's jobs are closed on the status page too (archived_view); running jobs are left alone. One log line per ticket.
  // Dry runs change nothing.
  async dropDeleted(repository: string, number: number, pull: boolean): Promise<boolean> {
    if (isDry(this.host.config, repository)) return false;
    const name = repository.toLowerCase();
    const ticket = name + '#' + number;
    const jobs = this.host.jobs.list(true).filter((job) => (job.status === 'waiting' || job.status === 'queued')
      && job.event.repository.full_name.toLowerCase() === name
      && (pull ? job.event.pull_request?.number === number : job.key.split(':')[0] === ticket));
    if (!jobs.length) return false;
    const now = this.host.now();
    for (const job of jobs) {
      Object.assign(job, { status: 'deleted', finished: now, result: 'deleted' });
      delete job.waiting_for; delete job.waiting_for_files;
    }
    if (!pull) this.host.jobs.markClosed(ticket);
    metrics.inc('forgehands_deleted_tickets_total');
    this.host.logger.error(repository + (pull ? '!pr' : '#') + number + ': deleted in the forge, its waiting jobs are dropped');
    await this.host.jobs.persist(now);
    return true;
  }

  // The runs of an issue ("repo#n") that wait or are queued are dropped: the end-to-end suite closes its tickets this way, and a closed ticket's
  // queued run would otherwise start later. A running run is left alone (it cannot be stopped from here). Dry runs change nothing.
  // Returns how many were dropped.
  async dropQueuedOf(repository: string, number: number): Promise<number> {
    if (isDry(this.host.config, repository)) return 0;
    const ticket = repository.toLowerCase() + '#' + number;
    const jobs = this.host.jobs.list(true).filter((job) => (job.status === 'waiting' || job.status === 'queued') && job.key.toLowerCase().split(':')[0] === ticket);
    if (!jobs.length) return 0;
    const now = this.host.now();
    for (const job of jobs) {
      Object.assign(job, { status: 'deleted', finished: now, result: 'dropped: the ticket was closed before the run started' });
      delete job.waiting_for; delete job.waiting_for_files;
    }
    this.host.jobs.markClosed(ticket);
    this.host.logger.error(ticket + ': closed while its runs were queued, ' + jobs.length + ' queued run(s) dropped');
    await this.host.jobs.persist(now);
    return jobs.length;
  }

  // The same for a ticket of the ledger ("repo#n" or "repo!pr<n>"), as the ledger sync names it.
  async dropDeletedTicket(ticket: string): Promise<boolean> {
    const match = /^(.+?)([#!])(?:pr)?(\d+)$/.exec(ticket);
    if (!match) return false;
    return this.dropDeleted(match[1], Number(match[3]), match[2] === '!');
  }

  // The issue ("repo#number") is closed in the forge: its jobs leave the waiting and failed lists of the status page (see JobStore.markClosed).
  async markClosed(ticket: string): Promise<boolean> {
    if (isDry(this.host.config, ticket.split('#')[0]) || !this.host.jobs.markClosed(ticket)) return false;
    await this.host.jobs.persist(this.host.now()).catch((error) => this.host.logger.error('persist failed:', error.message));
    return true;
  }

  // The events of a closed issue can be missed (closed by hand while ForgeHands was down, or before this was kept). Once a day and at start,
  // look at the tickets that are in a state the status page shows as a problem (failed run, rounds used up, waiting) and mark those that the
  // forge says are closed. At most 20 reads per pass; the rest follows in the next hourly pass. A read that fails changes nothing.
  async sweepClosed(now: number): Promise<boolean> {
    if (!this.host.config.forgejo || now < this.nextClosedSweep) return false;
    const tickets = new Map<string, Job[]>();
    for (const job of this.host.jobs.list()) if (!job.key.split(':')[0].includes('!')) tickets.set(job.key.split(':')[0], [...(tickets.get(job.key.split(':')[0]) || []), job]);
    const candidates = [...tickets].filter(([ticket, list]) => {
      if (isDry(this.host.config, ticket.split('#')[0]) || list.every((job) => job.archived_view) || list.some((job) => job.status === 'running' || job.status === 'queued')) return false;
      const checked = this.closedChecked.get(ticket);
      if (checked !== undefined && now - checked < 86400000) return false;
      const rounds = list.filter((job) => ROUND_KINDS.has(this.host.config.routes.get(job.label)?.kind) && (job.started || job.status !== 'failed')).length;
      return list.some((job) => job.status === 'failed' || job.status === 'waiting') || rounds >= this.host.config.maxRounds;
    });
    this.nextClosedSweep = now + (candidates.length > 20 ? 3600000 : 86400000);
    let changed = false;
    for (const [ticket, list] of candidates.slice(0, 20)) {
      const [repository, number] = [list[0].event.repository.full_name, Number(ticket.split('#')[1])];
      try {
        const issue = await this.host.forge.getIssue(repository, number);
        if (!issue) continue;
        if (issue.state === 'closed') { if (await this.markClosed(ticket)) changed = true; }
        else this.closedChecked.set(ticket, now);
      } catch (error) {
        // A 404 is the ledger sync's to decide (it marks an issue deleted in the forge after two passes): the sweep does not log it again and again.
        if (/HTTP 404\b/.test(error.message)) { this.closedChecked.set(ticket, now); continue; }
        this.host.logger.error('could not read #' + number + ' of ' + repository + ':', error.message);
      }
    }
    return changed;
  }

  // Archive the conversations of runs that ended a while ago: the tag archived=true is added, every other tag stays, so the runs can still
  // be found by issue, pull request and kind. At most once an hour and 20 at a time; a conversation that is deleted or running is skipped.
  async archiveOld(now: number): Promise<boolean> {
    const days = this.host.config.archiveAfterDays;
    if (!days || (this.lastArchive && now - this.lastArchive < 3600000)) return false;
    this.lastArchive = now;
    const before = now - days * 86400000;
    let changed = false;
    let done = 0;
    for (const job of this.host.jobs.list()) {
      if (job.archived || !job.conversation_id || !job.finished || job.finished > before || (job.status !== 'done' && job.status !== 'failed')) continue;
      if (isDry(this.host.config, job.event.repository.full_name)) continue; // a dry run archives nothing, and must not mark it as done
      if (done++ >= 20) break;
      try {
        const response = await this.host.api('GET', '/api/conversations/' + encodeURIComponent(job.conversation_id));
        if (response.status === 404) { job.archived = true; changed = true; continue; }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = (await response.json()) as Json;
        if ((data.execution_status || data.status) === 'running') continue;
        const patched = await this.host.api('PATCH', '/api/conversations/' + encodeURIComponent(job.conversation_id), { tags: { ...(data.tags || {}), archived: 'true' } }, job.event.repository.full_name);
        if (!patched.ok) throw new Error('HTTP ' + patched.status);
        job.archived = true;
        changed = true;
      } catch (error) {
        this.host.logger.error('could not archive the run of ' + job.key + ':', error.message);
      }
    }
    return changed;
  }

  async deleteOld(now: number): Promise<boolean> {
    const days = this.host.config.deleteAfterDays;
    if (!days || (this.lastDelete && now - this.lastDelete < 3600000)) return false;
    this.lastDelete = now;
    const perPass = 40;
    const cutoff = (status: string) => now - (status === 'done' ? days : this.host.config.deleteFailedAfterDays) * 86400000;
    const all = this.host.jobs.list();
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
      if (isDry(this.host.config, jobs[0].event.repository.full_name)) continue; // a dry run deletes nothing, and marks nothing
      try {
        const response = await this.host.api('DELETE', '/api/conversations/' + encodeURIComponent(conversation), undefined, jobs[0].event.repository.full_name);
        if (response.status !== 404 && !response.ok) throw new Error('HTTP ' + response.status);
        for (const job of jobs) job.conversation_deleted = true;
        deleted += 1;
        changed = true;
        metrics.inc('forgehands_conversations_deleted_total');
        this.host.logger.log?.(jobs[0].key + ': conversation deleted');
      } catch (error) {
        kept += 1;
        this.host.logger.error('could not delete the conversation of ' + jobs[0].key + ', trying again on the next pass:', error.message);
      }
    }
    this.host.logger.error('conversations: ' + deleted + ' deleted, ' + kept + ' kept');
    return changed;
  }
}
