// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b[78]|\x1b[PX^_][^\x1b]*\x1b\\/g;

/** Remove sequências ANSI/OSC e normaliza quebras de linha. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
}

/** Limpa saída de terminal para virar texto de handoff: tira ANSI, trailing spaces e colapsa linhas vazias repetidas. */
export function cleanTerminalOutput(input: string): string {
  return stripAnsi(input)
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Envolve texto em bracketed paste, para colar várias linhas numa TUI sem submeter a cada \n. */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
