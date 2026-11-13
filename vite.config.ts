import { defineConfig } from 'vite';

// Client lives in src/client (index.html there). The Worker is built/served by wrangler.
// Dev: run `npm run dev:worker` (wrangler on :8787) and `npm run dev` (vite on :5173, proxies /api).
export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
});
