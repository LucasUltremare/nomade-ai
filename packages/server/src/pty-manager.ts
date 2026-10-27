import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { PtyCommand, PtyHost, PtySpawnOptions, ProviderId } from '@relay/core';
import { bracketedPaste, cleanTerminalOutput } from '@relay/core';

export interface SessionInfo {
  id: string;
  provider: ProviderId | 'shell';
  label: string;
  cwd: string;
  file: string;
  args: string[];
  pid: number;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode?: number;
  createdAt: string;
}

interface Session extends SessionInfo {
  proc: pty.IPty;
  scrollback: string;
  /** Saída acumulada desde o último Enter enviado ao PTY = "última resposta". */
  sinceLastEnter: string;
  lastResponse: string;
}

export interface PtyManagerOptions {
  scrollbackBytes: number;
  /** Variáveis que NUNCA devem vazar para os processos filhos. */
  envDenylist?: string[];
}

export type PtyEvents = {
  data: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number];
  created: [info: SessionInfo];
  removed: [sessionId: string];
};

export class PtyManager extends EventEmitter<PtyEvents> implements PtyHost {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: PtyManagerOptions) {
    super();
  }

  async spawn(command: PtyCommand, spawnOptions: PtySpawnOptions = {}): Promise<string> {
    const id = randomUUID();
    const cols = spawnOptions.cols ?? 100;
    const rows = spawnOptions.rows ?? 30;
    const env: Record<string, string> = {};
    const deny = new Set(['RELAY_TOKEN', ...(this.options.envDenylist ?? [])]);
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !deny.has(k)) env[k] = v;
    }
    Object.assign(env, command.env ?? {}, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      RELAY_SESSION_ID: id,
    });
    const proc = pty.spawn(command.file, command.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: command.cwd,
      env,
    });
    const session: Session = {
      id,
      provider: spawnOptions.provider ?? 'shell',
      label: spawnOptions.label ?? command.file,
      cwd: command.cwd,
      file: command.file,
      args: command.args,
      pid: proc.pid,
      cols,
      rows,
      alive: true,
      createdAt: new Date().toISOString(),
      proc,
      scrollback: '',
      sinceLastEnter: '',
      lastResponse: '',
    };
    this.sessions.set(id, session);
    proc.onData((data) => {
      session.scrollback = trimTail(session.scrollback + data, this.options.scrollbackBytes);
      session.sinceLastEnter = trimTail(session.sinceLastEnter + data, this.options.scrollbackBytes);
      this.emit('data', id, data);
    });
    proc.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;
      this.emit('exit', id, exitCode);
    });
    this.emit('created', toInfo(session));
    return id;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(toInfo);
  }

  get(id: string): SessionInfo | undefined {
    const s = this.sessions.get(id);
    return s ? toInfo(s) : undefined;
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.scrollback ?? '';
  }

  /** Texto limpo da saída desde o último Enter (ou da resposta anterior, se nada novo chegou). */
  lastOutput(id: string): string {
    const s = this.sessions.get(id);
    if (!s) return '';
    const current = cleanTerminalOutput(s.sinceLastEnter);
    return current || s.lastResponse;
  }

  /** Entrada vinda do teclado do usuário (xterm). */
  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return;
    if (data.includes('\r') || data.includes('\n')) {
      const finished = cleanTerminalOutput(s.sinceLastEnter);
      if (finished) s.lastResponse = finished;
      s.sinceLastEnter = '';
    }
    s.proc.write(data);
  }

  /** Cola texto (bracketed paste) e, opcionalmente, submete com Enter. */
  paste(id: string, text: string, submit: boolean): void {
    const s = this.sessions.get(id);
    if (!s || !s.alive) throw new Error('Sessão não existe ou já encerrou');
    s.proc.write(bracketedPaste(text));
    if (submit) {
      setTimeout(() => this.write(id, '\r'), 60);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return;
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return;
    s.cols = cols;
    s.rows = rows;
    s.proc.resize(cols, rows);
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.alive) {
      try {
        // node-pty envia o sinal ao grupo da sessão do PTY (SIGHUP), encerrando a árvore.
        s.proc.kill();
      } catch {
        /* já encerrado */
      }
      setTimeout(() => {
        if (s.alive) {
          try {
            process.kill(-s.pid, 'SIGKILL');
          } catch {
            /* ok */
          }
        }
      }, 2000).unref();
    }
    this.sessions.delete(id);
    this.emit('removed', id);
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

function toInfo(s: Session): SessionInfo {
  const { id, provider, label, cwd, file, args, pid, cols, rows, alive, exitCode, createdAt } = s;
  return { id, provider, label, cwd, file, args, pid, cols, rows, alive, createdAt, ...(exitCode !== undefined ? { exitCode } : {}) };
}

function trimTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
