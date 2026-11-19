import { createHash } from 'node:crypto';
import { isDry } from '../dry.ts';
import { metrics } from '../metrics.ts';
import { mentionOf } from '../notify/index.ts';
import type { Facts } from '../notify/texts.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent, Logger } from '../types.ts';
import { pullBranch } from './bot.ts';

// The ticket pre-flight (TICKET_PREFLIGHT, on by default): a broken worker ticket starts no run. The rules are checks of the ticket's text and
// one read of the repository. The comment names the rule; the README says what each one means.
//   1. every path named in Steps is listed in Files (or is a file that exists on the default branch);
//   2. Acceptance has a fenced block that holds a command;
//   3. that command is not a placeholder and its quotes close (a static check: running it on the default branch needs a checkout, which
//      ForgeHands does not have, so it is not done here);
//   4. the files listed in Files exist on the default branch, unless the ticket says it creates them (a line says "new", or Steps has a
//      creating verb, or one listed file exists). Only when none of them exists and nothing says they are created is the ticket broken.
// Which rules reject is TICKET_PREFLIGHT_BLOCK (default 2,3). The other findings are advisory: they never reject, and their notes go into the
// worker's prompt. Rule 1 may be made to reject; the weaker form of rule 4 (a listed file is missing, but another listed file exists or Steps
// say that files are created) is advisory only.
// Headings are read: Steps, Files (or "Exact files", the heading of WAIT_FOR_SAME_FILES) and Acceptance. A forge that cannot read files
// makes rule 4 unknown, and unknown counts as no violation.
// The pre-flight is skipped for a ticket that was worked on before (an issue run in the ledger) or whose pull request branch (ai/issue-<n>)
// is open: such a ticket was workable once, and its rounds follow their own rules. A skipped ticket is never closed or sent back, so the
// pre-flight never closes a pull request.

export interface Violation {
  rule: 1 | 2 | 3 | 4;
  /** The line of the rejection comment. */
  text: string;
  /** The fact the worker's prompt carries when the finding does not reject the ticket. */
  note: string;
  /** Whether TICKET_PREFLIGHT_BLOCK may make this finding reject the ticket. The weaker form of rule 4 is not blockable. */
  blockable: boolean;
}

/** The findings that reject a ticket under the rules of TICKET_PREFLIGHT_BLOCK, and the rest, which are advisory. */
export function splitViolations(violations: Violation[], block: readonly number[]): { blocking: Violation[]; advisory: Violation[] } {
  const blocking = violations.filter((violation) => violation.blockable && block.includes(violation.rule));
  return { blocking, advisory: violations.filter((violation) => !blocking.includes(violation)) };
}

/** The first words of the comment that rejects a ticket; the end-to-end suite looks for them to fail a scenario at once. */
export const PREFLIGHT_REJECTION = 'ForgeHands: the ticket breaks the pre-flight';

/** Whether a path exists on the default branch: true, false, or null when the forge cannot say. */
export type Exists = (path: string) => Promise<boolean | null>;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
// A path: optional ./, slash-separated names, an extension that starts with a letter (so `1.5` or `v0.9.7` are no paths). Globs (`*`)
// and folders do not match, so they are not checked.
const PATH = /^(?:\.\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[A-Za-z][A-Za-z0-9]*$/;
const PLACEHOLDER = /^(?:\.\.\.|…|<[^>]*>|todo|tbd|command|your command here)$/i;
// A name in Steps counts as a file only when its extension is a file type of a repository. `import.meta.url`, `process.env.X` or `Array.isArray`
// end in no such extension, so they are code, not paths.
const FILE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'md', 'mdx', 'txt', 'py',
  'go', 'rs', 'rb', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'sql', 'html', 'htm', 'css', 'scss',
  'less', 'xml', 'proto', 'graphql', 'gql', 'lock', 'ini', 'cfg', 'conf', 'tf', 'hcl', 'vue', 'svelte', 'lua', 'ex', 'exs', 'hs', 'scala', 'dart',
  'zig', 'nix', 'gradle', 'properties', 'csv', 'tsv', 'svg', 'png', 'jpg', 'gif', 'pem', 'mk', 'cmake']);
// Words that say a file is created: "Create `x`", "add the file", "a new module", "emit", "write", "generate".
const CREATES = /\b(create|creates|created|creating|add|adds|added|adding|new|emit|emits|emitted|emitting|write|writes|written|writing|generate|generates|generated|generating|introduce|introduces|introduced|scaffold|scaffolds)\b/i;
// The first segment of a URL-like path (forge.example/owner/repo): a host, not a folder.
const HOST = /\.(com|org|net|io|dev|codes|local|example|app|de|eu)$/i;
// The most violations a rejection comment names; the rest is counted ("and N more").
const LIST_LIMIT = 6;
// Pull requests read per page, and the pages read when a ticket's pull request is looked for.
const PULL_PAGE = 50;
const PULL_PAGES = 5;

interface Heading { index: number; level: number; title: string }

// The headings of the body, skipping those inside a fenced code block (a "# comment" in a shell block is not a heading).
function headingsOf(lines: string[]): Heading[] {
  const found: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const open = FENCE.exec(line);
    if (fence !== null) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !open[2].trim()) fence = null;
      return;
    }
    if (open) { fence = open[1]; return; }
    const heading = HEADING.exec(line);
    if (heading) found.push({ index, level: heading[1].length, title: heading[2].replace(/:$/, '').trim().toLowerCase() });
  });
  return found;
}

// The lines under every heading whose title matches, down to the next heading of the same or a higher level. `found` tells a missing
// section from an empty one.
function section(lines: string[], headings: Heading[], title: RegExp): { found: boolean; lines: string[] } {
  const out: { found: boolean; lines: string[] } = { found: false, lines: [] };
  headings.forEach((heading, i) => {
    if (!title.test(heading.title)) return;
    const next = headings.slice(i + 1).find((other) => other.level <= heading.level);
    out.found = true;
    out.lines.push(...lines.slice(heading.index + 1, next ? next.index : lines.length));
  });
  return out;
}

// The bodies of the closed fenced blocks of these lines (an unclosed block is not one).
function fencedBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let open: { marker: string; text: string[] } | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (open === null) {
      if (fence) open = { marker: fence[1], text: [] };
      continue;
    }
    if (fence && fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && !fence[2].trim()) {
      blocks.push(open.text.join('\n'));
      open = null;
    } else open.text.push(line);
  }
  return blocks;
}

// A path as the path it names: without a leading "./", and without a line number after it.
function addPath(found: Set<string>, token: string): void {
  const path = token.trim().replace(/:\d+$/, '').replace(/^\.\//, '');
  if (PATH.test(path)) found.add(path);
}

// The paths a text names: the code spans that are paths, and bare words with a slash (a bare word without one is not taken: "e.g." is no path).
function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const span of text.matchAll(/`([^`\n]+)`/g)) addPath(found, span[1]);
  for (const word of text.replace(/`[^`\n]*`/g, ' ').split(/[\s,;()<>"'|]+/)) {
    if (word.includes('/')) addPath(found, word.replace(/[.:]+$/, ''));
  }
  return [...found];
}

// One token of Steps as the file it names, or null when it is code, a URL, a version, a glob or a prose word. A file name needs a file extension
// of FILE_EXTENSIONS; a bare name (no slash) also needs a stem that is all lower case or all capitals (README, Makefile), so "Node.js" is prose.
// A version number in the name (users-3.1.yaml) is no file name. `fenced` tokens count only with a slash.
function stepPath(token: string, fenced: boolean): string | null {
  let path = token.trim().replace(/:\d+$/, '').replace(/\.+$/, '').replace(/^\.\//, '');
  if (!path || (fenced && !path.includes('/'))) return null;
  if (path.includes('://') || /^www\./i.test(path) || /[\s()=[\]{}<>*"'`$,;|&]/.test(path)) return null;
  if (!PATH.test(path)) return null;
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  const dot = base.lastIndexOf('.');
  const extension = base.slice(dot + 1).toLowerCase();
  const stem = base.slice(0, dot);
  if (!FILE_EXTENSIONS.has(extension) || /\d+\.\d+/.test(base)) return null;
  if (segments.length > 1 && HOST.test(segments[0])) return null;
  if (segments.length === 1 && !/^[a-z0-9_.@+-]+$/.test(stem) && !/^[A-Z0-9_.@+-]+$/.test(stem)) return null;
  return path;
}

// The files a Steps section names: its code spans and bare words, and in a fenced block only the tokens with a slash.
function stepPaths(lines: string[]): Set<string> {
  const found = new Set<string>();
  const add = (token: string, fenced: boolean) => { const path = stepPath(token, fenced); if (path) found.add(path); };
  let fence: string | null = null;
  for (const line of lines) {
    const open = FENCE.exec(line);
    if (fence !== null) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !open[2].trim()) fence = null;
      else for (const token of line.split(/[\s,;()<>"'|`]+/)) add(token, true);
      continue;
    }
    if (open) { fence = open[1]; continue; }
    for (const span of line.matchAll(/`([^`\n]+)`/g)) add(span[1], false);
    for (const word of line.replace(/`[^`\n]*`/g, ' ').split(/[\s,;()<>"'|]+/)) add(word, false);
  }
  return found;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// The files of the Files section, each with whether its line says "new".
function filesOf(lines: string[]): Map<string, boolean> {
  const files = new Map<string, boolean>();
  for (const line of lines) {
    for (const path of pathsIn(line)) files.set(path, (files.get(path) ?? false) || /\bnew\b/i.test(line));
  }
  return files;
}

// Quote characters that are never closed. A shell quote can run over lines, so the whole command is read at once; a backslash escapes
// the next character outside single quotes.
function hasOpenQuote(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === '\\') { i++; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === "'" || char === '"') quote = char;
  }
  return quote !== null;
}

// Why a fenced block is not a command that can run (rule 3), or null. Comment lines of a shell block are not part of the command.
function commandProblem(block: string): string | null {
  const command = block.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').trim();
  if (!command) return 'has only comments, no command';
  if (PLACEHOLDER.test(command)) return 'is a placeholder, not a command';
  if (hasOpenQuote(command)) return 'has a quote that is never closed, so it cannot run';
  return null;
}

// The violated rules of a ticket body, in rule order; none when the ticket passes. `exists` answers rule 4 (absent: rule 4 is not checked).
export async function ticketViolations(body: string, exists?: Exists): Promise<Violation[]> {
  const lines = String(body || '').split(/\r?\n/);
  const headings = headingsOf(lines);
  const steps = section(lines, headings, /^steps?$/);
  const files = filesOf(section(lines, headings, /^(files|exact files|file list)$/).lines);
  const acceptance = section(lines, headings, /^acceptance\b/);
  const violations: Violation[] = [];

  if (steps.found) {
    // A name is listed when Files has it, or a bare name is the basename of a listed file, or a path is the end of a listed one. Otherwise it
    // breaks the rule unless it is a file of the default branch (the exists function says so).
    const listed = [...files.keys()];
    const names = new Set(listed.map(baseName));
    const unlisted = [...stepPaths(steps.lines)].filter((path) => !files.has(path)
      && !(path.includes('/') ? listed.some((item) => item.endsWith('/' + path)) : names.has(path)));
    for (const path of unlisted) {
      if (exists && (await exists(path)) === true) continue;
      violations.push({
        rule: 1, blockable: true,
        text: '`' + path + '` is named in Steps but not listed in Files',
        note: 'the Steps name `' + path + '`, which the Files list does not contain'
      });
    }
  }

  if (!acceptance.found) violations.push({ rule: 2, blockable: true, text: 'the ticket has no Acceptance section with a fenced command block', note: 'the ticket has no Acceptance section with a fenced command block' });
  else {
    const blocks = fencedBlocks(acceptance.lines).filter((block) => block.trim());
    if (!blocks.length) violations.push({ rule: 2, blockable: true, text: 'the Acceptance section has no fenced command block', note: 'the Acceptance section has no fenced command block' });
    for (const block of blocks) {
      const problem = commandProblem(block);
      if (problem) { violations.push({ rule: 3, blockable: true, text: 'the acceptance command ' + problem, note: 'the acceptance command ' + problem }); break; }
    }
  }

  // Rule 4 is read when no listed file is marked new. A missing listed file is blockable only when no listed file exists, Steps say nothing about
  // creating files and every answer is known: the ticket cannot be worked at all. Otherwise (one listed file exists, or Steps say that files are
  // created) it is a note: the planner's lists are mixed, and a created file is not always marked new. An unknown answer (null) counts as no
  // violation.
  if (exists && files.size && ![...files.values()].some(Boolean)) {
    const missing: string[] = [];
    let unknown = false;
    let someExists = false;
    for (const path of files.keys()) {
      const here = await exists(path);
      if (here === true) someExists = true;
      else if (here === false) missing.push(path);
      else unknown = true;
    }
    const creates = CREATES.test(steps.lines.join('\n'));
    const advisory = someExists || creates;
    if (advisory || !unknown) {
      for (const path of missing) {
        violations.push({
          rule: 4, blockable: !advisory,
          text: '`' + path + '` is listed in Files but does not exist on the default branch (mark it new if the ticket creates it)',
          note: '`' + path + '` is listed in Files but does not exist on the default branch and is not marked new'
        });
      }
    }
  }
  return violations;
}

// The revision of a ticket: the hash of its title and body. The same revision is commented once; an edit makes a new one.
export function ticketRevision(title: string, body: string): string {
  return createHash('sha256').update(title + '\n' + body).digest('hex').slice(0, 16);
}

export interface PreflightDeps {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  logger: Logger;
  now: () => number;
  /** Tells the human about a ticket that is handed to him (the dispatcher's notifier). */
  tell: (kind: string, event: ForgeEvent, facts: Partial<Facts>) => void;
}

export class TicketPreflight {
  config: DirectConfig;
  jobs: JobStore;
  forge: Forge;
  logger: Logger;
  now: () => number;
  tell: PreflightDeps['tell'];

  constructor(deps: PreflightDeps) {
    this.config = deps.config;
    this.jobs = deps.jobs;
    this.forge = deps.forge;
    this.logger = deps.logger;
    this.now = deps.now;
    this.tell = deps.tell;
  }

  // Why the pre-flight does not apply to this ticket, or null when it does: a worker run of the ticket finished before (an issue run in the
  // ledger), or its pull request branch ai/issue-<n> is open. When the forge cannot say whether a pull request is open, the ticket is not
  // rejected (the rejection sends it to the planner, whose route closes an open pull request).
  async skipReason(repository: string, number: number): Promise<string | null> {
    const ticket = repository.toLowerCase() + '#' + number + ':';
    const worked = this.jobs.list().some((job) => job.key.startsWith(ticket) && this.config.routes.get(job.label)?.kind === 'issue'
      && (job.status === 'done' || job.status === 'failed' || job.finished !== undefined));
    if (worked) return 'the ticket was worked on before';
    try {
      if (await this.hasOpenPull(repository, number)) return 'its pull request is open';
    } catch (error) {
      this.logger.error(repository + '#' + number + ': could not read the open pull requests, the pre-flight is skipped:', (error as Error).message);
      return 'the open pull requests are unknown';
    }
    return null;
  }

  // Is the pull request of branch ai/issue-<n> open? Up to PULL_PAGES pages of PULL_PAGE open pull requests are read.
  async hasOpenPull(repository: string, number: number): Promise<boolean> {
    const branch = 'ai/issue-' + number;
    for (let page = 1; page <= PULL_PAGES; page++) {
      const pulls = await this.forge.listPulls(repository, { state: 'open', limit: PULL_PAGE, page });
      const list = Array.isArray(pulls) ? pulls : [];
      if (list.some((pull) => pullBranch(pull) === branch)) return true;
      if (list.length < PULL_PAGE) return false;
    }
    return false;
  }

  // The findings of a ticket. Rule 4 is answered by the forge; a failed read is unknown, and that counts as no violation.
  async violationsOf(event: ForgeEvent): Promise<Violation[]> {
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const read = this.forge.fileExists?.bind(this.forge);
    const ref = event.repository.default_branch || undefined;
    const exists: Exists | undefined = read && (async (path) => {
      try { return await read(repository, path, ref); } catch (error) {
        this.logger.error(repository + '#' + number + ': could not read ' + path + ' for the pre-flight, not checked:', (error as Error).message);
        return null;
      }
    });
    return ticketViolations(event.issue.body, exists);
  }

  // The notes of the findings that do not reject the ticket, for the worker's prompt (startJob). Empty when the pre-flight is off.
  async notesOf(event: ForgeEvent): Promise<string[]> {
    if (!this.config.ticketPreflight) return [];
    return splitViolations(await this.violationsOf(event), this.config.ticketPreflightBlock).advisory.map((violation) => violation.note);
  }

  // Counts the advisory findings of a ticket, once per rule. They are counted when the ticket is checked, not when its run starts.
  countAdvised(advisory: Violation[]): void {
    for (const rule of new Set(advisory.map((violation) => violation.rule))) metrics.inc('forgehands_preflight_total', { result: 'advised', rule: String(rule) });
  }

  // True when the run this event asks for must not start because the ticket breaks a blocking rule (TICKET_PREFLIGHT_BLOCK). A passing ticket,
  // a ticket with advisory findings only, or TICKET_PREFLIGHT=0: false. A rejected ticket is commented once per revision; every time it is
  // rejected, its trigger label goes and the planner (SPLIT_LABEL) or the human (BLOCKED_LABEL) gets it. In a dry run the once-per-revision
  // mark is not kept, as nothing was written.
  async rejects(event: ForgeEvent, label: string): Promise<boolean> {
    if (!this.config.ticketPreflight) return false;
    const repository = event.repository.full_name;
    const number = event.issue.number;
    const found = await this.violationsOf(event);
    if (!found.length) {
      metrics.inc('forgehands_preflight_total', { result: 'ok', rule: 'none' });
      return false;
    }
    const { blocking: violations, advisory } = splitViolations(found, this.config.ticketPreflightBlock);
    // Advisory findings alone never reject, and need no look at the open pull requests.
    if (!violations.length) {
      this.countAdvised(advisory);
      return false;
    }
    const why = await this.skipReason(repository, number);
    if (why) {
      metrics.inc('forgehands_preflight_total', { result: 'skipped', rule: 'none' });
      this.logger.error(repository + '#' + number + ': the pre-flight is skipped (' + why + '), the ticket is not checked');
      return false;
    }
    for (const rule of new Set(violations.map((violation) => violation.rule))) metrics.inc('forgehands_preflight_total', { result: 'rejected', rule: String(rule) });
    this.countAdvised(advisory);

    const dry = isDry(this.config, repository);
    const key = 'preflight:' + repository.toLowerCase() + '#' + number + ':' + ticketRevision(event.issue.title, event.issue.body);
    const fresh = !this.jobs.noted(key);
    const now = this.now();
    const split = this.config.splitLabel;
    this.logger.error(repository + '#' + number + ': the ticket breaks the pre-flight (' + violations.map((v) => 'rule ' + v.rule).join(', ') + '), no worker starts');

    if (fresh) {
      const shown = violations.slice(0, LIST_LIMIT).map((v) => '- rule ' + v.rule + ': ' + v.text);
      if (violations.length > LIST_LIMIT) shown.push('- and ' + (violations.length - LIST_LIMIT) + ' more');
      const rules = shown.join('\n');
      const next = split ? 'It goes back to the planner (' + split + ') to be written again.' : 'A human has to fix the ticket and set its label again.';
      try {
        await this.forge.addComment(repository, number, (split ? '' : mentionOf(this.config)) + PREFLIGHT_REJECTION + ', so no worker starts on it:\n'
          + rules + '\n' + next + ' This comment is written once per revision of the ticket.', 'issue');
        if (!dry) this.jobs.note(key, now);
      } catch (error) {
        this.logger.error(repository + '#' + number + ': could not comment the pre-flight:', (error as Error).message);
      }
    }

    try {
      const labels = await this.forge.labelsOf(repository, number, 'issue');
      const trigger = (labels || []).find((entry) => entry.name === label);
      if (trigger) await this.forge.removeLabel(repository, number, trigger, 'issue');
      const target = split
        ? await this.forge.findOrCreateLabel(repository, split, '#5319e7')
        : await this.forge.findOrCreateLabel(repository, this.config.blockedLabel, '#b60205');
      await this.forge.addLabels(repository, number, [target], 'issue');
    } catch (error) {
      this.logger.error(repository + '#' + number + ': could not route the ticket after the pre-flight:', (error as Error).message);
    }

    if (fresh && !split) this.tell('blocked', event, { why: 'ticket_preflight' });
    if (fresh && !dry) await this.jobs.persist(now).catch((error) => this.logger.error('persist failed:', error.message));
    return true;
  }
}
