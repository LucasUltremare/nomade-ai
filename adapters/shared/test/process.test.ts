import { describe, expect, it } from 'vitest';
import { ProcessTimeoutError, parseVersion, runProcess, which } from '../src/process.ts';

describe('runProcess', () => {
  it('captures stdout and passes stdin without a shell', async () => {
    const r = await runProcess('cat', [], { stdin: 'hello $(not-a-shell) `x`' });
    expect(r.stdout).toBe('hello $(not-a-shell) `x`');
    expect(r.exitCode).toBe(0);
  });

  it('kills the process tree on timeout', async () => {
    const started = Date.now();
    await expect(runProcess('sleep', ['30'], { timeoutMs: 200 })).rejects.toBeInstanceOf(ProcessTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(runProcess('definitely-not-a-binary-xyz', [])).rejects.toThrow();
  });
});

describe('which', () => {
  it('finds node', async () => {
    expect(await which('node')).toBeTruthy();
  });
  it('returns undefined for missing binaries', async () => {
    expect(await which('definitely-not-a-binary-xyz')).toBeUndefined();
  });
});

describe('parseVersion', () => {
  it('extracts semver', () => {
    expect(parseVersion('codex-cli 0.164.0')).toBe('0.164.0');
    expect(parseVersion('2.1.306 (Claude Code)')).toBe('2.1.306');
    expect(parseVersion('nope')).toBeUndefined();
  });
});
