import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import type { DetectResult, ProviderId } from '@relay/core';
import { PROVIDER_COLORS } from '@relay/core';
import { api, type HandoffEntry, type RelayConfig } from '../api.ts';
import { TerminalNode, nodeCallbacks, providerColor, type TerminalNodeCallbacks } from './TerminalNode.tsx';
import { edgesFromStorage, makeEdge, nodesFromSessions, saveLayout, type HandoffEdge, type TerminalNode as TNode } from './store.ts';
import { applyLayout, type LayoutPreset } from './layouts.ts';
import { attachTerminal, disposeTerminal, getTerminal } from './terminals.ts';

const nodeTypes = { terminal: TerminalNode };

interface Menu {
  kind: 'selection' | 'send';
  from: string;
  text?: string;
  x: number;
  y: number;
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const rf = useReactFlow<TNode, HandoffEdge>();
  const [nodes, setNodes] = useState<TNode[]>([]);
  const [edges, setEdges] = useState<HandoffEdge[]>([]);
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [providers, setProviders] = useState<DetectResult[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [submit, setSubmit] = useState<boolean>(() => localStorage.getItem('relay.submit') !== '0');
  const [log, setLog] = useState<HandoffEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const loaded = useRef(false);

  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const syncSessions = useCallback(async () => {
    const sessions = await api.sessions();
    setNodes((prev) => {
      const next = nodesFromSessions(sessions, prev);
      if (!loaded.current) {
        loaded.current = true;
        setEdges(edgesFromStorage(new Set(next.map((n) => n.id))));
      }
      return next;
    });
    return sessions;
  }, []);

  useEffect(() => {
    void syncSessions().catch((e: Error) => notify(e.message, true));
    void api.config().then(setConfig);
    void api.providers().then(setProviders);
    void api.handoffs().then(setLog);
    const t = setInterval(() => {
      void syncSessions().catch(() => undefined);
      void api.handoffs().then(setLog).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [syncSessions, notify]);

  // Persistência local do layout (posições, tamanhos, arestas).
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => saveLayout(nodes, edges), 300);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const onNodesChange = useCallback((changes: NodeChange<TNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<HandoffEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      setEdges((es) => addEdge(makeEdge(c.source, c.target, false), es));
    },
    [],
  );

  const sendHandoff = useCallback(
    async (from: string, to: string, text: string, source: HandoffEntry['source']) => {
      try {
        const entry = await api.sendHandoff({ from, to, text, submit, source });
        setLog((l) => [...l, entry]);
        setEdges((es) => {
          const existing = es.find((e) => e.source === from && e.target === to);
          if (existing) return es.map((e) => (e === existing ? makeEdge(from, to, true, e.id) : e));
          return [...es, makeEdge(from, to, true)];
        });
        const target = nodes.find((n) => n.id === to);
        notify(`Enviado para ${target?.data.label ?? 'terminal'} (${text.length} chars)`);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), true);
      }
    },
    [submit, nodes, notify],
  );

  const outgoingOf = useCallback((id: string) => edges.filter((e) => e.source === id).map((e) => e.target), [edges]);

  // Callbacks usados pelos nós (atualizados a cada render, fora da fase de render).
  const callbacks: TerminalNodeCallbacks = {
    hasOutgoing: (id) => edges.some((e) => e.source === id),
    onToggleMinimize: (id) =>
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id
            ? { ...n, height: n.data.minimized ? 420 : 40, data: { ...n.data, minimized: !n.data.minimized } }
            : n,
        ),
      ),
    onMaximize: (id) => setMaximized(id),
    onClose: (id) => {
      void api.deleteSession(id).catch(() => undefined);
      disposeTerminal(id);
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      if (maximized === id) setMaximized(null);
    },
    onSendLast: (id, anchor) => {
      const targets = outgoingOf(id);
      if (targets.length === 1 && targets[0]) {
        void api.lastOutput(id).then(({ text }) => {
          if (!text.trim()) return notify('Nenhuma saída recente nesse terminal.', true);
          void sendHandoff(id, targets[0] as string, text, 'last-output');
        });
      } else {
        setMenu({ kind: 'send', from: id, x: anchor.left, y: anchor.bottom + 6 });
      }
    },
    onSelection: (id, text, x, y) => setMenu({ kind: 'selection', from: id, text, x, y }),
  };
  useEffect(() => {
    nodeCallbacks.current = callbacks;
  });

  const chooseTarget = async (to: string) => {
    if (!menu) return;
    const from = menu.from;
    setMenu(null);
    if (menu.kind === 'selection' && menu.text) await sendHandoff(from, to, menu.text, 'selection');
    else {
      const { text } = await api.lastOutput(from);
      if (!text.trim()) return notify('Nenhuma saída recente nesse terminal.', true);
      await sendHandoff(from, to, text, 'last-output');
    }
  };

  const layout = (preset: LayoutPreset) => {
    const focusId = maximized ?? nodes.find((n) => n.selected)?.id;
    setNodes((ns) => applyLayout(preset, ns, focusId));
    setTimeout(() => void rf.fitView({ padding: 0.1, duration: 300 }), 50);
  };

  const createTerminal = async (provider: ProviderId | 'shell', cwd: string, label: string) => {
    try {
      const s = await api.createSession({ provider, cwd, ...(label ? { label } : {}) });
      setShowNew(false);
      const sessions = await syncSessions();
      notify(`Terminal ${s.label} aberto (${sessions.length} ativo${sessions.length === 1 ? '' : 's'})`);
      setTimeout(() => void rf.fitView({ padding: 0.1, duration: 300 }), 100);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  };

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const menuTargets = menu
    ? [...nodes]
        .filter((n) => n.id !== menu.from && n.data.alive)
        .sort((a, b) => Number(edges.some((e) => e.source === menu.from && e.target === b.id)) - Number(edges.some((e) => e.source === menu.from && e.target === a.id)))
    : [];

  return (
    <div className="canvas-wrap" onClick={() => menu && setMenu(null)}>
      <div className="toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="btn primary sm" onClick={() => setShowNew((v) => !v)}>+ Terminal</button>
        <span className="sep" />
        <span className="muted small">layout</span>
        <button className="btn sm" onClick={() => layout('grid')} title="Grade">▦ grade</button>
        <button className="btn sm" onClick={() => layout('focus')} title="Foco no nó selecionado">▣ foco</button>
        <button className="btn sm" onClick={() => layout('split')} title="Duas colunas">▥ dividido</button>
        <span className="sep" />
        <button className="btn sm" onClick={() => void rf.fitView({ padding: 0.1, duration: 300 })}>ajustar</button>
        <span className="sep" />
        <label className="check" title="Ao enviar um handoff, pressionar Enter no destino">
          <input
            type="checkbox"
            checked={submit}
            onChange={(e) => {
              setSubmit(e.target.checked);
              localStorage.setItem('relay.submit', e.target.checked ? '1' : '0');
            }}
          />
          enviar Enter junto
        </label>
      </div>

      {showNew && config && (
        <NewTerminal config={config} providers={providers} onCreate={createTerminal} onClose={() => setShowNew(false)} />
      )}

      <div className="canvas">
        <ReactFlow<TNode, HandoffEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#26262b" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable style={{ width: 160, height: 100 }} nodeColor={(n) => providerColor((n as TNode).data.provider)} maskColor="rgba(11,11,13,0.7)" />
        </ReactFlow>
        {nodes.length === 0 && (
          <div className="center" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <div className="card" style={{ pointerEvents: 'auto' }}>
              <h1>Canvas vazio</h1>
              <p>Clique em <b>+ Terminal</b> para abrir uma CLI (Claude Code, Codex, Gemini, Ollama ou um shell) num nó. Arraste da bolinha direita de um nó até outro para criar uma conexão de handoff.</p>
            </div>
          </div>
        )}
      </div>

      {maximized && byId.get(maximized) && (
        <MaximizedOverlay node={byId.get(maximized) as TNode} onClose={() => setMaximized(null)} />
      )}

      {menu && (
        <div className="popover" style={{ left: Math.min(menu.x, window.innerWidth - 280), top: Math.min(menu.y, window.innerHeight - 260) }} onClick={(e) => e.stopPropagation()}>
          <div className="title">
            {menu.kind === 'selection' ? `Enviar seleção (${menu.text?.length ?? 0} chars) →` : 'Enviar última resposta →'}
          </div>
          {menuTargets.length === 0 && <div className="empty">Nenhum outro terminal ativo.</div>}
          {menuTargets.map((n) => {
            const connected = edges.some((e) => e.source === menu.from && e.target === n.id);
            return (
              <button key={n.id} className="menu-item" style={{ ['--pcolor' as string]: providerColor(n.data.provider) }} onClick={() => void chooseTarget(n.id)}>
                <span className="dot" />
                {n.data.label}
                <span className="sub">{connected ? 'conectado' : 'novo'}</span>
              </button>
            );
          })}
          <label className="check">
            <input type="checkbox" checked={submit} onChange={(e) => { setSubmit(e.target.checked); localStorage.setItem('relay.submit', e.target.checked ? '1' : '0'); }} />
            enviar Enter junto
          </label>
        </div>
      )}

      <footer className={`footer ${logOpen ? '' : 'collapsed'}`}>
        <div className="footer-head">
          <button className="btn sm" onClick={() => setLogOpen((v) => !v)}>{logOpen ? '▾' : '▸'}</button>
          <span>Handoffs</span>
          <span className="muted">{log.length}</span>
          <span className="spacer" />
          <span className="muted">contínua = enviado · tracejada = conexão ainda não disparada</span>
        </div>
        <div className="footer-body">
          {log.length === 0 && <div className="empty">Nenhum handoff ainda. Selecione texto num terminal, ou use "Enviar →" no header de um nó conectado.</div>}
          {[...log].reverse().map((h) => {
            const from = h.from ? byId.get(h.from) : undefined;
            const to = byId.get(h.to);
            return (
              <div className="log-row" key={h.id}>
                <span className="muted mono">{new Date(h.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="who">
                  {from && <span className="status-dot" style={{ background: providerColor(from.data.provider) }} />}
                  {from?.data.label ?? (h.from ? h.from.slice(0, 8) : 'manual')}
                </span>
                <span className="who">
                  → {to && <span className="status-dot" style={{ background: providerColor(to.data.provider) }} />}
                  {to?.data.label ?? h.to.slice(0, 8)}
                </span>
                <span className="preview" title={h.preview}>{h.preview}</span>
                <span className="muted">{h.chars} ch{h.submitted ? ' ⏎' : ''}</span>
              </div>
            );
          })}
        </div>
      </footer>

      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}

function MaximizedOverlay({ node, onClose }: { node: TNode; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = getTerminal(node.data.sessionId);
    attachTerminal(entry, host);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [node.data.sessionId, onClose]);
  return (
    <div className="overlay" style={{ ['--pcolor' as string]: providerColor(node.data.provider) }}>
      <div className="tnode-header" style={{ cursor: 'default' }}>
        <span className="dot" />
        <span className="title">{node.data.label}</span>
        <span className="cwd mono">{node.data.cwd}</span>
        <div className="actions">
          <button className="btn sm" onClick={onClose}>restaurar (Esc)</button>
        </div>
      </div>
      <div className="tnode-body" ref={hostRef} />
    </div>
  );
}

function NewTerminal({
  config,
  providers,
  onCreate,
  onClose,
}: {
  config: RelayConfig;
  providers: DetectResult[];
  onCreate: (provider: ProviderId | 'shell', cwd: string, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const ready = providers.filter((p) => p.installed && p.login !== 'logged-out');
  const [provider, setProvider] = useState<ProviderId | 'shell'>(ready[0]?.id ?? 'shell');
  const [cwd, setCwd] = useState(localStorage.getItem('relay.lastCwd') ?? config.defaultCwd);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="popover new-terminal" onClick={(e) => e.stopPropagation()}>
      <div className="title">Novo terminal</div>
      <div className="provider-pick">
        {providers.map((p) => (
          <button
            key={p.id}
            className={`pick ${provider === p.id ? 'active' : ''}`}
            style={{ ['--pcolor' as string]: PROVIDER_COLORS[p.id] }}
            disabled={!p.installed}
            title={!p.installed ? `Não instalada: ${p.installHint}` : p.login === 'logged-out' ? `Não logada: ${p.loginHint}` : ''}
            onClick={() => setProvider(p.id)}
          >
            <span className="status-dot" style={{ background: PROVIDER_COLORS[p.id] }} />
            {p.name}
            {p.installed && p.login === 'logged-out' && <span className="muted small">(sem login)</span>}
          </button>
        ))}
        <button className={`pick ${provider === 'shell' ? 'active' : ''}`} style={{ ['--pcolor' as string]: '#9a9aa3' }} onClick={() => setProvider('shell')}>
          <span className="status-dot" style={{ background: '#9a9aa3' }} /> shell
        </button>
      </div>
      <div className="field">
        <label>diretório de trabalho (dentro de {config.roots.join(', ')})</label>
        <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
      </div>
      <div className="field">
        <label>rótulo (opcional)</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex.: Claude · revisor" />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>cancelar</button>
        <button
          className="btn primary"
          disabled={busy || !cwd.trim()}
          onClick={async () => {
            setBusy(true);
            localStorage.setItem('relay.lastCwd', cwd.trim());
            await onCreate(provider, cwd.trim(), label.trim());
            setBusy(false);
          }}
        >
          {busy ? 'abrindo…' : 'Abrir'}
        </button>
      </div>
    </div>
  );
}
