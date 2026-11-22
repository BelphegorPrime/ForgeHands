import type { DirectConfig } from '../types.ts';

// The one place where status.json builds forge web addresses: an issue or a pull request of a repository, on the forge the config names
// (GitLab keeps issues under /-/issues and merge requests under /-/merge_requests, Forgejo and Gitea use /issues and /pulls). The dashboard
// links to these addresses and never builds them itself. Null without a forge (FORGE_URL and FORGE_TOKEN unset).
export function forgeItemUrl(config: DirectConfig, repository: string, type: 'issue' | 'pr', number: number): string | null {
  if (!config.forgejo || !repository || !Number.isInteger(number) || number <= 0) return null;
  const path = repository.split('/').map(encodeURIComponent).join('/');
  const suffix = config.forge === 'gitlab'
    ? type === 'issue' ? '/-/issues/' : '/-/merge_requests/'
    : type === 'issue' ? '/issues/' : '/pulls/';
  return config.forgejo.url.replace(/\/$/, '') + '/' + path + suffix + number;
}

// The '#n' numbers a free text names (a state line, a note, a reason): each number of the repository, mapped to its issue address.
// Only numbers that have an address are listed; the dashboard links the ones it finds here and shows the rest as plain text.
export function issueLinksIn(config: DirectConfig, repository: string, text: string | null | undefined): Record<string, string> {
  const links: Record<string, string> = {};
  for (const match of String(text ?? '').matchAll(/#(\d+)\b/g)) {
    const number = match[1] as string;
    if (links[number]) continue;
    const url = forgeItemUrl(config, repository, 'issue', Number(number));
    if (url) links[number] = url;
  }
  return links;
}
