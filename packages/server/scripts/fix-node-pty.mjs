// node-pty 1.1.0 publica prebuilds cujo `spawn-helper` (macOS) chega sem bit de execução
// → "posix_spawnp failed". Este script só restaura o chmod +x; não compila nada.
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

try {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const prebuilds = join(root, 'prebuilds');
  if (!existsSync(prebuilds)) process.exit(0);
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`[relay] chmod +x ${helper}`);
    }
  }
} catch (err) {
  console.warn('[relay] não foi possível ajustar node-pty/spawn-helper:', err?.message ?? err);
}
