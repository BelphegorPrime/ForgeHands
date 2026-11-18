// The daily digest: what is for the human right now, read from the ledger, the reminder's list of waiting pull requests and the quota holds.
// No message when there is nothing (the operator wants no "all fine" mail).
import type { DirectConfig, Job } from '../types.ts';
import type { JobStore } from '../store/jobs.ts';
import type { DigestData, DigestItem, FixPair, FixQuote } from './texts.ts';
import { cleanTitle } from './texts.ts';
import type { Forge, PullRequest } from '../types/forge.ts';

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

// ---- Follow-up fixes after automatic merges (the quality figure of the digest) ----
// Of the pull requests that the agent user merged in the last 7 days, how many were followed within 48 hours by another merged pull request of
// the same repository whose title is a Conventional Commit `fix` and that touches one of the same files. Who merged is asked of the forge
// (merged_by of a single pull request), because the ledger misses merges; the list endpoint does not carry it. Only Forgejo and Gitea say it.
// Approximation: the fix type is read from the title only (no commit reads), and only the newest 250 updated closed pull requests are listed.
const FIX_WINDOW_DAYS = 7;
const FIX_AFTER_MS = 48 * 3600000;
// Forge calls per digest (listing pages, single reads, file reads) taken together.
export const FIX_READS = 120;
const LIST_PAGE = 50;
const LIST_PAGES = 5;
const FIX_TITLE = /^\s*(?:\[WIP\]|WIP:)?\s*fix(?:\([^)\n]*\))?!?:/i;
export const isFixTitle = (title: unknown): boolean => FIX_TITLE.test(String(title ?? ''));

interface Merged { repository: string; number: number; title: string; url?: string; at: number; key: string; branch: string; author: string }

export type FixForge = Pick<Forge, 'agentLogin' | 'listPulls' | 'getPull' | 'pullFiles'>;

// The figure of the last 7 days (null when no automatic merge is in it, or the forge cannot say who merged). A read that fails skips its pull
// request and says so in the log; a pull request whose files cannot be read is left out of the count.
export async function collectFixes(config: DirectConfig, jobs: JobStore, forge: FixForge, now: number, logger: { error(...args: unknown[]): void } = console, budget = FIX_READS): Promise<FixQuote | null> {
  let left = budget;
  const take = (): boolean => { if (left <= 0) return false; left -= 1; return true; };
  const since = now - FIX_WINDOW_DAYS * DAY_MS;
  const errText = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 200);
  const fullNames = new Map<string, string>();
  for (const job of jobs.list()) {
    const name = job.event?.repository?.full_name;
    if (name) fullNames.set(String(name).toLowerCase(), name);
  }
  const nameOf = (repository: string) => fullNames.get(repository) || repository;

  let login: string | null = null;
  try {
    if (take()) login = (await forge.agentLogin?.()) ?? null;
  } catch (error) {
    logger.error('digest: could not read the agent user, the follow-up figure is skipped:', errText(error));
    return null;
  }
  if (!login) return null;
  const agent = login.toLowerCase();

  // The merged pull requests of the window, per repository, newest updated first (a page of 50 each, up to 5 pages).
  const merged: Merged[] = [];
  for (const repository of [...config.allowedRepos].sort()) {
    const name = nameOf(repository);
    for (let page = 1; page <= LIST_PAGES; page++) {
      if (!take()) { logger.error('digest: read budget used up while listing the merged pull requests of ' + name); break; }
      let list: PullRequest[];
      try { list = await forge.listPulls(name, { state: 'closed', sort: 'recentupdate', limit: LIST_PAGE, page }); }
      catch (error) { logger.error('digest: could not list the closed pull requests of ' + name + ':', errText(error)); break; }
      if (!Array.isArray(list) || !list.length) break;
      for (const pr of list) {
        const at = Date.parse(String(pr.merged_at ?? ''));
        if (!pr.merged || !Number.isFinite(at) || at < since || at > now) continue;
        merged.push({ repository: name, number: pr.number, title: String(pr.title ?? ''), url: pr.html_url || pullLink(config, name, pr.number), at,
          key: name.toLowerCase() + '#' + pr.number, branch: String(pr.head?.ref ?? ''), author: String(pr.user?.login ?? pr.user?.username ?? '').toLowerCase() });
      }
      if (list.length < LIST_PAGE || Date.parse(list.at(-1)!.updated_at) < since) break;
    }
  }
  merged.sort((a, b) => a.at - b.at);

  // Who merged: only the pull requests that ForgeHands or a dependency bot could have merged are asked (their branch or author says so).
  const automatic = merged.filter((pr) => /^ai\/issue-\d+$/.test(pr.branch) || config.botBranchPrefixes.some((prefix) => pr.branch.startsWith(prefix)) || config.botAuthors.has(pr.author));
  const originals: Merged[] = [];
  for (const pr of automatic) {
    if (!take()) { logger.error('digest: read budget used up while asking who merged the pull requests'); break; }
    try {
      const single = await forge.getPull(pr.repository, pr.number);
      if (String(single.merged_by?.login ?? '').toLowerCase() === agent) originals.push(pr);
    } catch (error) {
      logger.error('digest: could not read ' + pr.repository + ' #' + pr.number + ', left out of the figure:', errText(error));
    }
  }

  // The fix candidates: merged in the window with a fix title. Their files and those of an original are read once each.
  const fixes = merged.filter((pr) => isFixTitle(pr.title));
  const files = new Map<string, Set<string> | null>();
  const filesOf = async (pr: Merged): Promise<Set<string> | null> => {
    if (files.has(pr.key)) return files.get(pr.key) ?? null;
    if (!take()) return null;
    try {
      const list = await forge.pullFiles(pr.repository, pr.number, 100);
      const names = new Set<string>();
      for (const file of Array.isArray(list) ? list : []) { if (file?.filename) names.add(file.filename); if (file?.previous_filename) names.add(file.previous_filename); }
      files.set(pr.key, names);
      return names;
    } catch (error) {
      logger.error('digest: could not read the files of ' + pr.repository + ' #' + pr.number + ':', errText(error));
      files.set(pr.key, null);
      return null;
    }
  };

  const pairs: FixPair[] = [];
  let total = 0;
  for (const original of originals) {
    const following = fixes.filter((fix) => fix.repository === original.repository && fix.number !== original.number && fix.at > original.at && fix.at <= original.at + FIX_AFTER_MS);
    if (!following.length) { total += 1; continue; }
    const own = await filesOf(original);
    if (!own) continue;
    total += 1;
    for (const fix of following) {
      const theirs = await filesOf(fix);
      if (!theirs || ![...theirs].some((name) => own.has(name))) continue;
      pairs.push({ fix: { repository: fix.repository, number: fix.number, title: fix.title, url: fix.url }, original: { repository: original.repository, number: original.number, title: original.title, url: original.url } });
      break;
    }
  }
  if (!total) return null;
  return { fixed: pairs.length, total, pairs };
}
