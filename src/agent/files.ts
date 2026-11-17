import { globToRegExp } from '../forge/glob.ts';

// The files a ticket declares: bullet lines under a heading "Exact files" of its body, each starting with the path in backticks
// (``- `src/a.ts` (new)``). Anything after the closing backtick, such as a note in parentheses, is ignored. No section, no files.
export function parseDeclaredFiles(body: unknown): string[] {
  const files: string[] = [];
  let inside = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) { inside = /^\s{0,3}#{1,6}\s*exact files\s*:?\s*$/i.test(line); continue; }
    if (!inside) continue;
    const match = /^\s*[-*+]\s+`([^`]+)`/.exec(line);
    if (match) files.push(match[1].trim().replace(/^\.?\//, ''));
  }
  return files;
}

const hasWildcard = (path: string): boolean => /[*?]/.test(path);
const literalPrefix = (path: string): string => path.slice(0, path.search(/[*?]/));

// Do two declared paths name a common file? Equal paths do; a pattern also matches a path it covers (`dir/**` covers everything below
// `dir`); two patterns overlap when one matches the literal start of the other.
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [wa, wb] = [hasWildcard(a), hasWildcard(b)];
  if (!wa && !wb) return false;
  if (wa && !wb) return globToRegExp(a).test(b);
  if (wb && !wa) return globToRegExp(b).test(a);
  return globToRegExp(a).test(literalPrefix(b)) || globToRegExp(b).test(literalPrefix(a));
}

export function anyOverlap(mine: string[], others: string[]): boolean {
  return mine.some((one) => others.some((other) => pathsOverlap(one, other)));
}
