import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  // Separador do SO (":" no POSIX, ";" no Windows), para não quebrar "C:\...".
  const roots = (env['RELAY_ROOTS'] ?? homedir())
    .split(delimiter)
    .filter(Boolean)
    .map((p) => resolve(p));
  // Flags em vez de "VAR=x cmd" nos scripts, que não funciona no Windows.
  if (argv.includes('--dev') && !env['RELAY_DEV_WEB_URL']) env = { ...env, RELAY_DEV_WEB_URL: 'http://127.0.0.1:5173' };
  if (argv.includes('--prod') && !env['RELAY_STATIC_DIR']) {
    env = { ...env, RELAY_STATIC_DIR: fileURLToPath(new URL('../../web/dist', import.meta.url)) };
  }
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
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
