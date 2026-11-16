import { DryLog } from '../dry.ts';
import { ForgejoForge, forgejoAgentApi, forgejoTransport } from './forgejo.ts';
import type { Config, Fetch, ForgejoAccess } from '../types.ts';
import type { AgentApi, Forge, ForgeKind, Transport } from './types.ts';

export type { Forge, ForgeKind, Transport } from './types.ts';

export const FORGES: readonly ForgeKind[] = ['forgejo'];

// The one place that knows which implementation belongs to FORGE. Everything else talks to the `Forge` interface.
type ForgeConfig = Pick<Config, 'forge' | 'timeoutMs' | 'dryRun' | 'dryRunRepos'> & { forgejo?: ForgejoAccess | null };

// The lowest layer: one HTTP call with the forge's credentials. DRY_RUN stops writes here and API errors are counted here.
export function createTransport(config: ForgeConfig, send: Fetch, dry: DryLog = new DryLog()): Transport {
  return forgejoTransport(config, send, dry);
}

// A forge over a transport. The owner (Dispatcher, Merger, Reminder) passes its own, so a test can replace the wire and keep the paths.
export function createForge(config: Pick<Config, 'forge'>, call: Transport): Forge {
  return new ForgejoForge(call);
}

// The paths an agent calls itself, for the prompts: they need no connection, only the kind of forge.
export function agentApi(config: Pick<Config, 'forge'>, repository: string): AgentApi {
  return forgejoAgentApi(repository);
}
