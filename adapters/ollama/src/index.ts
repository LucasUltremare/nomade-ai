import type { Adapter, DetectResult, HeadlessRequest, HeadlessResult, Limits, PtyCommand, PtyHost, PtySpawnOptions } from '@relay/core';
import { PROVIDER_COLORS, PROVIDER_NAMES } from '@relay/core';
import { parseVersion, runProcess, which } from '@relay/adapter-shared';

/**
 * Adapter do Ollama (modelos locais). Usa a API HTTP local documentada
 * (GET /api/version, GET /api/tags, POST /api/chat) e, para o modo interativo, `ollama run <modelo>`.
 * Não há login: "logado" aqui significa "servidor local respondendo".
 * Histórico de conversa (sessionId) fica em memória neste processo.
 */

interface TagsResponse {
  models?: Array<{ name: string }>;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatResponse {
  message?: { content?: string };
  error?: string;
}

export interface OllamaAdapterOptions {
  binary?: string;
  baseUrl?: string;
  /** Modelo padrão para o modo interativo/headless quando não informado. */
  model?: string;
  timeoutMs?: number;
}

export function createOllamaAdapter(host: PtyHost, options: OllamaAdapterOptions = {}): Adapter {
  const binary = options.binary ?? 'ollama';
  const baseUrl = (options.baseUrl ?? process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const id = 'ollama' as const;
  const histories = new Map<string, ChatMessage[]>();

  const listModels = async (): Promise<string[]> => {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tags = (await res.json()) as TagsResponse;
    return (tags.models ?? []).map((m) => m.name);
  };

  const interactiveCommand = (cwd: string): PtyCommand => ({
    file: binary,
    args: ['run', options.model ?? process.env['RELAY_OLLAMA_MODEL'] ?? 'llama3.2'],
    cwd,
  });

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
        installHint: 'brew install ollama  (ou https://ollama.com/download) e depois: ollama pull llama3.2',
        loginHint: 'ollama serve  (sem login; precisa só do servidor local rodando)',
      };
      const binaryPath = await which(binary);
      if (binaryPath) {
        base.installed = true;
        base.binaryPath = binaryPath;
        try {
          const v = await runProcess(binary, ['--version'], { timeoutMs: 10000 });
          const version = parseVersion(`${v.stdout} ${v.stderr}`);
          if (version) base.version = version;
        } catch {
          /* opcional */
        }
      }
      try {
        const models = await listModels();
        base.installed = true;
        base.login = 'logged-in';
        base.models = models;
        base.plan = 'local';
        base.notes = `Servidor em ${baseUrl}`;
      } catch {
        base.login = 'logged-out';
        base.notes = `Servidor não respondeu em ${baseUrl}`;
      }
      return base;
    },

    async spawnInteractive(cwd: string, spawnOptions?: PtySpawnOptions): Promise<string> {
      const command = interactiveCommand(cwd);
      if (!options.model && !process.env['RELAY_OLLAMA_MODEL']) {
        try {
          const [first] = await listModels();
          if (first) command.args = ['run', first];
        } catch {
          /* usa o padrão */
        }
      }
      return host.spawn(command, { ...spawnOptions, provider: id });
    },

    async runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
      const startedAt = Date.now();
      const model = request.model ?? options.model ?? process.env['RELAY_OLLAMA_MODEL'] ?? (await listModels())[0];
      if (!model) throw new Error('Nenhum modelo disponível no Ollama (rode `ollama pull <modelo>`).');
      const sessionId = request.sessionId ?? `ollama-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const history = histories.get(sessionId) ?? [];
      const messages: ChatMessage[] = [...history, { role: 'user', content: request.prompt }];
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 10 * 60_000;
      const signals = [AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])];
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.any(signals),
      });
      const json = (await res.json()) as ChatResponse;
      if (!res.ok || json.error) throw new Error(`ollama /api/chat falhou: ${json.error ?? res.status}`);
      const text = json.message?.content ?? '';
      histories.set(sessionId, [...messages, { role: 'assistant', content: text }]);
      return {
        text,
        json,
        durationMs: Date.now() - startedAt,
        sessionId,
        resumed: Boolean(request.sessionId && history.length > 0),
        exitCode: 0,
      };
    },

    async limits(): Promise<Limits | 'unknown'> {
      return { notes: 'Modelo local: sem cota.' };
    },
  };
}
