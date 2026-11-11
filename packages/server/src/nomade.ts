import type { ProviderId } from '@relay/core';
import type { SearchProviderId, SearchResult } from './web.ts';
import { readPage, search, searchProviders } from './web.ts';
import type { ParsedToolCall } from './agent.ts';
import { AGENT_SYSTEM, parseToolCall } from './agent.ts';

/**
 * Nomade: modelo local (via Ollama) que apoia os agentes maiores.
 * - triage(): decide rápido quem cuida da tarefa e escreve um brief compacto.
 * - answer(): resolve sozinho tarefas triviais (economiza cota dos modelos grandes).
 * - digest(): resume respostas longas em poucos pontos.
 * Tudo com saída curta, temperatura baixa e o modelo mantido quente na memória.
 */

export const AGENT_IDS = ['nomade', 'claude-code', 'codex', 'gemini'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type Complexity = 'trivial' | 'normal' | 'heavy';

export interface TriageDecision {
  agent: AgentId;
  complexity: Complexity;
  reason: string;
  brief: string;
  /** Precisa de informação da internet (atual, externa, verificável)? */
  web: boolean;
  /** Consulta de busca sugerida, quando `web` é true. */
  query: string;
  /** Agente sugerido pelo modelo antes de checar disponibilidade. */
  suggested: AgentId;
  model: string;
  ms: number;
}

export interface ResearchSource extends SearchResult {
  /** true se a página foi baixada e lida; false se só temos o trecho da busca. */
  read: boolean;
  excerpt: string;
}

export interface Research {
  query: string;
  provider: SearchProviderId;
  sources: ResearchSource[];
  /** Fontes numeradas em texto, prontas para ir ao prompt. */
  context: string;
  ms: number;
}

export interface NomadeVariant {
  id: string;
  label: string;
  model: string;
  base: string;
  note: string;
  installed: boolean;
}

export interface NomadeStatus {
  online: boolean;
  /** Default model actually used when the caller does not pick a variant. */
  model?: string;
  compiled: boolean;
  baseUrl: string;
  /** Search providers configured, in the order they are tried. */
  search: SearchProviderId[];
  /** The Nomade brains and whether each is installed in Ollama. */
  variants: NomadeVariant[];
  error?: string;
}

/** The Nomade "brains" — compiled Ollama models the user can switch between. */
export const NOMADE_VARIANTS: Omit<NomadeVariant, 'installed'>[] = [
  { id: 'nomade', label: 'Coder', model: 'nomade', base: 'qwen2.5-coder-abliterate:3b', note: 'Qwen2.5-Coder 3B · fast, fits GPU' },
  { id: 'nomade-x', label: 'Unchained', model: 'nomade-x', base: 'dolphin3:8b', note: 'Dolphin 3 8B · max quality, slow on 6 GB' },
];
const VARIANT_MODELS = NOMADE_VARIANTS.map((v) => v.model);
export const DEFAULT_VARIANT_MODELS = VARIANT_MODELS;

const AGENT_ROLES: Record<AgentId, string> = {
  nomade:
    'yourself (local ethical hacker, instant, free): explain a CVE, technique, tool or security command; read nmap output / short logs; hardening checklists; CTF questions; short questions in general.',
  'claude-code':
    'Claude Code: security review of a repo (AppSec), fixing vulnerabilities in code, threat modeling, multi-file audits, long pentest reports.',
  codex: 'Codex: focused security scripts (scanner, log parser, detection rule, automation), tests and targeted fixes in a repo.',
  gemini: 'Gemini: broad threat-intel research, very long reports or documents, comparing multiple sources and advisories.',
};

const KEEP_ALIVE = '30m';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class Nomade {
  readonly baseUrl: string;
  private readonly preferred: string;
  private readonly fallback: string;
  private tagsCache: { at: number; names: string[] } | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = (env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.preferred = env['NOMADE_MODEL'] ?? 'nomade';
    this.fallback = env['NOMADE_FALLBACK_MODEL'] ?? 'llama3.2';
  }

  private async tags(): Promise<string[]> {
    if (this.tagsCache && Date.now() - this.tagsCache.at < 30_000) return this.tagsCache.names;
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const names = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    this.tagsCache = { at: Date.now(), names };
    return names;
  }

  private static has(names: string[], n: string): boolean {
    return names.some((x) => x === n || x === `${n}:latest`);
  }

  /** Pick which model to run. `want` lets a caller choose a specific Nomade variant. */
  private async resolve(want?: string): Promise<{ model: string; compiled: boolean }> {
    const names = await this.tags();
    const pref = want && VARIANT_MODELS.includes(want) ? want : this.preferred;
    for (const n of [pref, ...VARIANT_MODELS, this.fallback]) {
      if (Nomade.has(names, n)) return { model: n, compiled: VARIANT_MODELS.includes(n) };
    }
    if (names[0]) return { model: names[0], compiled: false };
    throw new Error('No model in Ollama. Run: pnpm nomade:pull && pnpm nomade:build');
  }

  /** Warm a model into memory so the first call is fast. */
  async warm(want?: string): Promise<void> {
    const { model } = await this.resolve(want);
    await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(120_000),
    });
  }

  async status(): Promise<NomadeStatus> {
    const search = searchProviders().map((p) => p.id);
    try {
      const names = await this.tags();
      const variants = NOMADE_VARIANTS.map((v) => ({ ...v, installed: Nomade.has(names, v.model) }));
      const { model, compiled } = await this.resolve();
      return { online: true, model, compiled, baseUrl: this.baseUrl, search, variants };
    } catch (err) {
      this.tagsCache = undefined;
      return {
        online: false,
        compiled: false,
        baseUrl: this.baseUrl,
        search,
        variants: NOMADE_VARIANTS.map((v) => ({ ...v, installed: false })),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async chat(
    messages: ChatMessage[],
    opts: { format?: unknown; maxTokens: number; timeoutMs: number; ctx?: number; model?: string },
  ): Promise<{ text: string; model: string }> {
    const { model } = await this.resolve(opts.model);
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        keep_alive: KEEP_ALIVE,
        ...(opts.format ? { format: opts.format } : {}),
        options: { temperature: 0.1, num_predict: opts.maxTokens, num_ctx: opts.ctx ?? 4096 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const json = (await res.json()) as { message?: { content?: string }; error?: string };
    if (!res.ok || json.error) throw new Error(`Nomade (${model}) falhou: ${json.error ?? `HTTP ${res.status}`}`);
    return { text: (json.message?.content ?? '').trim(), model };
  }

  /** Decide fast who handles the task. `available` lists the big agents that are ready. */
  async triage(task: string, available: ProviderId[], opts: { model?: string } = {}): Promise<TriageDecision> {
    const started = Date.now();
    const options: AgentId[] = ['nomade', ...AGENT_IDS.filter((a): a is Exclude<AgentId, 'nomade'> => a !== 'nomade' && available.includes(a))];
    const roster = options.map((a) => `- ${a}: ${AGENT_ROLES[a]}`).join('\n');
    const system = [
      'You are Nomade, the local ethical-hacker and the team router. Decide in one pass, no hesitation.',
      'Agents available right now:',
      roster,
      '',
      'Rules:',
      '- If the task is simple and short, pick "nomade" (saves the big models\' quota).',
      '- If it involves real code, multiple files, or needs long reasoning, pick a big agent.',
      '- "brief": rewrite the task as a clear, compact instruction for the chosen agent, in the user\'s language.',
      '  Keep every detail, file name and constraint. Do not invent requirements.',
      '- "reason": one short sentence explaining the choice.',
      '- "web": true if the task needs info from the internet: CVEs, advisories, affected versions, public exploits,',
      '  attack news, recent docs, facts that change over time, or if the user asks to search. Otherwise false.',
      '- "query": if web is true, the best short search query (3 to 8 words). For a vulnerability, include the',
      '  CVE id if present, or "cve <product>". Otherwise "".',
      'Reply with JSON only.',
    ].join('\n');
    const format = {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: options },
        complexity: { type: 'string', enum: ['trivial', 'normal', 'heavy'] },
        reason: { type: 'string' },
        brief: { type: 'string' },
        web: { type: 'boolean' },
        query: { type: 'string' },
      },
      required: ['agent', 'complexity', 'reason', 'brief', 'web', 'query'],
    };
    const { text, model } = await this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: task },
      ],
      { format, maxTokens: 400, timeoutMs: 60_000, ...(opts.model ? { model: opts.model } : {}) },
    );
    let parsed: Partial<{ agent: string; complexity: string; reason: string; brief: string; web: boolean; query: string }> = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      /* cai nos padrões abaixo */
    }
    const suggested: AgentId = (AGENT_IDS as readonly string[]).includes(parsed.agent ?? '') ? (parsed.agent as AgentId) : 'nomade';
    const complexity: Complexity = parsed.complexity === 'trivial' || parsed.complexity === 'heavy' ? parsed.complexity : 'normal';
    let agent: AgentId = options.includes(suggested) ? suggested : 'nomade';
    // Tarefa pesada mas sem agente grande disponível: o Nomade tenta mesmo assim, avisando.
    let reason = (parsed.reason ?? '').trim() || 'default choice';
    if (agent !== suggested) reason = `${suggested} unavailable; kept it on Nomade. ${reason}`;
    if (agent === 'nomade' && complexity === 'heavy' && options.length > 1) {
      agent = options.includes('claude-code') ? 'claude-code' : (options[1] ?? 'nomade');
      reason = `heavy task, promoted to ${agent}. ${reason}`;
    }
    const brief = (parsed.brief ?? '').trim() || task;
    // Pedido explícito de busca vence a opinião do modelo.
    const asked =
      /(pesquis\w*|\bbusca(r)? (na|no|sobre)\b|\bprocur\w* (na|no) (web|internet|google)|\bsearch\b|\bgoogle\b|\blook up\b|\binternet\b|\bna web\b|\bon the web\b|not[ií]cias?|\bnews\b|\bhoje\b|\btoday\b|cota[cç][aã]o|pre[cç]o atual|\bcurrent price\b|[uú]ltima vers[aã]o|mais recente|\blatest\b|\bmost recent\b|\bCVE-\d{4})/i.test(
        task,
      );
    const web = Boolean(parsed.web) || asked;
    const query = web ? (parsed.query ?? '').trim() || task.slice(0, 120) : '';
    return { agent, complexity, reason, brief, web, query, suggested, model, ms: Date.now() - started };
  }

  /**
   * Pesquisa na web: busca, lê as melhores páginas em paralelo e monta um contexto numerado [1], [2]...
   * O contexto serve tanto para o próprio Nomade responder quanto para anexar ao brief de um agente grande.
   */
  async research(query: string, opts: { results?: number; read?: number } = {}): Promise<Research> {
    const started = Date.now();
    const { provider, results } = await search(query, opts.results ?? 6);
    // A NVD já devolve a descrição completa do CVE; as páginas dela dependem de JavaScript.
    const toRead = provider === 'nvd' ? [] : results.slice(0, opts.read ?? 3);
    const pages = await Promise.allSettled(toRead.map((r) => readPage(r.url, 3500)));
    const sources: ResearchSource[] = results.map((r, i) => {
      const page = i < pages.length ? pages[i] : undefined;
      return page?.status === 'fulfilled' && page.value.text.length > 200
        ? { ...r, read: true, excerpt: page.value.text }
        : { ...r, read: false, excerpt: r.snippet };
    });
    const context = sources
      .filter((s) => s.excerpt)
      .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.excerpt}`)
      .join('\n\n');
    return { query, provider, sources, context, ms: Date.now() - started };
  }

  /** Direct Nomade answer; with `context` (web search) it answers citing the sources. */
  async answer(task: string, context?: string, opts: { model?: string } = {}): Promise<{ text: string; model: string; ms: number }> {
    const started = Date.now();
    const messages: ChatMessage[] = context
      ? [
          {
            role: 'system',
            content:
              'You are Nomade, an ethical hacker and information-security specialist. Answer using the web sources below. ' +
              'Cite sources with [n] right after each claim. For vulnerabilities, cover: what it is, CVSS/severity, what is affected, ' +
              'how to detect and how to mitigate. If the sources do not answer, say so plainly instead of inventing. ' +
              "Be direct, in the user's language.\n\nSources:\n" +
              context.slice(0, 11_000),
          },
          { role: 'user', content: task },
        ]
      : [{ role: 'user', content: task }];
    const r = await this.chat(messages, { maxTokens: 1024, timeoutMs: 120_000, ctx: 4096, ...(opts.model ? { model: opts.model } : {}) });
    return { ...r, ms: Date.now() - started };
  }

  /**
   * One turn of the agent loop. Runs the model, then parses its message:
   * `tool` set => it wants a tool; `tool` null => `content` is the final answer.
   * Stateless — the caller (client) keeps the running transcript in `messages`.
   */
  async agentStep(
    messages: unknown[],
    opts: { model?: string } = {},
  ): Promise<{ content: string; tool: ParsedToolCall | null; model: string }> {
    const { model } = await this.resolve(opts.model);
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: AGENT_SYSTEM }, ...messages],
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0.15, num_ctx: 8192, num_predict: 1024 },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const json = (await res.json()) as { message?: { content?: string }; error?: string };
    if (!res.ok || json.error) throw new Error(`Nomade agent (${model}) failed: ${json.error ?? `HTTP ${res.status}`}`);
    const content = (json.message?.content ?? '').trim();
    return { content, tool: parseToolCall(content), model };
  }

  /** Summarize a big agent's answer into at most 3 bullets. */
  async digest(task: string, output: string, opts: { model?: string } = {}): Promise<{ text: string; model: string; ms: number }> {
    const started = Date.now();
    const clipped = output.length > 12_000 ? `${output.slice(0, 6_000)}\n…\n${output.slice(-6_000)}` : output;
    const r = await this.chat(
      [
        {
          role: 'system',
          content:
            "You are Nomade, a security specialist. Summarize the answer below in at most 3 short bullets (starting with \"- \"), in the user's language. Highlight the risks found, what was done, and the next security step if any. Nothing but the bullets.",
        },
        { role: 'user', content: `Task:\n${task}\n\nAgent answer:\n${clipped}` },
      ],
      { maxTokens: 220, timeoutMs: 60_000, ...(opts.model ? { model: opts.model } : {}) },
    );
    return { ...r, ms: Date.now() - started };
  }
}
