/** Identificadores estáveis dos provedores suportados. */
export const PROVIDER_IDS = ['claude-code', 'codex', 'gemini', 'ollama'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Cores por provedor (ver seção "Visual" do plano). */
export const PROVIDER_COLORS: Record<ProviderId, string> = {
  'claude-code': '#e08a5c',
  codex: '#4fc39a',
  gemini: '#6ea8ff',
  ollama: '#c49bff',
};

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  ollama: 'Ollama',
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
