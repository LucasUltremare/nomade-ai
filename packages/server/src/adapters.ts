import type { Adapter, PtyHost, ProviderId } from '@relay/core';
import { createClaudeCodeAdapter } from '@relay/adapter-claude-code';
import { createCodexAdapter } from '@relay/adapter-codex';
import { createGeminiAdapter } from '@relay/adapter-gemini';
import { createOllamaAdapter } from '@relay/adapter-ollama';

export function createAdapters(host: PtyHost): Record<ProviderId, Adapter> {
  return {
    'claude-code': createClaudeCodeAdapter(host),
    codex: createCodexAdapter(host),
    gemini: createGeminiAdapter(host),
    ollama: createOllamaAdapter(host),
  };
}
