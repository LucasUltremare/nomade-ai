import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Adapter, DetectResult, ProviderId } from '@relay/core';
import { PROVIDER_IDS } from '@relay/core';
import type { ServerConfig } from './config.ts';
import { isInside } from './config.ts';
import type { PtyManager } from './pty-manager.ts';
import type { HandoffLog } from './handoffs.ts';

export interface AppDeps {
  config: ServerConfig;
  adapters: Record<ProviderId, Adapter>;
  ptys: PtyManager;
  handoffs: HandoffLog;
}

const createSessionSchema = z.object({
  provider: z.enum([...PROVIDER_IDS, 'shell']),
  cwd: z.string().min(1),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(2).max(1000).optional(),
  label: z.string().max(80).optional(),
});

const handoffSchema = z.object({
  from: z.string().uuid().optional(),
  to: z.string().uuid(),
  text: z.string().min(1).max(512 * 1024),
  submit: z.boolean().default(false),
  source: z.enum(['selection', 'last-output', 'manual']).default('manual'),
});

const wsClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), d: z.string() }),
  z.object({ t: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
]);

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, adapters, ptys, handoffs } = deps;
  const app = Fastify({ logger: process.env['VITEST'] ? false : { level: process.env['RELAY_LOG'] ?? 'info' } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // Token obrigatório em tudo que não é o front estático.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/ws/')) return;
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const query = (req.query as Record<string, unknown>)['token'];
    if (!tokenMatches(config.token, bearer ?? query)) {
      await reply.code(401).send({ error: 'token inválido' });
    }
  });

  const detectCache = new Map<ProviderId, { at: number; result: DetectResult }>();

  app.get('/api/health', async () => ({ ok: true, name: 'relay' }));

  app.get('/api/config', async () => ({
    roots: config.roots,
    defaultCwd: config.defaultCwd,
    providers: PROVIDER_IDS,
  }));

  app.get<{ Querystring: { refresh?: string } }>('/api/providers', async (req) => {
    const refresh = req.query.refresh === '1';
    const results = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const cached = detectCache.get(id);
        if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.result;
        const result = await adapters[id].detect().catch(
          (err: unknown): DetectResult => ({
            id,
            name: adapters[id].name,
            installed: false,
            login: 'unknown',
            installHint: '',
            loginHint: '',
            notes: `detect() falhou: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        detectCache.set(id, { at: Date.now(), result });
        return result;
      }),
    );
    return results;
  });

  app.get('/api/sessions', async () => ptys.list());

  app.post('/api/sessions', async (req, reply) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { provider, cols, rows, label } = parsed.data;
    const cwd = resolve(parsed.data.cwd);
    if (!config.roots.some((r) => isInside(cwd, r))) {
      return reply.code(400).send({ error: `cwd fora dos diretórios permitidos (${config.roots.join(', ')})` });
    }
    try {
      const s = await stat(cwd);
      if (!s.isDirectory()) throw new Error('não é diretório');
    } catch {
      return reply.code(400).send({ error: `cwd inválido: ${cwd}` });
    }
    const spawnOptions = {
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    let id: string;
    if (provider === 'shell') {
      const shell = process.env['SHELL'] ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
      id = await ptys.spawn({ file: shell, args: ['-l'], cwd }, { ...spawnOptions, provider: 'shell', label: label ?? 'shell' });
    } else {
      id = await adapters[provider].spawnInteractive(cwd, { ...spawnOptions, label: label ?? adapters[provider].name });
    }
    return reply.code(201).send(ptys.get(id));
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const s = ptys.get(req.params.id);
    return s ?? reply.code(404).send({ error: 'sessão não encontrada' });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/last-output', async (req, reply) => {
    if (!ptys.get(req.params.id)) return reply.code(404).send({ error: 'sessão não encontrada' });
    return { text: ptys.lastOutput(req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const ok = ptys.kill(req.params.id);
    return ok ? { ok } : reply.code(404).send({ error: 'sessão não encontrada' });
  });

  app.get('/api/handoffs', async () => handoffs.list());

  app.post('/api/handoffs', async (req, reply) => {
    const parsed = handoffSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { from, to, text, submit, source } = parsed.data;
    if (!ptys.get(to)) return reply.code(404).send({ error: 'destino não encontrado' });
    try {
      ptys.paste(to, text, submit);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const entry = handoffs.add({ ...(from ? { from } : {}), to, text, submitted: submit, source });
    return reply.code(201).send(entry);
  });

  // WebSocket por terminal: client → {t:'in',d} | {t:'resize',cols,rows}; server → {t:'out',d} | {t:'exit',code}
  app.get<{ Params: { id: string } }>('/ws/terminal/:id', { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const info = ptys.get(id);
    if (!info) {
      socket.close(4404, 'sessão não encontrada');
      return;
    }
    socket.send(JSON.stringify({ t: 'out', d: ptys.scrollback(id) }));
    if (!info.alive) socket.send(JSON.stringify({ t: 'exit', code: info.exitCode ?? -1 }));

    const onData = (sid: string, d: string) => {
      if (sid === id && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'out', d }));
    };
    const onExit = (sid: string, code: number) => {
      if (sid === id && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'exit', code }));
    };
    const onRemoved = (sid: string) => {
      if (sid === id) socket.close(4410, 'sessão removida');
    };
    ptys.on('data', onData);
    ptys.on('exit', onExit);
    ptys.on('removed', onRemoved);

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = wsClientMessage.safeParse(msg);
      if (!parsed.success) return;
      if (parsed.data.t === 'in') ptys.write(id, parsed.data.d);
      else ptys.resize(id, parsed.data.cols, parsed.data.rows);
    });
    socket.on('close', () => {
      ptys.off('data', onData);
      ptys.off('exit', onExit);
      ptys.off('removed', onRemoved);
    });
  });

  if (config.staticDir) {
    await app.register(fastifyStatic, { root: config.staticDir, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
