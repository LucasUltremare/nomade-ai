import type { ProviderId } from './providers.ts';

export type LoginState = 'logged-in' | 'logged-out' | 'unknown';

/** Resultado de `detect()`: o que o Relay consegue descobrir sem ler credenciais. */
export interface DetectResult {
  id: ProviderId;
  name: string;
  installed: boolean;
  /** Caminho do binário, quando encontrado no PATH. */
  binaryPath?: string;
  version?: string;
  login: LoginState;
  /** Plano/assinatura, quando a própria CLI informa (ex.: "max", "pro"). */
  plan?: string;
  /** Conta/e-mail, quando a própria CLI informa. */
  account?: string;
  /** Modelos disponíveis, quando dá para listar (ex.: Ollama). */
  models?: string[];
  /** Como instalar/logar, exibido na tela inicial. */
  installHint: string;
  loginHint: string;
  /** Observações livres (limitações, método de detecção usado). */
  notes?: string;
}

export interface Limits {
  /** Janela de cota, se conhecida (ex.: "5h", "weekly"). */
  window?: string;
  used?: number;
  total?: number;
  resetsAt?: string;
  notes?: string;
}

export interface HeadlessRequest {
  prompt: string;
  /** Id de sessão retornado por uma execução anterior, para continuar a conversa. */
  sessionId?: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HeadlessResult {
  text: string;
  /** Saída estruturada bruta da CLI, quando ela oferece (--output-format json, --json). */
  json?: unknown;
  durationMs: number;
  /** Id de sessão para retomar, quando a CLI suporta. */
  sessionId?: string;
  /** `false` quando `sessionId` foi pedido mas a CLI não suporta retomar em modo headless. */
  resumed?: boolean;
  exitCode: number | null;
}

/** Descrição de um processo a ser aberto num PTY. O Relay nunca monta linha de shell. */
export interface PtyCommand {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface PtySpawnOptions {
  cols?: number;
  rows?: number;
  /** Rótulo livre, exibido no nó do canvas. */
  label?: string;
  provider?: ProviderId | 'shell';
}

/** Injetado pelo server: é quem de fato cria o PTY (node-pty). Mantém os adapters sem dependência nativa. */
export interface PtyHost {
  spawn(command: PtyCommand, options?: PtySpawnOptions): Promise<string>;
}

export interface Adapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly color: string;
  detect(): Promise<DetectResult>;
  /** Abre uma sessão PTY interativa da CLI e devolve o id da sessão. */
  spawnInteractive(cwd: string, options?: PtySpawnOptions): Promise<string>;
  /** Comando interativo que `spawnInteractive` usaria (útil para testes e para o server). */
  interactiveCommand(cwd: string): PtyCommand;
  runHeadless(request: HeadlessRequest): Promise<HeadlessResult>;
  limits(): Promise<Limits | 'unknown'>;
}
