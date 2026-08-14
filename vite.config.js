import { defineConfig, loadEnv } from 'vite';

// Relative base so the built site works at any GitHub Pages sub-path
// (e.g. https://<user>.github.io/titanom_hack_2026/) without hard-coding it.
export default defineConfig(({ mode }) => {
  // Load *all* env vars (the '' prefix includes non-VITE_ ones). The Langfuse
  // keys are intentionally NOT prefixed VITE_ so Vite never bundles them into
  // the client — they're used only here, server-side, to sign the dev proxy.
  const env = loadEnv(mode, process.cwd(), '');
  const lfBase = (env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/$/, '');
  const lfAuth =
    env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
      ? 'Basic ' + Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')
      : null;

  return {
    base: './',
    server: {
      host: true, // expose on the LAN so a phone can reach the dev server
      // Both upstreams below reject browser CORS, so the browser can't call them
      // directly. In dev, the app hits these local paths and Vite forwards them
      // server-side — which also lets us attach secrets the client never sees.
      proxy: {
        // DeutschlandGPT (the AI tutor brain).
        '/dgpt-api': {
          target: 'https://api.deutschlandgpt.de',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/dgpt-api/, '/v2'),
        },
        // Langfuse ingestion. Inject Basic auth here so the browser sends
        // telemetry credential-free (secret key stays on this Node process).
        '/lf-api': {
          target: lfBase,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/lf-api/, ''),
          ...(lfAuth ? { headers: { Authorization: lfAuth } } : {}),
        },
      },
    },
  };
});
