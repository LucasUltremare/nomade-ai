import type { DetectResult, ProviderId } from '@relay/core';

export type AgentId = 'nomade' | 'claude-code' | 'codex' | 'gemini';
export type BigAgentId = Exclude<AgentId, 'nomade'>;

export interface NomadeStatus {
  online: boolean;
  model?: string;
  compiled: boolean;
  baseUrl: string;
  search: SearchProviderId[];
  variants: NomadeVariant[];
  error?: string;
}

export interface NomadeVariant {
  id: string;
  label: string;
  model: string;
  base: string;
  note: string;
  installed: boolean;
}

export type SearchProviderId = 'nvd' | 'searxng' | 'ollama' | 'brave' | 'wikipedia';

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  read: boolean;
  excerpt: string;
}

export interface Research {
  query: string;
  provider: SearchProviderId;
  sources: ResearchSource[];
  context: string;
  ms: number;
}

export interface TriageDecision {
  agent: AgentId;
  complexity: 'trivial' | 'normal' | 'heavy';
  reason: string;
  brief: string;
  web: boolean;
  query: string;
  suggested: AgentId;
  model: string;
  ms: number;
}

export interface NomadeReply {
  text: string;
  model: string;
  ms: number;
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ToolCallV {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentStep {
  content: string;
  tool: ToolCallV | null;
  model: string;
}

export interface ToolResult {
  result: string;
  data?: unknown;
}

export interface RunResult {
  agent: BigAgentId;
  text: string;
  durationMs: number;
  exitCode: number | null;
  sessionId?: string;
}

export interface RelayConfig {
  roots: string[];
  defaultCwd: string;
  providers: ProviderId[];
}

const TOKEN_KEY = 'relay.token';

export function readToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY) ?? '';
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* sem corpo */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('GET', '/api/health'),
  config: () => request<RelayConfig>('GET', '/api/config'),
  providers: (refresh = false) => request<DetectResult[]>('GET', `/api/providers${refresh ? '?refresh=1' : ''}`),
  nomadeStatus: () => request<NomadeStatus>('GET', '/api/nomade/status'),
  triage: (task: string, model?: string) => request<TriageDecision>('POST', '/api/nomade/triage', { task, ...(model ? { model } : {}) }),
  answer: (task: string, context?: string, model?: string) =>
    request<NomadeReply>('POST', '/api/nomade/answer', { task, ...(context ? { context } : {}), ...(model ? { model } : {}) }),
  research: (query: string) => request<Research>('POST', '/api/nomade/research', { query }),
  digest: (task: string, output: string, model?: string) =>
    request<NomadeReply>('POST', '/api/nomade/digest', { task, output, ...(model ? { model } : {}) }),
  agentStep: (messages: ChatMsg[], model?: string, signal?: AbortSignal) =>
    request<AgentStep>('POST', '/api/agent/step', { messages, ...(model ? { model } : {}) }, signal),
  agentTool: (name: string, args: Record<string, unknown>, cwd?: string, signal?: AbortSignal) =>
    request<ToolResult>('POST', '/api/agent/tool', { name, args, ...(cwd ? { cwd } : {}) }, signal),
  run: (body: { agent: BigAgentId; prompt: string; cwd?: string; sessionId?: string }, signal?: AbortSignal) =>
    request<RunResult>('POST', '/api/run', body, signal),
};
