// The words of the messages, in English and German. Fixed strings plus a few safe fields: the repository, a number, a title cut at 80
// characters without control characters, counts, a link and an age. Never code, file contents or ticket text beyond the title.
import type { NotifyLanguage } from '../types.ts';
import type { Notification } from './channel.ts';

const MAX_TITLE = 80;
export const DIGEST_MAX_ITEMS = 15;

export function cleanTitle(title: unknown): string {
  const text = String(title ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE - 1).join('').trimEnd() + '…' : text;
}

// owner/name -> name, the short form in subjects: "[homegraf] #140 ...".
export const shortRepo = (repository: string): string => String(repository).split('/').pop() || String(repository);

export type Security = 'ok' | 'concerns' | 'none';
export interface Facts {
  repository: string;
  number: number;
  title?: string | null;
  link?: string | null;
  /** handover: how many files touch protected paths, the policy's reason for them (operator text), the security review's finding. */
  files?: number;
  reason?: string | null;
  security?: Security;
  /** blocked: rounds_used_up, no_verdict, bot_pull_request, approval_not_trusted; failed: a run state or merge_failed. Anything else reads as `other`. */
  why?: string;
  /** reminder: days waited, which reminder of how many. */
  days?: number;
  nth?: number;
  of?: number;
}

const T = {
  en: {
    handoverSubject: 'waits for you to merge',
    handoverDone: (security: Security) => 'Reviewed, CI green. Security review: ' + { ok: 'no concerns', concerns: 'CONCERNS, read it before you merge', none: 'none' }[security] + '.',
    handoverWhy: (reason: string) => 'Why you: ' + reason,
    protectedPaths: 'it touches protected paths',
    files: (count: number) => 'Files in protected paths: ' + count,
    blockedSubject: 'is blocked',
    blocked: { rounds_used_up: 'the follow-up rounds are used up', no_verdict: 'the review ended twice without a verdict', bot_pull_request: 'a review asks for changes to this dependency update and no worker fixes those',
      approval_not_trusted: 'the approval has no valid review behind it', other: 'it needs a look' } as Record<string, string>,
    blockedWhy: (why: string) => 'ForgeHands stopped: ' + why + '.',
    conflictSubject: 'has a conflict',
    conflict: 'It conflicts with the default branch and ForgeHands cannot resolve it.',
    failedSubject: 'a run failed',
    failed: (why: string) => ({ merge_failed: 'The merge itself failed.', max_iterations: 'A run reached its iteration limit.', paused: 'A run was paused.', stuck: 'A run got stuck.',
      timeout: 'A run took too long.', no_delivery: 'A run finished without delivering anything.', error: 'A run ended with an error.' } as Record<string, string>)[why] || 'A run failed.',
    needsHuman: 'It needs a human decision.',
    reminderSubject: (days: number) => 'has waited ' + days + (days === 1 ? ' day' : ' days') + ' for you',
    reminder: (nth: number, of: number) => 'Reminder ' + nth + ' of ' + of + '.',
    age: (days: number) => days <= 0 ? 'waiting since today' : 'waiting ' + days + (days === 1 ? ' day' : ' days'),
    digestSubject: (count: number) => 'ForgeHands: ' + count + (count === 1 ? ' thing needs' : ' things need') + ' you',
    waiting: 'Waiting for you', blockedList: 'Blocked', quota: 'Held back by a quota', failedList: 'Failed in the last 24 hours',
    back: (time: string) => 'back about ' + time,
    merged: (count: number) => 'Merged in the last 24 hours: ' + count + '.',
    more: (count: number) => 'and ' + count + ' more'
  },
  de: {
    handoverSubject: 'wartet auf deinen Merge',
    handoverDone: (security: Security) => 'Geprüft, CI grün. Sicherheitsprüfung: ' + { ok: 'ohne Bedenken', concerns: 'BEDENKEN, vor dem Merge lesen', none: 'keine' }[security] + '.',
    handoverWhy: (reason: string) => 'Warum du: ' + reason,
    protectedPaths: 'er berührt geschützte Pfade',
    files: (count: number) => 'Dateien in geschützten Pfaden: ' + count,
    blockedSubject: 'ist blockiert',
    blocked: { rounds_used_up: 'die Folgerunden sind aufgebraucht', no_verdict: 'die Prüfung endete zweimal ohne Urteil', bot_pull_request: 'eine Prüfung verlangt Änderungen an diesem Abhängigkeits-Update und kein Worker behebt sie',
      approval_not_trusted: 'hinter der Freigabe steht keine gültige Prüfung', other: 'er braucht einen Blick' } as Record<string, string>,
    blockedWhy: (why: string) => 'ForgeHands hat angehalten: ' + why + '.',
    conflictSubject: 'hat einen Konflikt',
    conflict: 'Er kollidiert mit dem Standardbranch und ForgeHands kann das nicht lösen.',
    failedSubject: 'ein Lauf ist gescheitert',
    failed: (why: string) => ({ merge_failed: 'Der Merge selbst ist gescheitert.', max_iterations: 'Ein Lauf hat sein Iterationslimit erreicht.', paused: 'Ein Lauf wurde pausiert.', stuck: 'Ein Lauf hängt fest.',
      timeout: 'Ein Lauf hat zu lange gedauert.', no_delivery: 'Ein Lauf endete, ohne etwas zu liefern.', error: 'Ein Lauf endete mit einem Fehler.' } as Record<string, string>)[why] || 'Ein Lauf ist gescheitert.',
    needsHuman: 'Es braucht eine Entscheidung von dir.',
    reminderSubject: (days: number) => 'wartet seit ' + days + (days === 1 ? ' Tag' : ' Tagen') + ' auf dich',
    reminder: (nth: number, of: number) => 'Erinnerung ' + nth + ' von ' + of + '.',
    age: (days: number) => days <= 0 ? 'wartet seit heute' : 'wartet seit ' + days + (days === 1 ? ' Tag' : ' Tagen'),
    digestSubject: (count: number) => 'ForgeHands: ' + count + (count === 1 ? ' Sache braucht' : ' Dinge brauchen') + ' dich',
    waiting: 'Wartet auf dich', blockedList: 'Blockiert', quota: 'Wegen Kontingent zurückgehalten', failedList: 'Gescheitert in den letzten 24 Stunden',
    back: (time: string) => 'zurück gegen ' + time,
    merged: (count: number) => 'Gemergt in den letzten 24 Stunden: ' + count + '.',
    more: (count: number) => 'und ' + count + ' weitere'
  }
};

const head = (facts: Facts): string => '[' + shortRepo(facts.repository) + '] #' + facts.number;
const link = (facts: Facts): { link?: string } => facts.link ? { link: facts.link } : {};
const lines = (...parts: (string | null | undefined | false)[]): string => parts.filter((part): part is string => Boolean(part)).join('\n');

// One immediate message. `kind` is handover, blocked, conflict, failed or reminder; the text is short and has no code.
export function immediateMessage(language: NotifyLanguage, kind: string, facts: Facts): Notification {
  const t = T[language];
  const title = cleanTitle(facts.title);
  const base = { kind, ...link(facts) };
  if (kind === 'handover') {
    const reason = String(facts.reason ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 200) || t.protectedPaths;
    return { ...base, subject: head(facts) + ' ' + t.handoverSubject, text: lines(title, t.handoverDone(facts.security ?? 'none'), t.handoverWhy(reason), facts.files ? t.files(facts.files) : '') };
  }
  if (kind === 'blocked') {
    const why = t.blocked[facts.why ?? ''] ?? t.blocked.other;
    return { ...base, subject: head(facts) + ' ' + t.blockedSubject, text: lines(title, t.blockedWhy(why), t.needsHuman) };
  }
  if (kind === 'conflict') return { ...base, subject: head(facts) + ' ' + t.conflictSubject, text: lines(title, t.conflict, t.needsHuman) };
  if (kind === 'failed') return { ...base, subject: head(facts) + ' ' + t.failedSubject, text: lines(title, t.failed(facts.why ?? ''), t.needsHuman) };
  if (kind === 'reminder') {
    const days = Math.max(0, Math.floor(facts.days ?? 0));
    return { ...base, subject: head(facts) + ' ' + t.reminderSubject(days), text: lines(title, facts.nth && facts.of ? t.reminder(facts.nth, facts.of) : '') };
  }
  throw new Error('unknown notification kind ' + kind);
}

export interface DigestItem { repository: string; number: number; title: string; days?: number; result?: string }
export interface DigestData {
  waiting: DigestItem[];
  blocked: DigestItem[];
  failed: DigestItem[];
  /** Tiers whose model is out of quota and when they are expected back (formatted by the caller, in the digest's time zone). */
  quota: { tier: string; back: string }[];
  merged: number;
}

export const digestIsEmpty = (data: DigestData): boolean => !data.waiting.length && !data.blocked.length && !data.failed.length && !data.quota.length;

// The daily digest: one list line per item (`#140 title (waiting 2 days)`), at most 15 items in all, then "and N more". Null when there is nothing for the human.
export function digestMessage(language: NotifyLanguage, data: DigestData, showRepository: boolean): Notification | null {
  if (digestIsEmpty(data)) return null;
  const t = T[language];
  const ref = (item: DigestItem) => (showRepository ? shortRepo(item.repository) : '') + '#' + item.number;
  type Entry = { section: string; line: string };
  const entries: Entry[] = [
    ...data.waiting.map((item) => ({ section: t.waiting, line: ref(item) + ' ' + cleanTitle(item.title) + ' (' + t.age(item.days ?? 0) + ')' })),
    ...data.blocked.map((item) => ({ section: t.blockedList, line: ref(item) + ' ' + cleanTitle(item.title) })),
    ...data.quota.map((entry) => ({ section: t.quota, line: cleanTitle(entry.tier) + ' (' + t.back(entry.back) + ')' })),
    ...data.failed.map((item) => ({ section: t.failedList, line: ref(item) + ' ' + cleanTitle(item.title) + (item.result ? ' (' + cleanTitle(item.result) + ')' : '') }))
  ];
  const shown = entries.slice(0, DIGEST_MAX_ITEMS);
  const out: string[] = [];
  let section = '';
  for (const entry of shown) {
    if (entry.section !== section) {
      section = entry.section;
      out.push('', section + ' (' + entries.filter((other) => other.section === section).length + '):');
    }
    out.push(entry.line);
  }
  if (entries.length > shown.length) out.push('', t.more(entries.length - shown.length));
  if (data.merged > 0) out.push('', t.merged(data.merged));
  return { kind: 'digest', subject: t.digestSubject(entries.length), text: out.join('\n').trim() };
}
