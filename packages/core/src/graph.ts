import type { ProviderId } from './providers.ts';

export type NodeKind = 'terminal' | 'prompt' | 'model' | 'judge' | 'router' | 'output' | 'preview' | 'note' | 'card' | 'diagram';

export interface Position {
  x: number;
  y: number;
}

export interface BaseNode<K extends NodeKind, D> {
  id: string;
  kind: K;
  position: Position;
  data: D;
}

export interface TerminalNodeData {
  provider: ProviderId | 'shell';
  cwd: string;
  sessionId?: string;
  label?: string;
}

export interface PromptNodeData {
  text: string;
}

export interface ModelNodeData {
  provider: ProviderId;
  model?: string;
  cwd: string;
  systemPrompt?: string;
}

export interface JudgeNodeData {
  provider: ProviderId;
  cwd: string;
  instructions: string;
}

export interface RouterNodeData {
  rules: Array<{ match: string; target: string }>;
}

export interface OutputNodeData {
  format: 'text' | 'markdown' | 'json';
}

export type FlowNode =
  | BaseNode<'terminal', TerminalNodeData>
  | BaseNode<'prompt', PromptNodeData>
  | BaseNode<'model', ModelNodeData>
  | BaseNode<'judge', JudgeNodeData>
  | BaseNode<'router', RouterNodeData>
  | BaseNode<'output', OutputNodeData>;

export type EdgeKind = 'handoff' | 'data';

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Para arestas de handoff: já houve envio por esta conexão? (contínua) ou ainda não (tracejada). */
  fired?: boolean;
}

export interface Flow {
  version: 1;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type NodeStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
