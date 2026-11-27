import type { ReleaseFieldContext } from './types.ts';

function fail(ctx: ReleaseFieldContext, text: string): never {
  throw new Error(ctx.source + '[' + ctx.repository + '].' + ctx.field + ': ' + text);
}

export function parseReleaseFile(value: unknown, ctx: ReleaseFieldContext): string {
  if (typeof value !== 'string') fail(ctx, 'must be a safe relative file path');
  if (value.trim() === '') fail(ctx, 'must be a safe relative file path');
  if (value.startsWith('/')) fail(ctx, 'must be a safe relative file path');
  if (value.startsWith('\\')) fail(ctx, 'must be a safe relative file path');
  if (/^[A-Za-z]:/.test(value)) fail(ctx, 'must be a safe relative file path');
  if (value.split(/[\\/]/).some((segment) => segment === '..')) fail(ctx, 'must be a safe relative file path');
  return value;
}
