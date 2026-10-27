import type { DetectResult, ProviderId } from '@relay/core';

export interface SessionInfo {
  id: string;
  provider: ProviderId | 'shell';
  label: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode?: number;
  createdAt: string;
}

export interface HandoffEntry {
  id: string;
  at: string;
  from?: string;
  to: string;
  source: 'selection' | 'last-output' | 'manual';
  submitted: boolean;
  chars: number;
  preview: string;
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY) ?? '';
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  sessions: () => request<SessionInfo[]>('GET', '/api/sessions'),
  createSession: (body: { provider: ProviderId | 'shell'; cwd: string; label?: string; cols?: number; rows?: number }) =>
    request<SessionInfo>('POST', '/api/sessions', body),
  deleteSession: (id: string) => request<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  lastOutput: (id: string) => request<{ text: string }>('GET', `/api/sessions/${id}/last-output`),
  handoffs: () => request<HandoffEntry[]>('GET', '/api/handoffs'),
  sendHandoff: (body: { from?: string; to: string; text: string; submit: boolean; source: HandoffEntry['source'] }) =>
    request<HandoffEntry>('POST', '/api/handoffs', body),
};

export function wsUrl(sessionId: string): string {
  const token = localStorage.getItem(TOKEN_KEY) ?? '';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/terminal/${sessionId}?token=${encodeURIComponent(token)}`;
}
