import { defineConfig } from 'vite';

// Relative base so the built site works at any GitHub Pages sub-path
// (e.g. https://<user>.github.io/titanom_hack_2026/) without hard-coding it.
export default defineConfig({
  base: './',
  server: {
    host: true, // expose on the LAN so a phone can reach the dev server
    // DeutschlandGPT has no CORS, so the browser can't call it directly.
    // In dev, the app calls /dgpt-api/* and Vite forwards it server-side.
    proxy: {
      '/dgpt-api': {
        target: 'https://api.deutschlandgpt.de',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/dgpt-api/, '/v2'),
      },
    },
  },
});
