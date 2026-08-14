import { defineConfig } from 'vite';

// Relative base so the built site works at any GitHub Pages sub-path
// (e.g. https://<user>.github.io/titanom_hack_2026/) without hard-coding it.
export default defineConfig({
  base: './',
  server: {
    host: true, // expose on the LAN so a phone can reach the dev server
  },
});
