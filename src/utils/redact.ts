// Text that a comment quotes from a run (a revert's pull request body, a log): the configured secret values, `password=...`-style pairs and
// long tokens are replaced. A commit id (40 or 64 hex digits) is not a token and stays.
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  return out
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[:=]\s*|\s+bearer\s+)\S+/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, (token) => (/^[0-9a-f]{40,64}$/i.test(token) ? token : '[redacted]'));
}
