import { normalizeGiteaEvent } from '../webhook/gitea.ts';
import { verifyForgejoSignature } from '../webhook/security.ts';
import { ForgejoForge, forgejoAgentApi } from './forgejo.ts';
import type { AgentApi, Forge } from './types.ts';

// The API paths an agent calls itself: Gitea's v1 API is the one Forgejo has, and the agent's secrets keep the names FORGEJO_URL and
// FORGEJO_TOKEN (the neutral FORGE_* names reach it under those). Gitea's workflows live in .gitea/workflows.
export function giteaAgentApi(repository: string): AgentApi {
  return { ...forgejoAgentApi(repository), name: 'Gitea', workflows: '.gitea/workflows or .github/workflows' };
}

// Gitea is a variant of Forgejo: the same REST paths, merge, rebase update, combined status, compare, files, dependencies and WIP
// prefixes (checked against the Gitea source, see the README). What differs is the webhook: its headers and signature name, and the CI
// event (`workflow_run`). The dry run gate and the metrics are in the transport below, shared with Forgejo.
export class GiteaForge extends ForgejoForge {
  override readonly kind = 'gitea' as const;
  override readonly webhookPath = '/webhooks/gitea';

  override agent(repository: string): AgentApi { return giteaAgentApi(repository); }
  // X-Gitea-Signature is the hex HMAC-SHA256 of the body, without a prefix: the same check as Forgejo's header.
  override verifyWebhook(secret: string, raw: Buffer, headers: Parameters<Forge['verifyWebhook']>[2]): boolean {
    return verifyForgejoSignature(secret, raw, headers['x-gitea-signature']);
  }
  override eventName(headers: Parameters<Forge['eventName']>[0]): unknown { return headers['x-gitea-event']; }
  override normalizeEvent(...args: Parameters<Forge['normalizeEvent']>): ReturnType<Forge['normalizeEvent']> { return normalizeGiteaEvent(...args); }
}
