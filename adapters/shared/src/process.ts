import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Limite de bytes capturados de stdout/stderr (padrão 8 MiB). */
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export class ProcessTimeoutError extends Error {
  constructor(public readonly file: string, public readonly timeoutMs: number) {
    super(`${file} excedeu o timeout de ${timeoutMs}ms`);
    this.name = 'ProcessTimeoutError';
  }
}

/** Mata o processo e toda a árvore (process group) no POSIX; no Windows, taskkill /T. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal); // grupo (spawnado com detached: true)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* já morreu */
    }
  }
}

/**
 * Executa `file args...` sem shell, com stdin opcional, timeout e kill da árvore.
 * Nunca interpola o prompt em string de comando.
 */
export function runProcess(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, stdin, timeoutMs, signal, maxBuffer = 8 * 1024 * 1024 } = options;
  const startedAt = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      killTree(child.pid ?? 0);
      finish(() => reject(signal?.reason ?? new Error('cancelado')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid ?? 0, 'SIGTERM');
        setTimeout(() => killTree(child.pid ?? 0, 'SIGKILL'), 2000).unref();
      }, timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < maxBuffer) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < maxBuffer) stderr += d;
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (exitCode, sig) => {
      finish(() => {
        if (timedOut) reject(new ProcessTimeoutError(file, timeoutMs ?? 0));
        else resolve({ stdout, stderr, exitCode, signal: sig, durationMs: Date.now() - startedAt, timedOut });
      });
    });

    if (stdin !== undefined) {
      child.stdin.on('error', () => {
        /* EPIPE se o processo fechar cedo */
      });
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Procura um executável no PATH (sem shell). */
export async function which(binary: string): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* próximo */
      }
    }
  }
  return undefined;
}

/** Extrai a primeira versão semver-ish de um texto ("codex-cli 0.164.0" → "0.164.0"). */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+[-+\w.]*)/.exec(text)?.[1];
}
