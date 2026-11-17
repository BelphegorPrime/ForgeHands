import { globToRegExp } from './glob.ts';

const hasWildcard = (path: string): boolean => /[*?]/.test(path);
const literalPrefix = (path: string): string => path.slice(0, path.search(/[*?]/));
const matchesPath = (pattern: string, path: string): boolean => globToRegExp(pattern).test(path);

function patternsOverlap(a: string, b: string): boolean {
  return matchesPath(a, literalPrefix(b)) || matchesPath(b, literalPrefix(a));
}

// Paths overlap when they are equal or a glob covers the other path or pattern.
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aHasWildcard = hasWildcard(a);
  const bHasWildcard = hasWildcard(b);
  if (!aHasWildcard && !bHasWildcard) return false;
  if (aHasWildcard && bHasWildcard) return patternsOverlap(a, b);
  return aHasWildcard ? matchesPath(a, b) : matchesPath(b, a);
}

export function anyOverlap(mine: string[], others: string[]): boolean {
  return mine.some((one) => others.some((other) => pathsOverlap(one, other)));
}
