import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env['RELAY_SERVER_URL'] ?? 'http://127.0.0.1:7357';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
