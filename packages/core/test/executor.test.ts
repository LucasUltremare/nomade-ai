import { describe, expect, it } from 'vitest';
import { CycleError, executeGraph, topologicalOrder } from '../src/executor.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('topologicalOrder', () => {
  it('orders a simple chain', () => {
    const order = topologicalOrder([{ id: 'c' }, { id: 'a' }, { id: 'b' }], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('throws on cycles', () => {
    expect(() =>
      topologicalOrder([{ id: 'a' }, { id: 'b' }], [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ]),
    ).toThrow(CycleError);
  });
});

describe('executeGraph', () => {
  it('runs fan-out in parallel but respects concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await executeGraph<{ id: string }, string>({
      nodes: [{ id: 'p' }, { id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'j' }],
      edges: [
        { source: 'p', target: 'm1' },
        { source: 'p', target: 'm2' },
        { source: 'p', target: 'm3' },
        { source: 'm1', target: 'j' },
        { source: 'm2', target: 'j' },
        { source: 'm3', target: 'j' },
      ],
      concurrency: 2,
      run: async (n, inputs) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(10);
        active--;
        return `${n.id}(${inputs.join(',')})`;
      },
    });
    expect(peak).toBe(2);
    expect(results.get('j')).toBe('j(m1(p()),m2(p()),m3(p()))');
  });

  it('reports status transitions', async () => {
    const seen: string[] = [];
    await executeGraph<{ id: string }, number>({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
      run: async () => 1,
      onStatus: (id, s) => seen.push(`${id}:${s}`),
    });
    expect(seen).toEqual(['a:queued', 'b:queued', 'a:running', 'a:done', 'b:running', 'b:done']);
  });

  it('rejects when a node fails and stops scheduling', async () => {
    const ran: string[] = [];
    await expect(
      executeGraph<{ id: string }, number>({
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b' }],
        run: async (n) => {
          ran.push(n.id);
          if (n.id === 'a') throw new Error('boom');
          return 1;
        },
      }),
    ).rejects.toThrow('boom');
    expect(ran).toEqual(['a']);
  });
});
