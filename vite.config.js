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
      // OpenAI and ElevenLabs both serve CORS, so the app calls them straight
      // from the page — in dev exactly as in the deployed build. The only
      // upstream that still needs a hop is Langfuse, and not for CORS: its
      // ingestion API wants a *secret* key, which we attach here so the browser
      // never holds it.
      proxy: {
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
