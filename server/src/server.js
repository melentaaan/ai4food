import { config } from './config.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/scheduler.js';

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`AI4Food API on http://${config.host}:${config.port} (${config.env})`);
});

const stopScheduler = startScheduler();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
