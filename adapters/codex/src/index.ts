import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, DetectResult, HeadlessRequest, HeadlessResult, Limits, PtyCommand, PtyHost, PtySpawnOptions } from '@relay/core';
import { PROVIDER_COLORS, PROVIDER_NAMES } from '@relay/core';
import { parseVersion, runProcess, which } from '@relay/adapter-shared';

/**
 * Adapter do Codex CLI. Flags verificadas em `codex --help` / `codex exec --help` (v0.164.0):
 *   codex exec [--json] [-C <dir>] [--skip-git-repo-check] [-m <model>] [-o <file>] [PROMPT|-]
 *   codex exec resume <SESSION_ID> [PROMPT|-]   (flags de `exec` vêm antes de `resume`)
 *   codex login status   → exit 0 "Logged in using ChatGPT" | exit 1 "Not logged in"
 * Eventos JSONL: {"type":"thread.started","thread_id":...}, {"type":"item.completed","item":{"type":"agent_message","text":...}}
 */

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  message?: string;
}

export interface CodexAdapterOptions {
  binary?: string;
  timeoutMs?: number;
}

export function createCodexAdapter(host: PtyHost, options: CodexAdapterOptions = {}): Adapter {
  const binary = options.binary ?? 'codex';
  const id = 'codex' as const;
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
        installHint: 'npm install -g @openai/codex',
        loginHint: 'codex login  (abre o navegador; use a conta ChatGPT Plus/Pro)',
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
        /* opcional */
      }
      try {
        const r = await runProcess(binary, ['login', 'status'], { timeoutMs: 15000 });
        const out = `${r.stdout}\n${r.stderr}`.trim();
        base.login = r.exitCode === 0 ? 'logged-in' : 'logged-out';
        if (/chatgpt/i.test(out)) base.plan = 'ChatGPT';
        else if (/api key/i.test(out)) base.plan = 'API key';
        const firstLine = out.split('\n')[0];
        if (firstLine) base.notes = firstLine;
      } catch {
        base.login = 'unknown';
      }
      return base;
    },

    spawnInteractive(cwd: string, spawnOptions?: PtySpawnOptions): Promise<string> {
      return host.spawn(interactiveCommand(cwd), { ...spawnOptions, provider: id });
    },

    async runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
      const dir = await mkdtemp(join(tmpdir(), 'relay-codex-'));
      const lastMessageFile = join(dir, 'last.txt');
      try {
        const args = ['exec', '--json', '--skip-git-repo-check', '-C', request.cwd, '-o', lastMessageFile];
        if (request.model) args.push('-m', request.model);
        if (request.sessionId) args.push('resume', request.sessionId);
        args.push('-'); // prompt via stdin
        const r = await runProcess(binary, args, {
          cwd: request.cwd,
          stdin: request.prompt,
          timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 10 * 60_000,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        const events: CodexEvent[] = [];
        for (const line of r.stdout.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            events.push(JSON.parse(t) as CodexEvent);
          } catch {
            /* linha de log */
          }
        }
        const threadId = events.find((e) => e.type === 'thread.started')?.thread_id ?? request.sessionId;
        const messages = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item?.text ?? '');
        let text = messages.at(-1) ?? '';
        if (!text) {
          try {
            text = (await readFile(lastMessageFile, 'utf8')).trim();
          } catch {
            /* sem arquivo */
          }
        }
        if (r.exitCode !== 0 && !text) {
          const err = events.find((e) => e.type === 'error')?.message ?? r.stderr.trim();
          throw new Error(`codex exec falhou (exit ${r.exitCode}): ${err.slice(0, 500)}`);
        }
        return {
          text,
          json: events,
          durationMs: r.durationMs,
          ...(threadId ? { sessionId: threadId } : {}),
          resumed: Boolean(request.sessionId),
          exitCode: r.exitCode,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async limits(): Promise<Limits | 'unknown'> {
      // `codex` mostra limites só na TUI (/status). Sem comando headless equivalente.
      return 'unknown';
    },
  };
}
