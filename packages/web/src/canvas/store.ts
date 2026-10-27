import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { ProviderId } from '@relay/core';
import type { SessionInfo } from '../api.ts';

export interface TerminalNodeData extends Record<string, unknown> {
  sessionId: string;
  provider: ProviderId | 'shell';
  label: string;
  cwd: string;
  alive: boolean;
  exitCode?: number;
  minimized: boolean;
}

export type TerminalNode = Node<TerminalNodeData, 'terminal'>;

export interface HandoffEdgeData extends Record<string, unknown> {
  fired: boolean;
}
export type HandoffEdge = Edge<HandoffEdgeData>;

interface StoredLayout {
  nodes: Record<string, { x: number; y: number; width: number; height: number; minimized: boolean }>;
  edges: Array<{ id: string; source: string; target: string; fired: boolean }>;
}

const KEY = 'relay.canvas';
export const DEFAULT_SIZE = { width: 640, height: 420 };

export function loadLayout(): StoredLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as StoredLayout;
  } catch {
    /* corrompido */
  }
  return { nodes: {}, edges: [] };
}

export function saveLayout(nodes: TerminalNode[], edges: HandoffEdge[]): void {
  const layout: StoredLayout = {
    nodes: Object.fromEntries(
      nodes.map((n) => [
        n.id,
        {
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? n.measured?.width ?? DEFAULT_SIZE.width,
          height: n.height ?? n.measured?.height ?? DEFAULT_SIZE.height,
          minimized: n.data.minimized,
        },
      ]),
    ),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, fired: e.data?.fired ?? false })),
  };
  localStorage.setItem(KEY, JSON.stringify(layout));
}

/** Reconstrói nós a partir das sessões vivas no server + posições salvas localmente. */
export function nodesFromSessions(sessions: SessionInfo[], previous: TerminalNode[]): TerminalNode[] {
  const layout = loadLayout();
  const prevById = new Map(previous.map((n) => [n.id, n]));
  return sessions.map((s, i) => {
    const prev = prevById.get(s.id);
    const stored = layout.nodes[s.id];
    const minimized = prev?.data.minimized ?? stored?.minimized ?? false;
    const width = prev?.width ?? stored?.width ?? DEFAULT_SIZE.width;
    const height = minimized ? 40 : (prev?.height ?? (stored?.minimized ? DEFAULT_SIZE.height : stored?.height) ?? DEFAULT_SIZE.height);
    return {
      id: s.id,
      type: 'terminal',
      dragHandle: '.tnode-header',
      position: prev?.position ?? (stored ? { x: stored.x, y: stored.y } : { x: 40 + (i % 3) * 680, y: 40 + Math.floor(i / 3) * 460 }),
      width,
      height,
      data: {
        sessionId: s.id,
        provider: s.provider,
        label: s.label,
        cwd: s.cwd,
        alive: s.alive,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
        minimized,
      },
      ...(prev?.selected ? { selected: true } : {}),
    };
  });
}

export function edgesFromStorage(validIds: Set<string>): HandoffEdge[] {
  return loadLayout()
    .edges.filter((e) => validIds.has(e.source) && validIds.has(e.target))
    .map((e) => makeEdge(e.source, e.target, e.fired, e.id));
}

export function makeEdge(source: string, target: string, fired: boolean, id?: string): HandoffEdge {
  return {
    id: id ?? `h-${source}-${target}`,
    source,
    target,
    data: { fired },
    className: fired ? 'fired' : 'pending',
    markerEnd: { type: MarkerType.ArrowClosed, color: fired ? '#e4e4e7' : '#5c5c66', width: 18, height: 18 },
  };
}
