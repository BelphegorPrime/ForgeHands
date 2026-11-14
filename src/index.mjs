import { loadConfig } from './config.mjs';
import { DeliveryStore } from './store.mjs';
import { JobStore } from './jobs.mjs';
import { Dispatcher } from './dispatch.mjs';
import { createApp } from './app.mjs';

const config = loadConfig();
const store = new DeliveryStore(config.dataFile);
await store.load();
let dispatcher = null;
if (config.mode === 'direct') {
  const jobs = new JobStore(config.jobsFile);
  await jobs.load();
  dispatcher = new Dispatcher(config, jobs);
  dispatcher.start();
}
const server = createApp(config, store, fetch, console, dispatcher);

server.listen(config.port, config.host, () => {
  console.log('ForgeHands (' + config.mode + ' mode) listening on ' + config.host + ':' + config.port);
});
const shutdown = () => { dispatcher?.stop(); server.close(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
