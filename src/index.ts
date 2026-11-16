import { loadConfig } from './config.ts';
import { DeliveryStore } from './store/deliveries.ts';
import { JobStore } from './store/jobs.ts';
import { Dispatcher } from './agent/dispatch.ts';
import { createApp } from './server/app.ts';

const config = loadConfig();
if (config.dryRun) console.error('WARNING: DRY RUN. Events are judged as usual, but nothing is written to Forgejo or OpenHands ('
  + (config.dryRunRepos.size ? 'only for ' + [...config.dryRunRepos].join(', ') : 'all repositories') + ').');
const store = new DeliveryStore(config.dataFile);
await store.load();
let dispatcher = null;
if (config.mode === 'direct') {
  const jobs = new JobStore(config.jobsFile);
  await jobs.load();
  if (!config.statusToken) console.error('warning: STATUS_TOKEN is not set, /status and /status.json are open to everybody who can reach this port');
  dispatcher = new Dispatcher(config, jobs);
  dispatcher.start().catch((error) => console.error('dispatcher start failed:', error.message));
}
const server = createApp(config, store, fetch, console, dispatcher);

server.listen(config.port, config.host, () => {
  console.log('ForgeHands (' + config.mode + ' mode) listening on ' + config.host + ':' + config.port);
});
const shutdown = () => { dispatcher?.stop(); server.close(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
