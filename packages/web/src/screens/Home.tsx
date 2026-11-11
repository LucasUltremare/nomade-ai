import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DetectResult } from '@relay/core';
import type { AgentId, BigAgentId, ChatMsg, NomadeStatus, ToolCallV } from '../api.ts';
import { api } from '../api.ts';
import { AgentLogo, NomadeMark } from '../logos.tsx';

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

const AGENT_ORDER: AgentId[] = ['nomade', 'claude-code', 'codex', 'gemini'];
const BIG_AGENTS: BigAgentId[] = ['claude-code', 'codex', 'gemini'];

const AGENT_NAME: Record<AgentId, string> = {
  nomade: 'Nomade',
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};
const AGENT_ROLE: Record<AgentId, string> = {
  nomade: 'Local security agent',
  'claude-code': 'AppSec & deep code',
  codex: 'Scripts & automation',
  gemini: 'Research & long context',
};

type Status = 'ready' | 'logged-out' | 'unknown' | 'missing';

interface AgentView {
  id: AgentId;
  status: Status;
  detail?: string;
  hint?: string;
}

function providerStatus(p: DetectResult | undefined): Status {
  if (!p || !p.installed) return 'missing';
  if (p.login === 'logged-in') return 'ready';
  return p.login === 'logged-out' ? 'logged-out' : 'unknown';
}

function buildAgents(providers: DetectResult[] | null, nomade: NomadeStatus | null): AgentView[] {
  const byId = new Map(providers?.map((p) => [p.id, p]));
  const ollama = byId.get('ollama');
  const nomadeView: AgentView = {
    id: 'nomade',
    status: nomade?.online ? 'ready' : ollama?.installed ? 'logged-out' : 'missing',
    ...(nomade?.model ? { detail: nomade.model } : {}),
    ...(!ollama?.installed ? { hint: 'install Ollama' } : !nomade?.online ? { hint: 'ollama serve' } : {}),
  };
  const big = BIG_AGENTS.map((id): AgentView => {
    const p = byId.get(id);
    const status = providerStatus(p);
    return {
      id,
      status,
      ...(p?.plan ? { detail: p.plan } : {}),
      ...(status === 'missing' && p ? { hint: p.installHint } : status !== 'ready' && p ? { hint: p.loginHint } : {}),
    };
  });
  return [nomadeView, ...big];
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

type Phase = 'running' | 'review' | 'done' | 'error';

type ChatEvent =
  | { t: 'user'; text: string }
  | { t: 'msg'; by: string; agent: AgentId; text: string }
  | { t: 'tool'; name: string; args: Record<string, unknown>; result?: string; denied?: boolean; pending?: boolean }
  | { t: 'error'; text: string };

interface Conversation {
  id: string;
  at: string;
  title: string;
  cwd: string;
  events: ChatEvent[];
  thread: ChatMsg[]; // Nomade transcript
  phase: Phase;
  pending?: ToolCallV | null;
  running?: boolean;
  sessions?: Partial<Record<BigAgentId, string>>; // resume ids for big agents
}

const CONV_KEY = 'nomade.chats';
const PREFS_KEY = 'nomade.prefs';
const MAX_AGENT_STEPS = 10;

function loadConvs(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    const list = raw ? (JSON.parse(raw) as Conversation[]) : [];
    return list.map((c) => (c.running ? { ...c, running: false, phase: c.phase === 'review' ? 'review' : 'error' } : c));
  } catch {
    return [];
  }
}

type Theme = 'nomade' | 'retro';
interface Prefs {
  cwd: string;
  brain: string;
  theme: Theme;
  target: AgentId;
}
const DEFAULT_PREFS: Prefs = { cwd: '', brain: 'nomade', theme: 'nomade', target: 'nomade' };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* default */
  }
  return DEFAULT_PREFS;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const titleOf = (s: string) => (s.length > 42 ? `${s.slice(0, 42)}…` : s);

const TOOL_LABEL: Record<string, string> = {
  web_search: 'searched the web',
  read_url: 'read a page',
  nvd_lookup: 'looked up NVD',
  run_command: 'ran a command',
};

/* ------------------------------------------------------------------ */
/* Chat app                                                            */
/* ------------------------------------------------------------------ */

export function Home() {
  const [providers, setProviders] = useState<DetectResult[] | null>(null);
  const [nomade, setNomade] = useState<NomadeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [convs, setConvs] = useState<Conversation[]>(loadConvs);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [view, setView] = useState<string>('new');
  const [draft, setDraft] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const [p, n, c] = await Promise.all([api.providers(refresh), api.nomadeStatus(), api.config()]);
      setProviders(p);
      setNomade(n);
      setDefaultCwd(c.defaultCwd);
    } catch {
      /* keep prior */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(false), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(CONV_KEY, JSON.stringify(convs.slice(0, 40)));
    } catch {
      /* storage */
    }
  }, [convs]);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage */
    }
  }, [prefs]);

  const agents = useMemo(() => buildAgents(providers, nomade), [providers, nomade]);
  const isReady = useCallback((id: AgentId) => agents.find((a) => a.id === id)?.status === 'ready', [agents]);
  const brains = useMemo(() => nomade?.variants ?? [], [nomade]);
  const brain = useMemo(() => {
    if (brains.some((b) => b.model === prefs.brain && b.installed)) return prefs.brain;
    return brains.find((b) => b.installed)?.model ?? prefs.brain;
  }, [brains, prefs.brain]);

  const selected = convs.find((c) => c.id === view);

  const convsRef = useRef(convs);
  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);

  // Cancellation for in-flight agent/model calls.
  const cancelRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const newSignal = (id: string) => {
    abortRef.current.get(id)?.abort();
    const ac = new AbortController();
    abortRef.current.set(id, ac);
    return ac.signal;
  };

  // Auto-scroll to bottom on new content in the open conversation.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selected?.events.length, selected?.running, view]);

  const patch = useCallback((id: string, change: Partial<Conversation>) => {
    setConvs((list) => list.map((c) => (c.id === id ? { ...c, ...change } : c)));
  }, []);
  const pushEvent = useCallback((id: string, ev: ChatEvent) => {
    setConvs((list) => list.map((c) => (c.id === id ? { ...c, events: [...c.events, ev] } : c)));
  }, []);
  const resolveToolEvent = useCallback((id: string, change: Partial<Extract<ChatEvent, { t: 'tool' }>>) => {
    setConvs((list) =>
      list.map((c) => {
        if (c.id !== id) return c;
        const events = [...c.events];
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          if (e && e.t === 'tool' && (e.pending || e.result === undefined)) {
            events[i] = { ...e, ...change, pending: false };
            break;
          }
        }
        return { ...c, events };
      }),
    );
  }, []);

  const runAgent = useCallback(
    async (id: string, start: ChatMsg[]) => {
      let messages = [...start];
      patch(id, { running: true, phase: 'running', pending: null, thread: messages });
      for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        if (cancelRef.current.has(id)) return;
        let res;
        try {
          res = await api.agentStep(messages, brain, newSignal(id));
        } catch (err) {
          if (cancelRef.current.has(id)) return; // stopped by user
          pushEvent(id, { t: 'error', text: errMsg(err) });
          patch(id, { running: false, phase: 'error', thread: messages });
          return;
        }
        if (cancelRef.current.has(id)) return;
        messages = [...messages, { role: 'assistant', content: res.content }];
        if (!res.tool) {
          pushEvent(id, { t: 'msg', by: 'Nomade', agent: 'nomade', text: res.content });
          patch(id, { running: false, phase: 'done', thread: messages });
          return;
        }
        if (res.tool.name === 'run_command') {
          pushEvent(id, { t: 'tool', name: 'run_command', args: res.tool.args, pending: true });
          patch(id, { running: false, phase: 'review', pending: res.tool, thread: messages });
          return;
        }
        pushEvent(id, { t: 'tool', name: res.tool.name, args: res.tool.args, pending: true });
        let tr;
        try {
          tr = await api.agentTool(res.tool.name, res.tool.args, undefined, newSignal(id));
        } catch (err) {
          if (cancelRef.current.has(id)) return; // stopped by user
          tr = { result: `error: ${errMsg(err)}` };
        }
        resolveToolEvent(id, { result: tr.result });
        messages = [...messages, { role: 'user', content: `TOOL RESULT (${res.tool.name}): ${tr.result}` }];
        patch(id, { thread: messages });
      }
      pushEvent(id, { t: 'error', text: `stopped after ${MAX_AGENT_STEPS} steps` });
      patch(id, { running: false, phase: 'done', thread: messages });
    },
    [patch, pushEvent, resolveToolEvent, brain],
  );

  const resolveCommand = useCallback(
    async (id: string, approve: boolean) => {
      const c = convsRef.current.find((x) => x.id === id);
      if (!c?.pending) return;
      const { name, args } = c.pending;
      let messages = [...c.thread];
      if (approve) {
        cancelRef.current.delete(id);
        patch(id, { running: true, phase: 'running', pending: null });
        let tr;
        try {
          tr = await api.agentTool(name, args, c.cwd || undefined, newSignal(id));
        } catch (err) {
          if (cancelRef.current.has(id)) return;
          tr = { result: `error: ${errMsg(err)}` };
        }
        resolveToolEvent(id, { result: tr.result });
        messages = [...messages, { role: 'user', content: `TOOL RESULT (${name}): ${tr.result}` }];
      } else {
        resolveToolEvent(id, { result: 'denied by user', denied: true });
        patch(id, { pending: null });
        messages = [...messages, { role: 'user', content: `TOOL RESULT (${name}): user denied this command. Try another approach.` }];
      }
      await runAgent(id, messages);
    },
    [patch, resolveToolEvent, runAgent],
  );

  const dispatchBig = useCallback(
    async (id: string, agent: BigAgentId, text: string) => {
      patch(id, { running: true, phase: 'running' });
      const c = convsRef.current.find((x) => x.id === id);
      const sid = c?.sessions?.[agent];
      try {
        const r = await api.run({ agent, prompt: text, ...(c?.cwd ? { cwd: c.cwd } : {}), ...(sid ? { sessionId: sid } : {}) }, newSignal(id));
        pushEvent(id, { t: 'msg', by: AGENT_NAME[agent], agent, text: r.text || '(empty response)' });
        patch(id, {
          running: false,
          phase: 'done',
          ...(r.sessionId ? { sessions: { ...(c?.sessions ?? {}), [agent]: r.sessionId } } : {}),
        });
      } catch (err) {
        if (cancelRef.current.has(id)) return; // stopped by user
        pushEvent(id, { t: 'error', text: errMsg(err) });
        patch(id, { running: false, phase: 'error' });
      }
    },
    [patch, pushEvent],
  );

  const stop = useCallback(
    (id: string) => {
      cancelRef.current.add(id);
      abortRef.current.get(id)?.abort();
      pushEvent(id, { t: 'error', text: '⏹ stopped' });
      patch(id, { running: false, phase: 'done', pending: null });
    },
    [patch, pushEvent],
  );

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      const target = prefs.target;
      if (target !== 'nomade' && !isReady(target)) return;
      setDraft('');

      // Existing conversation?
      const existing = view !== 'new' ? convsRef.current.find((c) => c.id === view) : undefined;
      if (existing) {
        if (existing.running || existing.pending) return;
        cancelRef.current.delete(existing.id);
        pushEvent(existing.id, { t: 'user', text: t });
        if (target === 'nomade') void runAgent(existing.id, [...existing.thread, { role: 'user', content: t }]);
        else void dispatchBig(existing.id, target, t);
        return;
      }

      // New conversation.
      const id = crypto.randomUUID();
      const conv: Conversation = {
        id,
        at: new Date().toISOString(),
        title: titleOf(t),
        cwd: prefs.cwd.trim(),
        events: [{ t: 'user', text: t }],
        thread: [{ role: 'user', content: t }],
        phase: 'running',
      };
      setConvs((list) => [conv, ...list]);
      setView(id);
      if (target === 'nomade') void runAgent(id, conv.thread);
      else void dispatchBig(id, target, t);
    },
    [prefs.target, prefs.cwd, view, isReady, pushEvent, runAgent, dispatchBig],
  );

  const online = Boolean(nomade?.online);
  const canSend =
    draft.trim().length > 0 &&
    !(selected?.running || selected?.pending) &&
    (prefs.target === 'nomade' ? online : isReady(prefs.target));

  return (
    <div className="ide chat-ide" data-theme={prefs.theme}>
      <div className="win">
        {/* ---------- Sidebar ---------- */}
        <aside className="sb">
          <div className="sb-head">
            <NomadeMark className="sb-logo" />
            <span className="sb-title">Nomade</span>
          </div>
          <button className="new-chat" onClick={() => { setView('new'); setDraft(''); }}>
            + New chat
          </button>

          <div className="sb-scroll">
            <div className="sb-group">
              <div className="sb-label">Chats</div>
              {convs.length === 0 ? (
                <div className="sb-empty">no chats yet</div>
              ) : (
                convs.map((c) => (
                  <button key={c.id} className={`sb-item ${view === c.id ? 'on' : ''}`} onClick={() => setView(c.id)} title={c.title}>
                    <span className={`conv-dot ${c.running ? 'run' : c.phase}`} />
                    <span className="sb-item-text">{c.title}</span>
                    <span
                      className="sb-x"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConvs((l) => l.filter((x) => x.id !== c.id));
                        if (view === c.id) setView('new');
                      }}
                    >
                      ✕
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="sb-group">
              <div className="sb-label">Agents</div>
              {agents.map((a) => (
                <div key={a.id} className="sb-item agent" title={a.hint ?? AGENT_ROLE[a.id]}>
                  <span className={`dot ${a.status}`} />
                  <AgentLogo id={a.id} className="sb-ic" />
                  <span className="sb-item-text">{AGENT_NAME[a.id]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="sb-foot">
            <span className={`dot ${online ? 'ready' : 'missing'}`} />
            <span className="sb-foot-text">{online ? brain : 'offline'}</span>
            <button
              className="sb-foot-btn"
              title={`Theme: ${prefs.theme}`}
              onClick={() => setPrefs((p) => ({ ...p, theme: p.theme === 'nomade' ? 'retro' : 'nomade' }))}
            >
              {prefs.theme === 'retro' ? '▦' : '◧'}
            </button>
            <button className="sb-foot-btn" disabled={loading} title="Rescan" onClick={() => void load(true)}>
              {loading ? '…' : '⟳'}
            </button>
          </div>
        </aside>

        {/* ---------- Chat ---------- */}
        <main className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {!selected ? (
              <Welcome online={online} nomadeError={nomade?.error} />
            ) : (
              <div className="messages">
                {selected.events.map((e, i) => (
                  <EventView key={i} e={e} />
                ))}
                {selected.running && <div className="typing"><span className="dots"><i /><i /><i /></span> {prefs.target === 'nomade' ? 'Nomade' : AGENT_NAME[prefs.target]} is working…</div>}
                {selected.pending && <ApprovalBox pending={selected.pending} cwd={selected.cwd || defaultCwd} onResolve={(ok) => void resolveCommand(selected.id, ok)} />}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="composer">
            <div className="composer-row">
              <span className="to">to</span>
              <div className="chips">
                {AGENT_ORDER.map((id) => (
                  <button
                    key={id}
                    className={`chip ${prefs.target === id ? 'on' : ''}`}
                    disabled={id !== 'nomade' && !isReady(id)}
                    title={id === 'nomade' ? 'Nomade — local agent with tools (multi-turn)' : AGENT_ROLE[id]}
                    onClick={() => setPrefs((p) => ({ ...p, target: id }))}
                  >
                    <AgentLogo id={id} className="chip-ic" />
                    {AGENT_NAME[id]}
                  </button>
                ))}
              </div>
              {prefs.target === 'nomade' && brains.length > 1 && (
                <div className="chips brain-chips">
                  {brains.map((b) => (
                    <button key={b.id} className={`chip ${brain === b.model ? 'on' : ''}`} disabled={!b.installed} title={b.note} onClick={() => setPrefs((p) => ({ ...p, brain: b.model }))}>
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
              <label className="cwd-inline" title="Working directory for run_command">
                <span>cwd</span>
                <input className="line-input" placeholder={defaultCwd || 'project dir'} value={prefs.cwd} onChange={(e) => setPrefs((p) => ({ ...p, cwd: e.target.value }))} />
              </label>
            </div>
            <div className="composer-input">
              <textarea
                className="chat-textarea"
                placeholder={
                  prefs.target === 'nomade'
                    ? 'Message Nomade — it can search, read pages, hit the NVD and (with your OK) run commands…'
                    : `Message ${AGENT_NAME[prefs.target]}…`
                }
                value={draft}
                rows={1}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
              />
              {selected?.running ? (
                <button className="send-btn stop" onClick={() => stop(selected.id)} title="Stop">
                  ■
                </button>
              ) : (
                <button className="send-btn" onClick={() => send(draft)} disabled={!canSend} title="Send (Enter)">
                  ↑
                </button>
              )}
            </div>
            <div className="composer-hint">
              {online ? 'Enter to send · Shift+Enter for newline' : 'Nomade offline — start Ollama'} · local · 127.0.0.1
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Welcome({ online, nomadeError }: { online: boolean; nomadeError?: string | undefined }) {
  return (
    <div className="welcome">
      <NomadeMark className="welcome-logo" />
      <h1>Nomade</h1>
      <p>Your local ethical-hacking agent. It searches, reads sources, checks the NVD, and runs commands you approve — then keeps the thread so you can go back and forth.</p>
      {!online && <p className="welcome-warn">Offline ({nomadeError ?? 'Ollama not responding'}). Start Ollama and run <code>pnpm nomade:build</code>.</p>}
      <div className="welcome-ex">
        <span>try</span>
        <em>"explain CVE-2024-3094 and how to detect it on my box"</em>
        <em>"scan localhost with nmap and summarize the open ports"</em>
      </div>
    </div>
  );
}

function EventView({ e }: { e: ChatEvent }) {
  if (e.t === 'user') return <div className="bubble user"><div className="bubble-body">{e.text}</div></div>;
  if (e.t === 'error') {
    if (e.text.startsWith('⏹')) return <div className="stopped-note">{e.text}</div>;
    return <div className="bubble err"><div className="bubble-body">⚠ {e.text}</div></div>;
  }
  if (e.t === 'msg') {
    return (
      <div className={`bubble bot ${e.agent}`}>
        <div className="bubble-by">
          <AgentLogo id={e.agent} className="bubble-ic" /> {e.by}
        </div>
        <div className="bubble-body">{e.text}</div>
      </div>
    );
  }
  // tool
  const arg = e.name === 'run_command' ? String(e.args['command'] ?? '') : JSON.stringify(e.args);
  return (
    <div className={`toolrow ${e.denied ? 'denied' : ''}`}>
      <span className="toolrow-k">⚙ {TOOL_LABEL[e.name] ?? e.name}</span>
      <code className="toolrow-arg">{arg}</code>
      {e.pending && e.result === undefined && <span className="dots sm"><i /><i /><i /></span>}
      {e.result !== undefined && !e.denied && (
        <details className="toolrow-res">
          <summary>{e.result.length} chars</summary>
          <pre>{e.result.slice(0, 4000)}</pre>
        </details>
      )}
    </div>
  );
}

function ApprovalBox({ pending, cwd, onResolve }: { pending: ToolCallV; cwd: string; onResolve: (ok: boolean) => void }) {
  return (
    <div className="approve">
      <div className="approve-head">⚠ Nomade wants to run a command</div>
      <pre className="approve-cmd">$ {String(pending.args['command'] ?? '')}</pre>
      {pending.args['why'] ? <div className="approve-why">{String(pending.args['why'])}</div> : null}
      <div className="approve-cwd">in {cwd}</div>
      <div className="approve-actions">
        <button className="send-btn wide" onClick={() => onResolve(true)}>Approve &amp; run</button>
        <button className="text-btn" onClick={() => onResolve(false)}>Deny</button>
      </div>
    </div>
  );
}
