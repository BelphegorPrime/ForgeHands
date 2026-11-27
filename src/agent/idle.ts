// What holds the work back while nothing starts: the idle line in the log, the idle state for the status page and the gauges, and the stall
// alert (STALL_ALERT_MINUTES) when nothing has started for too long.
import { stallMessage } from '../notify/texts.ts';
import type { IdleCounts, IdleState } from '../types.ts';
import { cycleText, findCycles, ticketKey, waitGraph } from './waits.ts';
import { behindBlocked, blockedTickets } from './stuck.ts';
import { IDLE_LOG_EVERY_MS, STALL_REPEAT_MS, idleLine } from './run-states.ts';
import type { Dispatcher } from './dispatch.ts';

// What IdleReporter reaches on the dispatcher. Read through the host on every call, so that a test that swaps the config or a fake keeps working.
export type IdleReporterHost = Pick<Dispatcher, 'config' | 'holdOf' | 'jobs' | 'lastStart' | 'logger' | 'notifier' | 'waitKeeper'>;

export class IdleReporter {
  host: IdleReporterHost;
  /** What holds the work back in the last pass that started nothing while something waited (null: nothing waits or the last pass started something). */
  idle: IdleState | null = null;
  idleLogged: { key: string; at: number } | null = null; // the composition last logged and when
  stallAlertAt: number | null = null; // when the last stall alert went out; cleared when nothing waits any more

  constructor(host: IdleReporterHost) {
    this.host = host;
  }

  // What holds the waiting and queued jobs back right now, counted per job with the waits the dispatcher already decides: an issue that depends on
  // open issues (and a CI result kept while its run goes on) is a dependency wait; a ticket that shares files with an older one is a files wait; a queued
  // job is held by holdOf. A queued job with a retry timer (next_try: a failed start, an error that is run again) waits for its time, not for a limit,
  // and is not counted.
  idleCounts(now: number): { reasons: IdleCounts; tiers: string[]; cycles: string[] } {
    const reasons: IdleCounts = { dependencies: 0, files: 0, quota: 0, disk: 0, hourly: 0, concurrency: 0, clone_breaker: 0, could_start: 0, cycle: 0, stuck: 0 };
    const tiers = new Set<string>();
    // Explicit dependencies only: a cycle of them is not broken by ForgeHands (the planner or a human made it), so its jobs wait for ever.
    const cycles = findCycles(waitGraph(this.host.jobs.list(), false));
    const inCycle = new Set(cycles.flat());
    // A ticket that waits, directly or through other tickets, behind a blocked pull request (see stuck.ts) is counted as waiting behind it.
    const behind = behindBlocked(this.host.jobs.list(), blockedTickets(this.host.jobs.stuck));
    for (const job of this.host.jobs.list(true)) {
      if (job.status === 'waiting') {
        if (job.waiting_for?.length && inCycle.has(ticketKey(job))) reasons.cycle += 1;
        else if (!job.event.bot && !job.event.pull_request && behind.has(ticketKey(job))) reasons.stuck += 1;
        else if (job.waiting_for?.length || job.waiting_for_run) reasons.dependencies += 1;
        else if (job.waiting_for_files?.length) reasons.files += 1;
        continue;
      }
      if (job.status !== 'queued' || (job.next_try && job.next_try > now)) continue;
      const hold = this.host.holdOf(job, now);
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
      if (this.host.waitKeeper.cyclesLogged.has(text)) continue;
      this.host.waitKeeper.cyclesLogged.add(text);
      this.host.logger.error(text + ', none of its tickets can start: a human has to break it');
    }
    if (started) this.idleLogged = null;
    if (started || !total) this.idle = null;
    if (!total) { this.stallAlertAt = null; this.idleLogged = null; }
    if (started || !total) return;
    this.idle = { since: this.idle?.since ?? now, reasons, tiers, cycles };
    const key = JSON.stringify([reasons, tiers]);
    if (this.idleLogged?.key === key && now - this.idleLogged.at < IDLE_LOG_EVERY_MS) return;
    this.idleLogged = { key, at: now };
    this.host.logger.error(idleLine(reasons, tiers));
  }

  idleState(): IdleState | null {
    return this.idle;
  }

  // STALL_ALERT_MINUTES: work waits on a hold that is not a dependency (quota, disk, a limit, or a job that could start and did not), no run is running,
  // and nothing has started for that long: one notification (kind stalled), and not again for six hours unless nothing waits any more. The waits on
  // dependencies and on files do not count: a chain of tickets is normal.
  checkStall(now: number): void {
    const minutes = this.host.config.stallAlertMinutes;
    if (!minutes || !this.idle) return;
    const { reasons, tiers, cycles } = this.idle;
    // A dependency cycle is not a normal chain: its jobs count as a hold too (the notification names the tickets).
    if (!(reasons.quota + reasons.disk + reasons.hourly + reasons.concurrency + reasons.could_start + reasons.cycle)) return;
    if (this.host.jobs.list('running').length || now - this.host.lastStart < minutes * 60000) return;
    if (this.stallAlertAt !== null && now - this.stallAlertAt < STALL_REPEAT_MS) return;
    if (!this.host.notifier.wants('stalled')) return;
    this.stallAlertAt = now;
    const quiet = Math.round((now - this.host.lastStart) / 60000);
    this.host.logger.error('stall alert: nothing has started for ' + quiet + ' min and no run is running. ' + idleLine(reasons, tiers));
    this.host.notifier.notify(stallMessage(this.host.config.notify.language, { minutes: quiet, reasons, tiers, cycles }));
  }
}
