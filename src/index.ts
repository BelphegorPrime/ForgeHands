import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { DeliveryStore } from './store/deliveries.ts';
import { JobStore } from './store/jobs.ts';
import { Dispatcher } from './agent/dispatch.ts';
import { notifyChannels } from './notify/config.ts';
import { createApp } from './server/app.ts';
import { createForge, createTransport } from './forge/index.ts';
import { E2eController } from './e2e/controller.ts';

// The version of this ForgeHands (package.json): the end-to-end suite runs once per version when E2E_ON_START=1.
const version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

const config = loadConfig();
if (config.dryRun) console.error('WARNING: DRY RUN. Events are judged as usual, but nothing is written to Forgejo or OpenHands ('
  + (config.dryRunRepos.size ? 'only for ' + [...config.dryRunRepos].join(', ') : 'all repositories') + ').');
const store = new DeliveryStore(config.dataFile);
await store.load();
let dispatcher = null;
let e2e: E2eController | null = null;
if (config.mode === 'direct') {
  const jobs = new JobStore(config.jobsFile);
  await jobs.load();
  if (!config.statusToken) console.error('warning: STATUS_TOKEN is not set, /status and /status.json are open to everybody who can reach this port');
  const channels = notifyChannels(config.notify);
  console.log('notifications: ' + (channels.length ? channels.join(', ') + '; immediate: ' + (config.notify.immediate.join(', ') || 'none') + '; digest: ' + (config.notify.digest ? config.notify.digest + ' ' + config.notify.timezone : 'off') : 'no channel configured'));
  console.log(config.workspaceCleanupDir
    ? 'workspace cleanup: ' + config.workspaceCleanupDir + (config.workspaceCleanupDry || config.dryRun ? ' (dry run, nothing is deleted)' : '') + ', keep ' + config.workspaceKeepHours + ' h (failed ' + config.workspaceKeepFailedHours + ' h), orphans after ' + config.workspaceOrphanHours + ' h; disk warning ' + (config.diskWarnPercent || 'off') + ' %, hold below ' + (config.diskMinFreeGb || 'off') + ' GB'
    : 'workspace cleanup: off (WORKSPACE_CLEANUP_DIR is not set)');
  dispatcher = new Dispatcher(config, jobs);
  dispatcher.start().catch((error) => console.error('dispatcher start failed:', error.message));
  // The end-to-end suite (E2E_REPO): off unless a test repository is named. It drives the test repository through the same forge client.
  if (config.e2e.repository) e2e = new E2eController({ config, forge: createForge(config, createTransport(config, fetch)), jobs, notifier: dispatcher.notifier, version, logger: console });
}
const server = createApp(config, store, fetch, console, dispatcher, e2e);

server.listen(config.port, config.host, () => {
  console.log('ForgeHands (' + config.mode + ' mode) listening on ' + config.host + ':' + config.port);
  // E2E_ON_START=1 runs the suite once after a start whose version the ledger has no e2e run for (the run is in the background).
  if (config.mode === 'direct' && config.e2e.onStart) e2e?.onStart();
});
const shutdown = () => { dispatcher?.stop(); server.close(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
