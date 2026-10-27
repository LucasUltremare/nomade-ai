import { loadConfig } from './config.ts';
import { PtyManager } from './pty-manager.ts';
import { HandoffLog } from './handoffs.ts';
import { createAdapters } from './adapters.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const ptys = new PtyManager({ scrollbackBytes: config.scrollbackBytes });
const adapters = createAdapters(ptys);
const handoffs = new HandoffLog();
const app = await buildApp({ config, adapters, ptys, handoffs });

await app.listen({ host: config.host, port: config.port });

const webUrl = config.devWebUrl ?? `http://${config.host}:${config.port}`;
app.log.info(`Relay pronto. Abra: ${webUrl}/?token=${config.token}`);
if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
  app.log.warn(`ATENÇÃO: escutando em ${config.host}, não só em loopback.`);
}

const shutdown = async () => {
  app.log.info('encerrando: matando PTYs...');
  ptys.killAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
