/**
 * Executor genérico de grafos acíclicos: ordena topologicamente e executa
 * com um limite de paralelismo (padrão 2, para não estourar cota de assinatura).
 */

export interface ExecNode {
  id: string;
}

export interface ExecEdge {
  source: string;
  target: string;
}

export interface ExecutorOptions<N extends ExecNode, R> {
  nodes: N[];
  edges: ExecEdge[];
  /** Executa um nó com os resultados dos seus predecessores (na ordem das arestas). */
  run: (node: N, inputs: R[]) => Promise<R>;
  concurrency?: number;
  onStatus?: (nodeId: string, status: 'queued' | 'running' | 'done' | 'error', error?: unknown) => void;
  signal?: AbortSignal;
}

export class CycleError extends Error {
  constructor(public readonly remaining: string[]) {
    super(`Grafo contém ciclo ou referência inválida entre: ${remaining.join(', ')}`);
    this.name = 'CycleError';
  }
}

/** Ordenação topológica (Kahn). Lança CycleError se houver ciclo. */
export function topologicalOrder(nodes: ExecNode[], edges: ExecEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    out.set(id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    out.get(e.source)?.push(e.target);
  }
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== ids.size) {
    throw new CycleError([...ids].filter((id) => !order.includes(id)));
  }
  return order;
}

export async function executeGraph<N extends ExecNode, R>(options: ExecutorOptions<N, R>): Promise<Map<string, R>> {
  const { nodes, edges, run, onStatus, signal } = options;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  topologicalOrder(nodes, edges); // valida ciclos antes de começar

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    preds.get(e.target)?.push(e.source);
    succs.get(e.source)?.push(e.target);
  }

  const results = new Map<string, R>();
  const done = new Set<string>();
  const started = new Set<string>();
  let running = 0;
  let failure: unknown = null;

  for (const n of nodes) onStatus?.(n.id, 'queued');

  return new Promise<Map<string, R>>((resolve, reject) => {
    const ready = (): N[] =>
      nodes.filter(
        (n) => !started.has(n.id) && (preds.get(n.id) ?? []).every((p) => done.has(p)),
      );

    const pump = (): void => {
      if (failure) {
        if (running === 0) reject(failure);
        return;
      }
      if (signal?.aborted) {
        failure = signal.reason ?? new Error('Execução cancelada');
        if (running === 0) reject(failure);
        return;
      }
      if (done.size === nodes.length) {
        resolve(results);
        return;
      }
      for (const n of ready()) {
        if (running >= concurrency) break;
        started.add(n.id);
        running++;
        onStatus?.(n.id, 'running');
        const inputs = (preds.get(n.id) ?? []).map((p) => results.get(p) as R);
        run(n, inputs).then(
          (r) => {
            results.set(n.id, r);
            done.add(n.id);
            running--;
            onStatus?.(n.id, 'done');
            pump();
          },
          (err: unknown) => {
            running--;
            failure = err;
            onStatus?.(n.id, 'error', err);
            pump();
          },
        );
      }
    };
    pump();
  });
}
