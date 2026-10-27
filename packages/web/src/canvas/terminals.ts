/**
 * Registro de instâncias xterm por sessão. Vive fora do React para que:
 *  - re-renders/unmounts dos nós não destruam o terminal nem a conexão;
 *  - o mesmo terminal possa ser "reparentado" (nó ↔ overlay maximizado).
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl } from '../api.ts';

export type TermStatus = 'connecting' | 'open' | 'closed' | 'exited';

export interface TermEntry {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  ws: WebSocket | null;
  status: TermStatus;
  exitCode?: number;
  opened: boolean;
  listeners: Set<() => void>;
}

const registry = new Map<string, TermEntry>();

function notify(entry: TermEntry): void {
  for (const l of entry.listeners) l();
}

function connect(entry: TermEntry): void {
  const ws = new WebSocket(wsUrl(entry.sessionId));
  entry.ws = ws;
  entry.status = 'connecting';
  notify(entry);
  ws.onopen = () => {
    entry.status = 'open';
    notify(entry);
    sendResize(entry);
  };
  ws.onmessage = (ev) => {
    let msg: { t: string; d?: string; code?: number };
    try {
      msg = JSON.parse(String(ev.data)) as { t: string; d?: string; code?: number };
    } catch {
      return;
    }
    if (msg.t === 'out' && msg.d) entry.term.write(msg.d);
    else if (msg.t === 'exit') {
      entry.status = 'exited';
      entry.exitCode = msg.code ?? -1;
      entry.term.write(`\r\n\x1b[2m[relay] processo encerrado (exit ${entry.exitCode})\x1b[0m\r\n`);
      notify(entry);
    }
  };
  ws.onclose = () => {
    if (entry.status !== 'exited') {
      entry.status = 'closed';
      notify(entry);
    }
    entry.ws = null;
  };
}

function sendResize(entry: TermEntry): void {
  if (entry.ws?.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify({ t: 'resize', cols: entry.term.cols, rows: entry.term.rows }));
  }
}

export function getTerminal(sessionId: string): TermEntry {
  const existing = registry.get(sessionId);
  if (existing) return existing;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#0e0e11',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      selectionBackground: '#3b3b45',
      black: '#1a1a1f',
      brightBlack: '#5c5c66',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const container = document.createElement('div');
  container.className = 'xterm-host';
  const entry: TermEntry = { sessionId, term, fit, container, ws: null, status: 'connecting', opened: false, listeners: new Set() };
  term.onData((d) => {
    if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ t: 'in', d }));
  });
  term.onResize(() => sendResize(entry));
  registry.set(sessionId, entry);
  connect(entry);
  return entry;
}

export function reconnect(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.ws) return;
  entry.term.reset();
  connect(entry);
}

/** Coloca o container do terminal dentro de `host` e ajusta o tamanho. */
export function attachTerminal(entry: TermEntry, host: HTMLElement): void {
  if (entry.container.parentElement !== host) host.appendChild(entry.container);
  if (!entry.opened) {
    entry.term.open(entry.container);
    entry.opened = true;
  }
  refit(entry);
}

export function refit(entry: TermEntry): void {
  if (!entry.opened) return;
  requestAnimationFrame(() => {
    try {
      entry.fit.fit();
    } catch {
      /* container sem tamanho ainda */
    }
  });
}

export function disposeTerminal(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.ws?.close();
  entry.term.dispose();
  entry.container.remove();
  registry.delete(sessionId);
}

export function subscribe(entry: TermEntry, listener: () => void): () => void {
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}
