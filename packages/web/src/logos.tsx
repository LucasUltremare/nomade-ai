import type { AgentId } from './api.ts';

/**
 * Brand marks of each provider, drawn as simple monochrome SVGs (currentColor)
 * so they sit in the HUD. Used nominatively to identify the real CLI/provider.
 */

type LogoProps = { className?: string | undefined };

// Anthropic / Claude — the radial "spark" mark.
export function AnthropicMark({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M16.8 3h-3.1l5.6 18h3.1L16.8 3ZM7.2 3 1.6 21h3.2l1.14-3.46h6.0L13.1 21h3.2L10.7 3H7.2Zm-.18 11.3 2-6.06 2 6.06H7.02Z" />
    </svg>
  );
}

// OpenAI / Codex — the hexafoil knot (simplified).
export function OpenAIMark({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 7.2 7.2 9.8v4.8L12 17.2l4.8-2.6V9.8L12 7.2Z" />
      <path d="M12 7.2V3.4M12 17.2V21M7.2 9.8 3.9 7.9M20.1 16.1l-3.3-1.9M7.2 14.6l-3.3 1.9M20.1 7.9l-3.3 1.9" />
    </svg>
  );
}

// Google Gemini — the four-point sparkle.
export function GeminiMark({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M12 1.5c.4 5.6 4.9 10.1 10.5 10.5C16.9 12.4 12.4 16.9 12 22.5 11.6 16.9 7.1 12.4 1.5 12 7.1 11.6 11.6 7.1 12 1.5Z" />
    </svg>
  );
}

// Ollama — the llama head mark (simplified).
export function OllamaMark({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3c-.8 0-1.3.8-1.1 1.6L6.5 8C5 9 4 10.9 4 13v5.5C4 20 5 21 6.3 21H8v-3M17 3c.8 0 1.3.8 1.1 1.6L17.5 8C19 9 20 10.9 20 13v5.5C20 20 19 21 17.7 21H16v-3" />
      <path d="M8 18h8M8 13.5c0 2 1.8 3.5 4 3.5s4-1.5 4-3.5" />
    </svg>
  );
}

export function NomadeMark({ className }: LogoProps) {
  return <img src="/nomade-mark.png" alt="" className={className} aria-hidden="true" />;
}

export function AgentLogo({ id, className }: { id: AgentId; className?: string }) {
  switch (id) {
    case 'nomade':
      return <NomadeMark className={className} />;
    case 'claude-code':
      return <AnthropicMark className={className} />;
    case 'codex':
      return <OpenAIMark className={className} />;
    case 'gemini':
      return <GeminiMark className={className} />;
  }
}

export const VENDOR: Record<AgentId, string> = {
  nomade: 'Ultremare',
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
};
