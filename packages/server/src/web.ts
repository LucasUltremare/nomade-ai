import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Acesso à internet para o Nomade:
 * - search(): busca via APIs oficiais. Ordem: SearXNG próprio (SEARXNG_URL), Ollama Web Search (OLLAMA_API_KEY),
 *   Brave (BRAVE_API_KEY) e, sempre, Wikipedia (sem chave).
 * - readPage(): baixa uma página e extrai o texto principal.
 * Só http/https, só endereços públicos (bloqueia localhost e redes privadas), com timeout e limite de tamanho.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageText {
  url: string;
  title: string;
  text: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? ENTITIES[e] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/* ---------- Busca: APIs oficiais, a primeira configurada vence ---------- */

export type SearchProviderId = 'nvd' | 'searxng' | 'ollama' | 'brave' | 'wikipedia';

/**
 * User-Agent identificável, como pedem as políticas da Wikimedia e da NVD.
 * Defina NOMADE_CONTACT (e-mail ou URL) para incluir um contato.
 */
function identUA(): string {
  const contact = process.env['NOMADE_CONTACT'];
  return `NomadeAgents/0.2 (self-hosted security assistant${contact ? `; ${contact}` : ''}) node-fetch`;
}

const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;

/**
 * NVD (NIST): base oficial de CVEs, API pública sem chave (NVD_API_KEY opcional aumenta o limite).
 * Usada quando a consulta cita um CVE ou fala de vulnerabilidade de um produto.
 */
export async function searchNvd(query: string, limit: number): Promise<SearchResult[]> {
  const ids = [...new Set((query.match(CVE_RE) ?? []).map((s) => s.toUpperCase()))];
  const params = ids[0]
    ? { cveId: ids[0] }
    : {
        keywordSearch: query.replace(/\b(cve|cves|vulnerabilidades?|vulnerabilit(y|ies)|falhas?|exploit|ultim[ao]s?|recentes?|de|do|da|no|na|em)\b/gi, ' ').replace(/\s+/g, ' ').trim(),
        resultsPerPage: String(Math.min(limit, 10)),
      };
  if ('keywordSearch' in params && !params.keywordSearch) return [];
  const key = process.env['NVD_API_KEY'];
  type NvdResponse = {
    totalResults?: number;
    vulnerabilities?: {
      cve: {
        id: string;
        published?: string;
        descriptions?: { lang: string; value: string }[];
        metrics?: Record<string, { cvssData?: { baseScore?: number; baseSeverity?: string } }[]>;
      };
    }[];
  };
  const nvd = (p: Record<string, string>) =>
    getJson<NvdResponse>(`https://services.nvd.nist.gov/rest/json/cves/2.0?${new URLSearchParams(p)}`, {
      headers: { 'user-agent': identUA(), ...(key ? { apiKey: key } : {}) },
    });
  let j = await nvd(params);
  // A NVD ordena do mais antigo para o mais novo: para palavra-chave, buscamos a última página (os mais recentes).
  const total = j.totalResults ?? 0;
  const perPage = Number((params as { resultsPerPage?: string }).resultsPerPage ?? 0);
  if (!ids[0] && perPage && total > perPage) j = await nvd({ ...params, startIndex: String(total - perPage) });
  return (j.vulnerabilities ?? [])
    .sort((a, b) => (b.cve.published ?? '').localeCompare(a.cve.published ?? ''))
    .slice(0, limit)
    .map(({ cve }) => {
      const desc = cve.descriptions?.find((d) => d.lang === 'en')?.value ?? '';
      const metric = Object.values(cve.metrics ?? {}).flat()[0]?.cvssData;
      const score = metric?.baseScore !== undefined ? `CVSS ${metric.baseScore} ${metric.baseSeverity ?? ''}`.trim() : 'CVSS n/d';
      return {
        title: `${cve.id} · ${score}${cve.published ? ` · ${cve.published.slice(0, 10)}` : ''}`,
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
        snippet: desc,
      };
    });
}

export const looksLikeVulnQuery = (q: string) => /\b(cve|vulnerabilidades?|vulnerabilit(y|ies)|exploit)\b/i.test(q);

interface SearchProvider {
  id: SearchProviderId;
  run(query: string, limit: number): Promise<SearchResult[]>;
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** SearXNG próprio (ex.: docker run -p 8888:8080 searxng/searxng), com `formats: [html, json]` no settings.yml. */
const searxng = (base: string): SearchProvider => ({
  id: 'searxng',
  async run(query, limit) {
    const u = new URL('/search', base);
    u.search = new URLSearchParams({ q: query, format: 'json', language: 'pt-BR' }).toString();
    const j = await getJson<{ results?: { title?: string; url?: string; content?: string }[] }>(u.toString());
    return (j.results ?? []).slice(0, limit).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: stripTags(r.content ?? '') }));
  },
});

/** Ollama Web Search (chave grátis em https://ollama.com/settings/keys). */
const ollamaSearch = (key: string): SearchProvider => ({
  id: 'ollama',
  async run(query, limit) {
    const j = await getJson<{ results?: { title?: string; url?: string; content?: string }[] }>('https://ollama.com/api/web_search', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, max_results: Math.min(limit, 10) }),
    });
    return (j.results ?? []).map((r) => ({ title: r.title ?? r.url ?? '', url: r.url ?? '', snippet: (r.content ?? '').slice(0, 400) }));
  },
});

/** Brave Search API (plano gratuito em https://brave.com/search/api/). */
const brave = (key: string): SearchProvider => ({
  id: 'brave',
  async run(query, limit) {
    const u = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`;
    const j = await getJson<{ web?: { results?: { title?: string; url?: string; description?: string }[] } }>(u, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
    });
    return (j.web?.results ?? []).map((r) => ({ title: stripTags(r.title ?? ''), url: r.url ?? '', snippet: stripTags(r.description ?? '') }));
  },
});

/** Wikipedia (API pública, sem chave): fallback sempre disponível. Tenta pt, depois en. */
const wikipedia: SearchProvider = {
  id: 'wikipedia',
  async run(query, limit) {
    for (const lang of ['pt', 'en']) {
      const u = `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
        action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', utf8: '1',
      })}`;
      const j = await getJson<{ query?: { search?: { title: string; snippet: string }[] } }>(u, {
        headers: { 'user-agent': identUA(), 'api-user-agent': identUA() },
      });
      const hits = j.query?.search ?? [];
      if (hits.length > 0) {
        return hits.map((h) => ({
          title: h.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
          snippet: stripTags(h.snippet),
        }));
      }
    }
    return [];
  },
};

export function searchProviders(env: NodeJS.ProcessEnv = process.env): SearchProvider[] {
  const list: SearchProvider[] = [];
  if (env['SEARXNG_URL']) list.push(searxng(env['SEARXNG_URL']));
  if (env['OLLAMA_API_KEY']) list.push(ollamaSearch(env['OLLAMA_API_KEY']));
  if (env['BRAVE_API_KEY']) list.push(brave(env['BRAVE_API_KEY']));
  list.push(wikipedia);
  return list;
}

/** Busca usando o primeiro provedor que responder com resultados. Consultas de vulnerabilidade vão primeiro à NVD. */
export async function search(query: string, limit = 6): Promise<{ provider: SearchProviderId; results: SearchResult[] }> {
  const errors: string[] = [];
  if (looksLikeVulnQuery(query)) {
    try {
      const results = await searchNvd(query, limit);
      if (results.length > 0) return { provider: 'nvd', results };
    } catch (err) {
      errors.push(`nvd: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const p of searchProviders()) {
    try {
      const results = (await p.run(query, limit)).filter((r) => /^https?:\/\//.test(r.url));
      if (results.length > 0) return { provider: p.id, results };
    } catch (err) {
      errors.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length) throw new Error(`busca falhou (${errors.join('; ')})`);
  return { provider: 'wikipedia', results: [] };
}

/* ---------- Segurança: só endereços públicos ---------- */

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`protocolo não permitido: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('endereço local bloqueado');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error('endereço privado bloqueado');
  return url;
}

/* ---------- Leitura de página ---------- */

export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  // Prefere <main>/<article> quando existe; senão o <body> inteiro.
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|br|pre|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return { title, text };
}

export async function readPage(raw: string, maxChars = 6000): Promise<PageText> {
  let url = await assertPublicUrl(raw);
  let res: Response | undefined;
  // Redirecionamentos manuais, revalidando cada destino.
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`tipo não suportado: ${type || 'desconhecido'}`);

  // Lê no máximo MAX_PAGE_BYTES.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (size < MAX_PAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  const { title, text } = type.includes('text/plain') ? { title: url.hostname, text: body } : htmlToText(body);
  return { url: url.toString(), title: title || url.hostname, text: text.slice(0, maxChars) };
}
