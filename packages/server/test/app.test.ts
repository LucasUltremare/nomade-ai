import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Adapter, DetectResult, ProviderId } from '@relay/core';
import { PROVIDER_IDS, PROVIDER_NAMES, PROVIDER_COLORS } from '@relay/core';
import { buildApp } from '../src/app.ts';
import { PtyManager } from '../src/pty-manager.ts';
import { HandoffLog } from '../src/handoffs.ts';
import type { ServerConfig } from '../src/config.ts';

function fakeAdapter(id: ProviderId, host: PtyManager): Adapter {
  return {
    id,
    name: PROVIDER_NAMES[id],
    color: PROVIDER_COLORS[id],
    detect: async (): Promise<DetectResult> => ({
      id,
      name: PROVIDER_NAMES[id],
      installed: id === 'claude-code',
      login: id === 'claude-code' ? 'logged-in' : 'unknown',
      installHint: 'x',
      loginHint: 'y',
    }),
    interactiveCommand: (cwd) => ({ file: 'cat', args: [], cwd }),
    spawnInteractive: (cwd, o) => host.spawn({ file: 'cat', args: [], cwd }, { ...o, provider: id }),
    runHeadless: async () => ({ text: '', durationMs: 0, exitCode: 0 }),
    limits: async () => 'unknown',
  };
}

describe('server app', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ptys: PtyManager;
  let root: string;
  const token = 'test-token';

  beforeAll(async () => {
    root = await mkdtemp(`${tmpdir()}/relay-test-`);
    const config: ServerConfig = { host: '127.0.0.1', port: 0, token, roots: [root], defaultCwd: root, scrollbackBytes: 4096 };
    ptys = new PtyManager({ scrollbackBytes: 4096 });
    const adapters = Object.fromEntries(PROVIDER_IDS.map((id) => [id, fakeAdapter(id, ptys)])) as Record<ProviderId, Adapter>;
    app = await buildApp({ config, adapters, ptys, handoffs: new HandoffLog() });
  });

  afterAll(async () => {
    ptys.killAll();
    await app.close();
  });

  it('rejects requests without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(401);
  });

  it('lists providers with token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DetectResult[];
    expect(body.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    expect(body[0]?.login).toBe('logged-in');
  });

  it('refuses cwd outside roots', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'shell', cwd: '/' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a session, pastes a handoff and reads last output', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'claude-code', cwd: root },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; alive: boolean; provider: string };
    expect(session.provider).toBe('claude-code');
    expect(session.alive).toBe(true);

    const handoff = await app.inject({
      method: 'POST',
      url: '/api/handoffs',
      headers: { authorization: `Bearer ${token}` },
      payload: { to: session.id, text: 'hello from relay', submit: true, source: 'manual' },
    });
    expect(handoff.statusCode).toBe(201);

    // `cat` ecoa o que recebe; espera a saída chegar.
    await new Promise((r) => setTimeout(r, 300));
    const out = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/last-output`, headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(200);
    expect((out.json() as { text: string }).text).toContain('hello from relay');

    const log = await app.inject({ method: 'GET', url: '/api/handoffs', headers: { authorization: `Bearer ${token}` } });
    expect((log.json() as unknown[]).length).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
  });
});
