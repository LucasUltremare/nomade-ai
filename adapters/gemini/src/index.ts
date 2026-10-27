import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, DetectResult, HeadlessRequest, HeadlessResult, Limits, PtyCommand, PtyHost, PtySpawnOptions } from '@relay/core';
import { PROVIDER_COLORS, PROVIDER_NAMES } from '@relay/core';
import { parseVersion, runProcess, which } from '@relay/adapter-shared';

/**
 * Adapter do Gemini CLI. Flags verificadas em `gemini --help` (v0.65.0):
 *   -p/--prompt <texto> (headless), -o/--output-format json, -m/--model, --resume <latest|índice>, --session-id <uuid>
 * Limitação: `--resume` aceita só "latest" ou índice numérico, não um id. Logo, retomar sessão
 * em modo headless por id NÃO é suportado: `runHeadless` devolve `resumed: false` e o chamador
 * deve incluir a saída do turno anterior no prompt (fallback).
 * Não há `gemini auth status`: a detecção de login só verifica se existe o arquivo de credenciais
 * (stat, sem ler o conteúdo) ou a env GEMINI_API_KEY.
 */

interface GeminiJson {
  response?: string;
  stats?: unknown;
  error?: { message?: string; type?: string };
}

export interface GeminiAdapterOptions {
  binary?: string;
  timeoutMs?: number;
  /** Diretório de config (padrão ~/.gemini); só usado para `stat`, nunca lido. */
  configDir?: string;
}

export function createGeminiAdapter(host: PtyHost, options: GeminiAdapterOptions = {}): Adapter {
  const binary = options.binary ?? 'gemini';
  const id = 'gemini' as const;
  const configDir = options.configDir ?? join(homedir(), '.gemini');
  const interactiveCommand = (cwd: string): PtyCommand => ({ file: binary, args: [], cwd });

  return {
    id,
    name: PROVIDER_NAMES[id],
    color: PROVIDER_COLORS[id],
    interactiveCommand,

    async detect(): Promise<DetectResult> {
      const base: DetectResult = {
        id,
        name: PROVIDER_NAMES[id],
        installed: false,
        login: 'unknown',
        installHint: 'npm install -g @google/gemini-cli',
        loginHint: 'gemini  (na primeira execução escolha "Login with Google")',
      };
      const binaryPath = await which(binary);
      if (!binaryPath) return base;
      base.installed = true;
      base.binaryPath = binaryPath;
      try {
        const v = await runProcess(binary, ['--version'], { timeoutMs: 20000 });
        const version = parseVersion(v.stdout);
        if (version) base.version = version;
      } catch {
        /* opcional */
      }
      if (process.env['GEMINI_API_KEY']) {
        base.login = 'logged-in';
        base.plan = 'API key (env)';
      } else {
        try {
          await access(join(configDir, 'oauth_creds.json'));
          base.login = 'logged-in';
          base.plan = 'Google (OAuth)';
          base.notes = 'Detectado pela existência de ~/.gemini/oauth_creds.json (arquivo não é lido).';
        } catch {
          base.login = 'logged-out';
          base.notes = 'Sem ~/.gemini/oauth_creds.json e sem GEMINI_API_KEY.';
        }
      }
      return base;
    },

    spawnInteractive(cwd: string, spawnOptions?: PtySpawnOptions): Promise<string> {
      return host.spawn(interactiveCommand(cwd), { ...spawnOptions, provider: id });
    },

    async runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
      // `--prompt=` (com "=") evita que um prompt começando com "-" seja lido como flag.
      const args = [`--prompt=${request.prompt}`, '--output-format', 'json'];
      if (request.model) args.push('--model', request.model);
      const r = await runProcess(binary, args, {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 10 * 60_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      let json: GeminiJson | undefined;
      try {
        json = JSON.parse(r.stdout) as GeminiJson;
      } catch {
        /* não-JSON */
      }
      const text = json?.response ?? r.stdout.trim();
      if (r.exitCode !== 0 || json?.error) {
        throw new Error(`gemini -p falhou (exit ${r.exitCode}): ${(json?.error?.message ?? r.stderr).slice(0, 500)}`);
      }
      return { text, json, durationMs: r.durationMs, resumed: false, exitCode: r.exitCode };
    },

    async limits(): Promise<Limits | 'unknown'> {
      return 'unknown';
    },
  };
}
