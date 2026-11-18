// The words of the messages, in English and German. Fixed strings plus a few safe fields: the repository, a number, a title cut at 80
// characters without control characters, counts, a link and an age. Never code, file contents or ticket text beyond the title.
import type { IdleCounts, NotifyLanguage } from '../types.ts';
import type { Notification } from './channel.ts';

const MAX_TITLE = 80;
export const DIGEST_MAX_ITEMS = 15;

export function cleanTitle(title: unknown): string {
  const text = String(title ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:\[WIP\]|WIP:)\s*/i, '');
  const chars = Array.from(text);
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE - 1).join('').trimEnd() + '…' : text;
}

// owner/name -> name, the short form in subjects: "[homegraf] #140 ...".
export const shortRepo = (repository: string): string => String(repository).split('/').pop() || String(repository);


// ---- HTML: every value is escaped, a link is only used when it is a plain http(s) URL, and there is no script, image or external style.
export const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''));
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
const FONT = "font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;font-size:14px;line-height:1.5";
const page = (inner: string): string => '<!doctype html><html><body style="margin:0;padding:16px;background:#f6f8fa"><div style="' + FONT + ';max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:20px">' + inner + '</div></body></html>';
const anchor = (url: string | null, label: string): string => url ? '<a href="' + esc(url) + '" style="color:#0969da;text-decoration:none">' + esc(label) + '</a>' : esc(label);
const button = (url: string | null, label: string): string => url ? '<p style="margin:18px 0 0"><a href="' + esc(url) + '" style="display:inline-block;background:#1a7f37;color:#ffffff;text-decoration:none;padding:8px 16px;border-radius:6px;font-weight:600">' + esc(label) + '</a></p>' : '';
const TD = 'style="padding:6px 10px;border-top:1px solid #d0d7de;vertical-align:top"';
const TH = 'style="padding:6px 10px;text-align:left;background:#f6f8fa;font-weight:600"';
const table = (headers: string[], rows: string[][]): string => '<table style="border-collapse:collapse;width:100%;margin:6px 0 18px;border:1px solid #d0d7de"><thead><tr>' + headers.map((h) => '<th ' + TH + '>' + esc(h) + '</th>').join('')
  + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td ' + TD + '>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

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
  /** blocked: rounds_used_up, no_verdict, bot_pull_request, approval_not_trusted, stuck_rounds, stuck_verdict; failed: a run state or merge_failed. Anything else reads as `other`. */
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
      approval_not_trusted: 'the approval has no valid review behind it', stuck_rounds: 'the follow-up rounds are used up and the pull request did not move on',
      stuck_verdict: 'the latest review says NOT OK and nothing has changed since', ticket_preflight: 'the ticket breaks the pre-flight rules (Steps, Files or Acceptance) and no worker starts on it',
      other: 'it needs a look' } as Record<string, string>,
    blockedWhy: (why: string) => 'ForgeHands stopped: ' + why + '.',
    conflictSubject: 'has a conflict',
    conflict: 'It conflicts with the default branch and ForgeHands cannot resolve it.',
    failedSubject: 'a run failed',
    failed: (why: string) => ({ merge_failed: 'The merge itself failed.', max_iterations: 'A run reached its iteration limit.', paused: 'A run was paused.', stuck: 'A run got stuck.',
      timeout: 'A run took too long.', no_delivery: 'A run finished without delivering anything.', error: 'A run ended with an error.',
      main_red: 'CI failed on the default branch after a merge of ForgeHands. A revert is started, unless no revert route exists.',
      revert_red: 'CI failed on the default branch after a revert of ForgeHands. No further revert is started.' } as Record<string, string>)[why] || 'A run failed.',
    needsHuman: 'It needs a human decision.',
    reminderSubject: (days: number) => 'has waited ' + days + (days === 1 ? ' day' : ' days') + ' for you',
    reminder: (nth: number, of: number) => 'Reminder ' + nth + ' of ' + of + '.',
    age: (days: number) => days <= 0 ? 'waiting since today' : 'waiting ' + days + (days === 1 ? ' day' : ' days'),
    digestSubject: (count: number) => 'ForgeHands: ' + count + (count === 1 ? ' thing needs' : ' things need') + ' you',
    fixLine: (fixed: number, total: number, pct: number) => 'Follow-up fixes after automatic merges (7 days): ' + fixed + ' of ' + total + ' (' + pct + ' %)',
    fixPair: 'fixes',
    waiting: 'Waiting for you', blockedList: 'Blocked', quota: 'Held back by a quota', failedList: 'Failed in the last 24 hours',
    back: (time: string) => 'back about ' + time,
    merged: (count: number) => 'Merged in the last 24 hours: ' + count + '.',
    more: (count: number) => 'and ' + count + ' more',
    numberColumn: 'Ticket', titleColumn: 'Title', statusColumn: 'Status', tierColumn: 'Model tier', backColumn: 'Back',
    reasons: { max_iterations: 'reached its iteration limit', error: 'ended with an error', stuck: 'got stuck', timeout: 'took too long', no_delivery: 'delivered nothing', paused: 'was paused' }
  },
  de: {
    handoverSubject: 'wartet auf deinen Merge',
    handoverDone: (security: Security) => 'Geprüft, CI grün. Sicherheitsprüfung: ' + { ok: 'ohne Bedenken', concerns: 'BEDENKEN, vor dem Merge lesen', none: 'keine' }[security] + '.',
    handoverWhy: (reason: string) => 'Warum du: ' + reason,
    protectedPaths: 'er berührt geschützte Pfade',
    files: (count: number) => 'Dateien in geschützten Pfaden: ' + count,
    blockedSubject: 'ist blockiert',
    blocked: { rounds_used_up: 'die Folgerunden sind aufgebraucht', no_verdict: 'die Prüfung endete zweimal ohne Urteil', bot_pull_request: 'eine Prüfung verlangt Änderungen an diesem Abhängigkeits-Update und kein Worker behebt sie',
      approval_not_trusted: 'hinter der Freigabe steht keine gültige Prüfung', stuck_rounds: 'die Folgerunden sind aufgebraucht und der Pull-Request hat sich nicht weiterbewegt',
      stuck_verdict: 'die letzte Prüfung sagt NOT OK, und seitdem hat sich nichts geändert', ticket_preflight: 'das Ticket verletzt die Vorprüfung (Steps, Files oder Acceptance), und kein Worker startet darauf',
      other: 'er braucht einen Blick' } as Record<string, string>,
    blockedWhy: (why: string) => 'ForgeHands hat angehalten: ' + why + '.',
    conflictSubject: 'hat einen Konflikt',
    conflict: 'Er kollidiert mit dem Standardbranch und ForgeHands kann das nicht lösen.',
    failedSubject: 'ein Lauf ist gescheitert',
    failed: (why: string) => ({ merge_failed: 'Der Merge selbst ist gescheitert.', max_iterations: 'Ein Lauf hat sein Iterationslimit erreicht.', paused: 'Ein Lauf wurde pausiert.', stuck: 'Ein Lauf hängt fest.',
      timeout: 'Ein Lauf hat zu lange gedauert.', no_delivery: 'Ein Lauf endete, ohne etwas zu liefern.', error: 'Ein Lauf endete mit einem Fehler.',
      main_red: 'CI ist auf dem Standardbranch nach einem Merge von ForgeHands gescheitert. Ein Revert wird gestartet, sofern es eine Revert-Route gibt.',
      revert_red: 'CI ist auf dem Standardbranch nach einem Revert von ForgeHands gescheitert. Es wird kein weiterer Revert gestartet.' } as Record<string, string>)[why] || 'Ein Lauf ist gescheitert.',
    needsHuman: 'Es braucht eine Entscheidung von dir.',
    reminderSubject: (days: number) => 'wartet seit ' + days + (days === 1 ? ' Tag' : ' Tagen') + ' auf dich',
    reminder: (nth: number, of: number) => 'Erinnerung ' + nth + ' von ' + of + '.',
    age: (days: number) => days <= 0 ? 'wartet seit heute' : 'wartet seit ' + days + (days === 1 ? ' Tag' : ' Tagen'),
    digestSubject: (count: number) => 'ForgeHands: ' + count + (count === 1 ? ' Sache braucht' : ' Dinge brauchen') + ' dich',
    fixLine: (fixed: number, total: number, pct: number) => 'Folgefixes nach automatischen Merges (7 Tage): ' + fixed + ' von ' + total + ' (' + pct + ' %)',
    fixPair: 'behebt',
    waiting: 'Wartet auf dich', blockedList: 'Blockiert', quota: 'Wegen Kontingent zurückgehalten', failedList: 'Gescheitert in den letzten 24 Stunden',
    back: (time: string) => 'zurück gegen ' + time,
    merged: (count: number) => 'Gemergt in den letzten 24 Stunden: ' + count + '.',
    more: (count: number) => 'und ' + count + ' weitere',
    numberColumn: 'Ticket', titleColumn: 'Titel', statusColumn: 'Stand', tierColumn: 'Modell-Stufe', backColumn: 'Zurück',
    reasons: { max_iterations: 'Iterationslimit erreicht', error: 'Fehler', stuck: 'hängt fest', timeout: 'zu lange gedauert', no_delivery: 'nichts geliefert', paused: 'pausiert' }
  }
};

const head = (facts: Facts): string => '[' + shortRepo(facts.repository) + '] #' + facts.number;
const link = (facts: Facts): { link?: string } => facts.link ? { link: facts.link } : {};
const lines = (...parts: (string | null | undefined | false)[]): string => parts.filter((part): part is string => Boolean(part)).join('\n');

// One immediate message. `kind` is handover, blocked, conflict, failed or reminder; the text is short and has no code.
function immediatePlain(language: NotifyLanguage, kind: string, facts: Facts): Notification {
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

// The immediate message as a mail: the plain text of immediatePlain and the same in HTML (a heading, the lines, a button to the pull request).
export function immediateMessage(language: NotifyLanguage, kind: string, facts: Facts): Notification {
  const plain = immediatePlain(language, kind, facts);
  const parts = plain.text.split('\n');
  const url = safeUrl(plain.link);
  const label = language === 'de' ? 'Öffnen' : 'Open';
  const [title, ...rest] = parts;
  const html = page('<p style="margin:0 0 4px;font-size:16px;font-weight:600">' + esc(plain.subject) + '</p>'
    + (title ? '<p style="margin:0 0 12px;color:#57606a">' + esc(title) + '</p>' : '')
    + (rest.length ? '<p style="margin:0">' + rest.map(esc).join('<br>') + '</p>' : '') + button(url, label));
  return { ...plain, html };
}

export interface StallFacts { minutes: number; reasons: IdleCounts; tiers: string[]; cycles?: string[] }
// The stall alert (STALL_ALERT_MINUTES): how long nothing started and what the queued work waits for, in words. Numbers and tier names only.
export function stallMessage(language: NotifyLanguage, facts: StallFacts): Notification {
  const de = language === 'de';
  const r = facts.reasons;
  const tiers = facts.tiers.length ? facts.tiers.join(', ') : (de ? 'keine' : 'none');
  const parts = de
    ? [r.quota ? r.quota + ' zurückgehalten wegen Kontingent (' + tiers + ')' : '', r.disk ? r.disk + ' zurückgehalten, wenig Platz auf der Platte' : '',
      r.hourly ? r.hourly + ' über dem Stundenlimit' : '', r.concurrency ? r.concurrency + ' über einem Parallelitätslimit' : '',
      r.could_start ? r.could_start + ' könnten starten und tun es nicht' : '', r.cycle ? r.cycle + ' in einem Abhängigkeitszyklus, keiner kann starten' : '',
      ...(facts.cycles ?? []).map((text) => 'Zyklus: ' + text)]
    : [r.quota ? r.quota + ' held by a quota (' + tiers + ')' : '', r.disk ? r.disk + ' held by low disk space' : '',
      r.hourly ? r.hourly + ' over the hourly limit' : '', r.concurrency ? r.concurrency + ' over a concurrency limit' : '',
      r.could_start ? r.could_start + ' could start and do not' : '', r.cycle ? r.cycle + ' in a dependency cycle, none of them can start' : '',
      ...(facts.cycles ?? []).map((text) => 'Cycle: ' + text)];
  const first = de ? 'Seit ' + facts.minutes + ' Minuten ist kein Lauf gestartet, und keiner läuft.' : 'No run has started for ' + facts.minutes + ' minutes and none is running.';
  const subject = de ? 'ForgeHands: seit ' + facts.minutes + ' Minuten kein Lauf' : 'ForgeHands: nothing has started for ' + facts.minutes + ' min';
  const lines = [first, ...parts.filter(Boolean), de ? 'Abhängigkeiten zwischen Tickets zählen nicht: eine Kette ist normal. Siehe /status.' : 'Waits on dependencies do not count: a chain of tickets is normal. See /status.'];
  const html = page('<p style="margin:0 0 4px;font-size:16px;font-weight:600">' + esc(subject) + '</p><p style="margin:0">' + lines.map(esc).join('<br>') + '</p>');
  return { kind: 'stalled', subject, text: lines.join('\n'), html };
}

export interface DiskFacts { usedPercent: number; freeGb: number; warnPercent: number; minFreeGb: number }
// The disk warning (DISK_WARN_PERCENT): how full the workspace disk is and which settings act on it. Numbers and fixed strings only.
export function diskMessage(language: NotifyLanguage, facts: DiskFacts): Notification {
  const de = language === 'de';
  const subject = de ? 'ForgeHands: Platte des Arbeitsbereichs ist zu ' + facts.usedPercent + ' % belegt' : 'ForgeHands: workspace disk is ' + facts.usedPercent + ' % full';
  const lines = de
    ? [facts.usedPercent + ' % belegt, ' + facts.freeGb + ' GB frei (Warnung ab DISK_WARN_PERCENT ' + facts.warnPercent + ').',
      'Klone beendeter Läufe entfernt ForgeHands selbst (WORKSPACE_KEEP_HOURS, WORKSPACE_KEEP_FAILED_HOURS, WORKSPACE_ORPHAN_HOURS). Unter DISK_MIN_FREE_GB (' + facts.minFreeGb + ' GB) startet kein neuer Lauf.']
    : [facts.usedPercent + ' % used, ' + facts.freeGb + ' GB free (warning from DISK_WARN_PERCENT ' + facts.warnPercent + ').',
      'ForgeHands removes the clone directories of ended runs itself (WORKSPACE_KEEP_HOURS, WORKSPACE_KEEP_FAILED_HOURS, WORKSPACE_ORPHAN_HOURS). Below DISK_MIN_FREE_GB (' + facts.minFreeGb + ' GB) no new run starts.'];
  const html = page('<p style="margin:0 0 4px;font-size:16px;font-weight:600">' + esc(subject) + '</p><p style="margin:0">' + lines.map(esc).join('<br>') + '</p>');
  return { kind: 'disk_full', subject, text: lines.join('\n'), html };
}

export interface DigestItem { repository: string; number: number; title: string; days?: number; result?: string; /** Where to look: the pull request or, without one, the issue. */ url?: string }
/** A fix that followed an automatic merge: `fix` is the later pull request, `original` the merged one it fixes. */
export interface FixPair { fix: DigestItem; original: DigestItem }
/** The quality figure of the automatic merges of 7 days: `fixed` of `total` were followed by a fix within 48 hours. */
export interface FixQuote { fixed: number; total: number; pairs: FixPair[] }
export interface DigestData {
  waiting: DigestItem[];
  blocked: DigestItem[];
  failed: DigestItem[];
  /** Tiers whose model is out of quota and when they are expected back (formatted by the caller, in the digest's time zone). */
  quota: { tier: string; back: string }[];
  merged: number;
  /** The follow-up fixes of the automatic merges; null or absent when there are none to count. Shown in a digest, never sent by itself. */
  fixes?: FixQuote | null;
}

export const digestIsEmpty = (data: DigestData): boolean => !data.waiting.length && !data.blocked.length && !data.failed.length && !data.quota.length;

// The daily digest as a mail with tables, one per section, each number a link; the plain text has the same items with the link below them.
// At most 15 items in all, then "and N more". Null when there is nothing for the human.
export function digestMessage(language: NotifyLanguage, data: DigestData, showRepository: boolean): Notification | null {
  if (digestIsEmpty(data)) return null;
  const t = T[language];
  const ref = (item: DigestItem) => (showRepository ? shortRepo(item.repository) : '') + '#' + item.number;
  // A pair names its repository always: it can be another repository than the one of the digest's other items.
  const fullRef = (item: DigestItem) => item.repository + ' #' + item.number;
  type Entry = { section: string; cells: string[]; ref?: string; url: string | null; line: string };
  const item = (section: string, it: DigestItem, extra: string): Entry => ({ section, ref: ref(it), url: safeUrl(it.url), cells: [cleanTitle(it.title), extra], line: ref(it) + ' ' + cleanTitle(it.title) + (extra ? ' (' + extra + ')' : '') });
  const entries: Entry[] = [
    ...data.waiting.map((it) => item(t.waiting, it, t.age(it.days ?? 0))),
    ...data.blocked.map((it) => item(t.blockedList, it, '')),
    ...data.quota.map((q) => ({ section: t.quota, cells: [cleanTitle(q.tier), t.back(q.back)], url: null, line: cleanTitle(q.tier) + ' (' + t.back(q.back) + ')' })),
    ...data.failed.map((it) => item(t.failedList, it, it.result ? reasonLabel(language, it.result) : ''))
  ];
  const shown = entries.slice(0, DIGEST_MAX_ITEMS);
  const out: string[] = [];
  const blocks: string[] = [];
  const sections = [...new Set(shown.map((entry) => entry.section))];
  for (const section of sections) {
    const inSection = shown.filter((entry) => entry.section === section);
    out.push('', section + ' (' + entries.filter((other) => other.section === section).length + '):');
    for (const entry of inSection) { out.push(entry.line); if (entry.url) out.push('  ' + entry.url); }
    const isQuota = section === t.quota;
    blocks.push('<h3 style="margin:18px 0 0;font-size:15px">' + esc(section) + ' (' + entries.filter((other) => other.section === section).length + ')</h3>'
      + table(isQuota ? [t.tierColumn, t.backColumn] : [t.numberColumn, t.titleColumn, t.statusColumn],
        inSection.map((entry) => isQuota ? entry.cells.map(esc) : [anchor(entry.url, entry.ref || ''), esc(entry.cells[0]), esc(entry.cells[1])])));
  }
  if (entries.length > shown.length) { out.push('', t.more(entries.length - shown.length)); blocks.push('<p style="margin:0 0 12px;color:#57606a">' + esc(t.more(entries.length - shown.length)) + '</p>'); }
  // The quality figure: one line, and the pairs as links only for up to 5 of them.
  const fixes = data.fixes;
  if (fixes && fixes.total > 0) {
    const pct = Math.round(fixes.fixed / fixes.total * 100);
    const label = t.fixLine(fixes.fixed, fixes.total, pct);
    out.push('', label);
    const pairs = fixes.fixed <= 5 ? fixes.pairs : [];
    for (const pair of pairs) { out.push(fullRef(pair.fix) + ' ' + t.fixPair + ' ' + fullRef(pair.original)); if (safeUrl(pair.fix.url)) out.push('  ' + pair.fix.url); }
    blocks.push('<p style="margin:14px 0 0;font-weight:600">' + esc(label) + '</p>' + pairs.map((pair) => '<p style="margin:4px 0 0">' + anchor(safeUrl(pair.fix.url), fullRef(pair.fix)) + ' ' + esc(t.fixPair) + ' ' + esc(fullRef(pair.original)) + '</p>').join(''));
  }
  if (data.merged > 0) { out.push('', t.merged(data.merged)); blocks.push('<p style="margin:12px 0 0;color:#57606a">' + esc(t.merged(data.merged)) + '</p>'); }
  const subject = t.digestSubject(entries.length);
  return { kind: 'digest', subject, text: out.join('\n').trim(), html: page('<p style="margin:0;font-size:16px;font-weight:600">' + esc(subject) + '</p>' + blocks.join('')) };
}

// A run's end state (max_iterations, error, ...) in words.
const reasonLabel = (language: NotifyLanguage, result: string): string => (T[language].reasons as Record<string, string>)[result] ?? cleanTitle(result);
