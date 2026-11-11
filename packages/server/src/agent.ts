import { resolve } from 'node:path';
import { runProcess } from '@relay/adapter-shared';
import { readPage, search, searchNvd } from './web.ts';
import { isInside } from './config.ts';

/**
 * Hermes-style agent loop for Nomade: the model is given tools and drives itself.
 * The loop is CLIENT-driven and stateless on the server:
 *   - POST /api/agent/step  -> runs one model turn, returns the assistant message + any tool calls.
 *   - POST /api/agent/tool  -> executes ONE tool and returns its result string.
 * The client keeps the transcript (so multi-turn + persistence are free) and gates `run_command`
 * behind user approval before calling /api/agent/tool for it.
 */

export const READ_TOOLS = ['web_search', 'read_url', 'nvd_lookup'] as const;
export const SHELL_TOOL = 'run_command';
export type ToolName = (typeof READ_TOOLS)[number] | typeof SHELL_TOOL;

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information (news, docs, advisories, prices, versions). Returns titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Short search query, 3-8 words.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: 'Fetch a public web page and return its main text. Use after web_search to read a result in detail.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nvd_lookup',
      description: 'Look up vulnerabilities in the NIST NVD. Pass a CVE id (e.g. CVE-2024-3094) or product keywords. Returns CVE id, CVSS, date and description.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'CVE id or product keywords.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the project directory to inspect or act on the system (e.g. ls, cat, nmap, grep, git). The user must approve each command before it runs. Prefer read-only commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact command line to run.' },
          why: { type: 'string', description: 'One short sentence: why this command.' },
        },
        required: ['command'],
      },
    },
  },
] as const;

export interface ToolResult {
  result: string;
  /** Extra structured payload for the UI (e.g. search sources), optional. */
  data?: unknown;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

/** Execute one tool. `run_command` is only reached after the client got user approval. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { roots: string[]; defaultCwd: string; cwd?: string },
): Promise<ToolResult> {
  switch (name) {
    case 'web_search': {
      const query = String(args['query'] ?? '').trim();
      if (!query) return { result: 'error: empty query' };
      const { provider, results } = await search(query, 6);
      const lines = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
      return { result: `source: ${provider}\n\n${lines || 'no results'}`, data: { provider, results } };
    }
    case 'read_url': {
      const url = String(args['url'] ?? '').trim();
      if (!url) return { result: 'error: empty url' };
      const page = await readPage(url, 6000);
      return { result: `${page.title}\n${page.url}\n\n${page.text}`, data: { url: page.url, title: page.title } };
    }
    case 'nvd_lookup': {
      const query = String(args['query'] ?? '').trim();
      if (!query) return { result: 'error: empty query' };
      const results = await searchNvd(query, 6);
      const lines = results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
      return { result: lines || 'no CVE found', data: { results } };
    }
    case 'run_command': {
      const command = String(args['command'] ?? '').trim();
      if (!command) return { result: 'error: empty command' };
      const cwd = resolve(ctx.cwd ?? ctx.defaultCwd);
      if (!ctx.roots.some((r) => isInside(cwd, r))) {
        return { result: `error: cwd outside allowed roots (${ctx.roots.join(', ')})` };
      }
      // No shell: run via the OS shell binary explicitly so the model can use a normal command line,
      // but the process itself is spawned without string interpolation into our own commands.
      const isWin = process.platform === 'win32';
      const file = isWin ? 'powershell.exe' : '/bin/sh';
      const cmdArgs = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      try {
        const r = await runProcess(file, cmdArgs, { cwd, timeoutMs: 60_000, maxBuffer: 256 * 1024 });
        const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        return {
          result: clip(out || `(no output, exit ${r.exitCode ?? '?'})`, 8000),
          data: { exitCode: r.exitCode, cwd },
        };
      } catch (err) {
        return { result: `error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    default:
      return { result: `error: unknown tool ${name}` };
  }
}

export const AGENT_SYSTEM = [
  'You are Nomade, a local ethical-hacking agent with tools.',
  '',
  'When you need information or an action, respond with ONE line of JSON and nothing else, like:',
  '{"tool":"web_search","args":{"query":"..."}}',
  '{"tool":"read_url","args":{"url":"https://..."}}',
  '{"tool":"nvd_lookup","args":{"query":"..."}}',
  '{"tool":"run_command","args":{"command":"...","why":"..."}}',
  '',
  'The system then runs that tool and sends you its output. Read the output, then either call another tool',
  'or write your final answer. Your final answer must be normal prose, NEVER JSON.',
  'run_command is executed only after the user approves it, so keep commands minimal and read-only when you can.',
  '',
  'Scope: authorized systems, labs, CTFs or the user\'s own machines only. Be direct and technical, no moralizing.',
  'Match the user\'s language (Portuguese or English). Cite web sources as [n] when you used them.',
].join('\n');

const KNOWN = new Set<string>([...READ_TOOLS, SHELL_TOOL]);

export interface ParsedToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

/**
 * Parse a tool call out of the model's message. We don't rely on Ollama native tool_calls
 * (abliterated builds don't declare tool support), so the model emits a JSON object by contract.
 * Only treats the message as a tool call when it is essentially just that JSON — prose is a final answer.
 */
export function parseToolCall(content: string): ParsedToolCall | null {
  let s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  if (!s.startsWith('{')) return null;
  // Take the first balanced {...} block.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(s.slice(0, end));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const name = String(o['tool'] ?? o['name'] ?? '');
  if (!KNOWN.has(name)) return null;
  const rawArgs = o['args'] ?? o['arguments'] ?? {};
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
  return { name: name as ToolName, args };
}
