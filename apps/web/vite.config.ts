import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Local-first: everything is bundled; the dev server proxies the API to the local Hono server. */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  preview: { host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
