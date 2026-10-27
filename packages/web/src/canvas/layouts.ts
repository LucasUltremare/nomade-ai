import type { TerminalNode } from './store.ts';

export type LayoutPreset = 'grid' | 'focus' | 'split';

const GAP = 24;

/** Recalcula posição/tamanho de todos os nós. `focusId` é o nó em destaque no preset "foco". */
export function applyLayout(preset: LayoutPreset, nodes: TerminalNode[], focusId?: string): TerminalNode[] {
  const visible = nodes;
  if (visible.length === 0) return nodes;
  const expanded = (n: TerminalNode, width: number, height: number, x: number, y: number): TerminalNode => ({
    ...n,
    position: { x, y },
    width,
    height: n.data.minimized ? 40 : height,
  });

  if (preset === 'grid') {
    const cols = Math.ceil(Math.sqrt(visible.length));
    const w = 640;
    const h = 420;
    return visible.map((n, i) => expanded(n, w, h, (i % cols) * (w + GAP), Math.floor(i / cols) * (h + GAP)));
  }

  if (preset === 'split') {
    const left = visible.filter((_, i) => i % 2 === 0);
    const right = visible.filter((_, i) => i % 2 === 1);
    const w = 640;
    const h = Math.max(260, Math.floor(900 / Math.max(1, Math.max(left.length, right.length))) - GAP);
    const place = (col: TerminalNode[], x: number) => col.map((n, i) => expanded(n, w, h, x, i * (h + GAP)));
    return [...place(left, 0), ...place(right, w + GAP)].sort((a, b) => visible.indexOf(a) - visible.indexOf(b));
  }

  // focus
  const focus = visible.find((n) => n.id === focusId) ?? visible.find((n) => n.selected) ?? visible[0];
  if (!focus) return nodes;
  const others = visible.filter((n) => n.id !== focus.id);
  const bigW = 1040;
  const bigH = 680;
  const smallW = 420;
  const smallH = Math.max(180, Math.floor((bigH + GAP) / Math.max(1, others.length)) - GAP);
  const placed = new Map<string, TerminalNode>();
  placed.set(focus.id, expanded(focus, bigW, bigH, 0, 0));
  others.forEach((n, i) => placed.set(n.id, expanded(n, smallW, smallH, bigW + GAP, i * (smallH + GAP))));
  return visible.map((n) => placed.get(n.id) ?? n);
}
