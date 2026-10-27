import { randomUUID } from 'node:crypto';
import type { Adapter, DetectResult, HeadlessRequest, HeadlessResult, Limits, PtyCommand, PtyHost, PtySpawnOptions } from '@relay/core';
import { PROVIDER_COLORS, PROVIDER_NAMES } from '@relay/core';
import { parseVersion, runProcess, which } from '@relay/adapter-shared';

/**
 * Adapter do Claude Code. Flags verificadas em `claude --help` (v2.1.306):
 *   -p/--print, --output-format json, --resume <id>, --session-id <uuid>, --model <m>
 *   claude auth status --json  → { loggedIn, subscriptionType, email, authMethod }
 */

interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
}

interface PrintResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

export interface ClaudeCodeAdapterOptions {
  binary?: string;
  /** Timeout padrão de execução headless (ms). */
  timeoutMs?: number;
}

export function createClaudeCodeAdapter(host: PtyHost, options: ClaudeCodeAdapterOptions = {}): Adapter {
  const binary = options.binary ?? 'claude';
  const id = 'claude-code' as const;

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
        installHint: 'npm install -g @anthropic-ai/claude-code  (ou: curl -fsSL https://claude.ai/install.sh | bash)',
        loginHint: 'claude auth login',
      };
      const binaryPath = await which(binary);
      if (!binaryPath) return base;
      base.installed = true;
      base.binaryPath = binaryPath;
      try {
        const v = await runProcess(binary, ['--version'], { timeoutMs: 15000 });
        const version = parseVersion(v.stdout);
        if (version) base.version = version;
      } catch {
        /* versão opcional */
      }
      try {
        const r = await runProcess(binary, ['auth', 'status', '--json'], { timeoutMs: 15000 });
        const status = JSON.parse(r.stdout) as AuthStatus;
        base.login = status.loggedIn ? 'logged-in' : 'logged-out';
        if (status.subscriptionType) base.plan = status.subscriptionType;
        if (status.email) base.account = status.email;
        if (status.authMethod) base.notes = `auth: ${status.authMethod}`;
      } catch {
        base.login = 'unknown';
        base.notes = 'Não foi possível ler `claude auth status --json`.';
      }
      return base;
    },

    spawnInteractive(cwd: string, spawnOptions?: PtySpawnOptions): Promise<string> {
      return host.spawn(interactiveCommand(cwd), { ...spawnOptions, provider: id });
    },

    async runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
      const sessionId = request.sessionId ?? randomUUID();
      const args = ['-p', '--output-format', 'json'];
      args.push(request.sessionId ? '--resume' : '--session-id', sessionId);
      if (request.model) args.push('--model', request.model);
      const r = await runProcess(binary, args, {
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 10 * 60_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      let json: PrintResult | undefined;
      try {
        json = JSON.parse(r.stdout) as PrintResult;
      } catch {
        /* saída não-JSON (ex.: erro de auth) */
      }
      const text = json?.result ?? (r.stdout.trim() || r.stderr.trim());
      if (r.exitCode !== 0 || json?.is_error) {
        throw new Error(`claude -p falhou (exit ${r.exitCode}): ${text.slice(0, 500)}`);
      }
      return {
        text,
        json,
        durationMs: r.durationMs,
        sessionId: json?.session_id ?? sessionId,
        resumed: Boolean(request.sessionId),
        exitCode: r.exitCode,
      };
    },

    async limits(): Promise<Limits | 'unknown'> {
      // A CLI não expõe cota de assinatura em modo não interativo (só o /usage interativo).
      return 'unknown';
    },
  };
}
