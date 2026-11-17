// The daily digest: what is for the human right now, read from the ledger, the reminder's list of waiting pull requests and the quota holds.
// No message when there is nothing (the operator wants no "all fine" mail).
import type { DirectConfig, Job } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DigestData, DigestItem } from './texts.ts';
import { cleanTitle } from './texts.ts';

const DAY_MS = 86400000;

// A link to a pull request where only its number is known: the forge's own address, for Forgejo and Gitea (GitLab says it in the events).
function pullLink(config: DirectConfig, repository: string, number: number): string | undefined {
  const base = config.forgejo?.url;
  return base && config.forge !== 'gitlab' ? base.replace(/\/$/, '') + '/' + repository + '/pulls/' + number : undefined;
}

export interface WaitingPull { repository: string; issue: number; pr: number; since: number; reason: string }

// The date (YYYY-MM-DD) and the minute of the day in a time zone.
export function localClock(now: number, timeZone: string): { date: string; minutes: number; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return { date: parts.year + '-' + parts.month + '-' + parts.day, minutes: Number(parts.hour) * 60 + Number(parts.minute), time: parts.hour + ':' + parts.minute };
}

// Is it time for today's digest: the configured time of day has passed in NOTIFY_TIMEZONE and the last one was not sent today.
export function digestDue(digest: string, timeZone: string, now: number, lastSent: string | undefined): { due: boolean; date: string } {
  const clock = localClock(now, timeZone);
  const [hour, minute] = digest.split(':').map(Number);
  return { due: clock.minutes >= hour * 60 + minute && lastSent !== clock.date, date: clock.date };
}

export function collectDigest(config: DirectConfig, jobs: JobStore, waiting: WaitingPull[], cooldowns: Map<string, number>, now: number): DigestData {
  const all = jobs.list().filter((job) => job.status !== 'dry');
  const byTicket = new Map<string, Job[]>();
  for (const job of all) byTicket.set(job.key.split(':')[0], [...(byTicket.get(job.key.split(':')[0]) || []), job]);
  const closed = (ticket: string): boolean => (byTicket.get(ticket) || []).every((job) => job.archived_view) || (byTicket.get(ticket) || []).some((job) => job.merged_at);
  const titleOf = (ticket: string, fallback = ''): string => cleanTitle((byTicket.get(ticket) || []).map((job) => job.event?.issue?.title).filter(Boolean).at(-1) ?? fallback);
  const urlOf = (ticket: string, fallback?: string): string | undefined => {
    const jobsOf = byTicket.get(ticket) || [];
    return jobsOf.map((job) => job.event?.pull_request?.html_url).filter(Boolean).at(-1) ?? jobsOf.map((job) => job.event?.issue?.html_url).filter(Boolean).at(-1) ?? fallback;
  };
  const prOf = (ticket: string, fallback: number): number => (byTicket.get(ticket) || []).map((job) => job.event?.pull_request?.number).filter(Boolean).at(-1) ?? fallback;
  const seen = new Set<string>();

  const waitingItems: DigestItem[] = [];
  for (const entry of waiting) {
    const repo = entry.repository.toLowerCase();
    const ticket = byTicket.has(repo + '#' + entry.issue) ? repo + '#' + entry.issue : repo + '!pr' + entry.pr;
    if (closed(ticket) || seen.has(ticket)) continue;
    seen.add(ticket);
    waitingItems.push({ repository: entry.repository, number: entry.pr, title: titleOf(ticket), days: Math.floor((now - entry.since) / DAY_MS), url: urlOf(ticket, pullLink(config, entry.repository, entry.pr)) });
  }

  // Blocked: handed to a human and no run since (a run after that, such as a round the human started, ends the block).
  const blockedItems: DigestItem[] = [];
  for (const [ticket, list] of byTicket) {
    const blockedAt = Math.max(0, ...list.map((job) => job.blocked_at || 0));
    if (!blockedAt || seen.has(ticket) || closed(ticket) || list.some((job) => job.created > blockedAt)) continue;
    seen.add(ticket);
    const job = list.at(-1)!;
    blockedItems.push({ repository: job.event.repository.full_name, number: prOf(ticket, job.event.issue.number), title: titleOf(ticket), url: urlOf(ticket) });
  }

  const failedItems: DigestItem[] = [];
  for (const [ticket, list] of byTicket) {
    const failed = list.filter((job) => job.status === 'failed' && job.result !== 'deleted' && (job.finished || 0) >= now - DAY_MS);
    // Only a ticket whose newest run failed: a later run (the planner after a split, a retry that is running or done) means it is being dealt with.
    if (!failed.length || seen.has(ticket) || closed(ticket) || list.at(-1)!.status !== 'failed' || list.some((job) => job.split_at)) continue;
    seen.add(ticket);
    const job = failed.at(-1)!;
    failedItems.push({ repository: job.event.repository.full_name, number: prOf(ticket, job.event.issue.number), title: titleOf(ticket), result: job.result, url: urlOf(ticket) });
  }

  const quota = [...cooldowns].filter(([, until]) => until > now).sort(([a], [b]) => a < b ? -1 : 1).map(([tier, until]) => ({ tier, back: localClock(until, config.notify.timezone).time + ' ' + config.notify.timezone }));
  const merged = new Set(all.filter((job) => job.merged_at && job.merged_at >= now - DAY_MS).map((job) => job.key.split(':')[0])).size;
  waitingItems.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  return { waiting: waitingItems, blocked: blockedItems, failed: failedItems, quota, merged };
}
