import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  /** Diretórios dentro dos quais um nó pode rodar (padrão: home do usuário). */
  roots: string[];
  defaultCwd: string;
  /** Pasta com o build do front para servir em produção (opcional). */
  staticDir?: string;
  /** Em dev, URL do Vite para imprimir o link já com token. */
  devWebUrl?: string;
  scrollbackBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const roots = (env['RELAY_ROOTS'] ?? homedir())
    .split(':')
    .filter(Boolean)
    .map((p) => resolve(p));
  const defaultCwd = resolve(env['RELAY_DEFAULT_CWD'] ?? process.cwd());
  return {
    host: env['RELAY_HOST'] ?? '127.0.0.1',
    port: Number(env['RELAY_PORT'] ?? 7357),
    token: env['RELAY_TOKEN'] ?? randomBytes(24).toString('base64url'),
    roots,
    defaultCwd: roots.some((r) => isInside(defaultCwd, r)) ? defaultCwd : (roots[0] ?? homedir()),
    ...(env['RELAY_STATIC_DIR'] ? { staticDir: resolve(env['RELAY_STATIC_DIR']) } : {}),
    ...(env['RELAY_DEV_WEB_URL'] ? { devWebUrl: env['RELAY_DEV_WEB_URL'] } : {}),
    scrollbackBytes: Number(env['RELAY_SCROLLBACK_BYTES'] ?? 256 * 1024),
  };
}

export function isInside(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}
