import type { ReleaseArtifact, ReleaseFieldContext } from './types.ts';

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

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
}

export function parseReleaseArtifact(value: unknown, ctx: ReleaseFieldContext): ReleaseArtifact | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(ctx, 'must be an object');
  const input = value as Record<string, unknown>;

  if (input.kind === 'container') {
    const image = input.image;
    if (typeof image !== 'string' || image.trim() === '') {
      fail({ ...ctx, field: ctx.field + '.image' }, 'must be a non-empty string');
    }
    if (input.tag_forms !== undefined) {
      const tagCtx: ReleaseFieldContext = { ...ctx, field: ctx.field + '.tag_forms' };
      if (!Array.isArray(input.tag_forms)) fail(tagCtx, 'must be an array of non-empty strings');
      for (const form of input.tag_forms) {
        if (typeof form !== 'string' || form.trim() === '') fail(tagCtx, 'must be an array of non-empty strings');
      }
      return { kind: 'container', image, tagForms: input.tag_forms as string[] };
    }
    return { kind: 'container', image };
  }

  if (input.kind === 'npm') {
    const packageName = input.package;
    if (typeof packageName !== 'string' || packageName.trim() === '') {
      fail({ ...ctx, field: ctx.field + '.package' }, 'must be a non-empty string');
    }
    const registry = input.registry;
    const registryCtx: ReleaseFieldContext = { ...ctx, field: ctx.field + '.registry' };
    if (typeof registry !== 'string' || !isHttpUrl(registry)) {
      fail(registryCtx, 'must be an http(s) URL without credentials');
    }
    return { kind: 'npm', package: packageName, registry };
  }

  fail({ ...ctx, field: ctx.field + '.kind' }, 'must be "container" or "npm"');
}
