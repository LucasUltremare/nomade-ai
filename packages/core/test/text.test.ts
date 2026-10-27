import { describe, expect, it } from 'vitest';
import { bracketedPaste, cleanTerminalOutput, stripAnsi } from '../src/text.ts';

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07x')).toBe('red x');
  });
  it('normalizes CRLF', () => {
    expect(stripAnsi('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('cleanTerminalOutput', () => {
  it('trims and collapses blank lines', () => {
    expect(cleanTerminalOutput('\n\nfoo   \n\n\n\nbar \n')).toBe('foo\n\nbar');
  });
});

describe('bracketedPaste', () => {
  it('wraps text', () => {
    expect(bracketedPaste('x')).toBe('\x1b[200~x\x1b[201~');
  });
});
