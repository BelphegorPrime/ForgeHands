import { loadConfig } from './config.mjs';
import { DeliveryStore } from './store.mjs';
import { createApp } from './app.mjs';

const config = loadConfig();
const store = new DeliveryStore(config.dataFile);
await store.load();
const server = createApp(config, store);

server.listen(config.port, config.host, () => {
  console.log('ForgeHands listening on ' + config.host + ':' + config.port);
});
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
