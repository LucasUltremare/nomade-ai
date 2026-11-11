import { loadConfig } from './config.ts';
import { PtyManager } from './pty-manager.ts';
import { HandoffLog } from './handoffs.ts';
import { createAdapters } from './adapters.ts';
import { buildApp } from './app.ts';
import { Nomade } from './nomade.ts';

const config = loadConfig();
const ptys = new PtyManager({ scrollbackBytes: config.scrollbackBytes });
const adapters = createAdapters(ptys);
const handoffs = new HandoffLog();
const nomade = new Nomade();
const app = await buildApp({ config, adapters, ptys, handoffs, nomade });

await app.listen({ host: config.host, port: config.port });

const webUrl = config.devWebUrl ?? `http://${config.host}:${config.port}`;
app.log.info(`Nomade Agents pronto. Abra: ${webUrl}/?token=${config.token}`);
nomade
  .warm()
  .then(() => app.log.info('Nomade aquecido e pronto para decidir.'))
  .catch((err: unknown) => app.log.warn(`Nomade não aqueceu (Ollama fora do ar?): ${err instanceof Error ? err.message : String(err)}`));
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
