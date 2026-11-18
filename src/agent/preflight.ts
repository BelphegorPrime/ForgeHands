import { createHash } from 'node:crypto';
import { isDry } from '../dry.ts';
import { mentionOf } from '../notify/index.ts';
import type { Facts } from '../notify/texts.ts';
import type { JobStore } from '../store/jobs.ts';
import type { Forge } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent, Logger } from '../types.ts';

// The ticket pre-flight (TICKET_PREFLIGHT, on by default): a broken worker ticket starts no run. The rules are checks of the ticket's text and
// one read of the repository. The comment names the rule; the README says what each one means.
//   1. every path named in Steps is listed in Files;
//   2. Acceptance has a fenced block that holds a command;
//   3. that command is not a placeholder and its quotes close (a static check: running it on the default branch needs a checkout, which
//      ForgeHands does not have, so it is not done here);
//   4. every path listed in Files exists on the default branch, unless its line says "new".
// Headings are read: Steps, Files (or "Exact files", the heading of WAIT_FOR_SAME_FILES) and Acceptance. A forge that cannot read files
// makes rule 4 unknown, and unknown counts as no violation.

export interface Violation { rule: 1 | 2 | 3 | 4; text: string }

/** Whether a path exists on the default branch: true, false, or null when the forge cannot say. */
export type Exists = (path: string) => Promise<boolean | null>;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
// A path: optional ./, slash-separated names, an extension that starts with a letter (so `1.5` or `v0.9.7` are no paths). Globs (`*`)
// and folders do not match, so they are not checked.
const PATH = /^(?:\.\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[A-Za-z][A-Za-z0-9]*$/;
const PLACEHOLDER = /^(?:\.\.\.|…|<[^>]*>|todo|tbd|command|your command here)$/i;

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
    for (const path of pathsIn(steps.lines.join('\n'))) {
      if (!files.has(path)) violations.push({ rule: 1, text: '`' + path + '` is named in Steps but not listed in Files' });
    }
  }

  if (!acceptance.found) violations.push({ rule: 2, text: 'the ticket has no Acceptance section with a fenced command block' });
  else {
    const blocks = fencedBlocks(acceptance.lines).filter((block) => block.trim());
    if (!blocks.length) violations.push({ rule: 2, text: 'the Acceptance section has no fenced command block' });
    for (const block of blocks) {
      const problem = commandProblem(block);
      if (problem) { violations.push({ rule: 3, text: 'the acceptance command ' + problem }); break; }
    }
  }

  if (exists) {
    for (const [path, isNew] of files) {
      if (isNew) continue;
      if ((await exists(path)) === false) {
        violations.push({ rule: 4, text: '`' + path + '` is listed in Files but does not exist on the default branch (mark it new if the ticket creates it)' });
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

  // True when the run this event asks for must not start because the ticket breaks a rule. A passing ticket, or TICKET_PREFLIGHT=0: false.
  // A rejected ticket is commented once per revision; every time it is rejected, its trigger label goes and the planner (SPLIT_LABEL) or the
  // human (BLOCKED_LABEL) gets it. In a dry run the once-per-revision mark is not kept, as nothing was written.
  async rejects(event: ForgeEvent, label: string): Promise<boolean> {
    if (!this.config.ticketPreflight) return false;
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
    const violations = await ticketViolations(event.issue.body, exists);
    if (!violations.length) return false;

    const dry = isDry(this.config, repository);
    const key = 'preflight:' + repository.toLowerCase() + '#' + number + ':' + ticketRevision(event.issue.title, event.issue.body);
    const fresh = !this.jobs.noted(key);
    const now = this.now();
    const split = this.config.splitLabel;
    this.logger.error(repository + '#' + number + ': the ticket breaks the pre-flight (' + violations.map((v) => 'rule ' + v.rule).join(', ') + '), no worker starts');

    if (fresh) {
      const rules = violations.map((v) => '- rule ' + v.rule + ': ' + v.text).join('\n');
      const next = split ? 'It goes back to the planner (' + split + ') to be written again.' : 'A human has to fix the ticket and set its label again.';
      try {
        await this.forge.addComment(repository, number, (split ? '' : mentionOf(this.config)) + 'ForgeHands: the ticket breaks the pre-flight, so no worker starts on it:\n'
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
