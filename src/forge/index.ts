import { DryLog } from '../dry.ts';
import { GiteaForge, giteaAgentApi } from './gitea.ts';
import { ForgejoForge, forgejoAgentApi, forgejoTransport } from './forgejo.ts';
import { GitlabForge, gitlabAgentApi, gitlabTransport } from './gitlab.ts';
import type { Config, Fetch, ForgejoAccess } from '../types.ts';
import type { AgentApi, Forge, ForgeKind, Transport } from './types.ts';

export type { Forge, ForgeKind, Transport } from './types.ts';

export const FORGES: readonly ForgeKind[] = ['forgejo', 'gitea', 'gitlab'];

// The one place that knows which implementation belongs to FORGE. Everything else talks to the `Forge` interface.
type ForgeConfig = Pick<Config, 'forge' | 'timeoutMs' | 'dryRun' | 'dryRunRepos'> & { forgejo?: ForgejoAccess | null };

// The lowest layer: one HTTP call with the forge's credentials. DRY_RUN stops writes here and API errors are counted here.
export function createTransport(config: ForgeConfig, send: Fetch, dry: DryLog = new DryLog()): Transport {
  return config.forge === 'gitlab' ? gitlabTransport(config, send, dry) : forgejoTransport(config, send, dry);
}

// A forge over a transport. The owner (Dispatcher, Merger, Reminder) passes its own, so a test can replace the wire and keep the paths.
export function createForge(config: Pick<Config, 'forge'>, call: Transport): Forge {
  return config.forge === 'gitlab' ? new GitlabForge(call) : config.forge === 'gitea' ? new GiteaForge(call) : new ForgejoForge(call);
}

// The paths an agent calls itself, for the prompts: they need no connection, only the kind of forge.
export function agentApi(config: Pick<Config, 'forge'>, repository: string): AgentApi {
  return config.forge === 'gitlab' ? gitlabAgentApi(repository) : config.forge === 'gitea' ? giteaAgentApi(repository) : forgejoAgentApi(repository);
}
