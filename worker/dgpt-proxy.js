/**
 * Cloudflare Worker — CORS + secret-injecting proxy for the deployed site.
 *
 * The GitHub Pages bundle can't call these APIs directly: DeutschlandGPT sends
 * no CORS headers, and Langfuse ingestion needs a *secret* key we must never
 * ship in public JS. This Worker adds CORS and injects the credentials, held as
 * Worker secrets, so no key ever reaches the browser.
 *
 * Routes (by path):
 *   /langfuse/*             → https://cloud.langfuse.com/*   (Basic auth = public:secret)
 *   /audio/transcriptions   → DeutschlandGPT Whisper STT (multipart passthrough)
 *   everything else         → DeutschlandGPT chat completions (Bearer key)
 *
 * Deploy:
 *   cd worker
 *   npx wrangler deploy
 *   npx wrangler secret put DGPT_API_KEY          # DeutschlandGPT key
 *   npx wrangler secret put LANGFUSE_PUBLIC_KEY    # pk-lf-...
 *   npx wrangler secret put LANGFUSE_SECRET_KEY    # sk-lf-...
 *
 * Then in the app:
 *   VITE_DGPT_BASE_URL     = https://dgpt-proxy.<subdomain>.workers.dev
 *   VITE_LANGFUSE_BASE_URL = https://dgpt-proxy.<subdomain>.workers.dev/langfuse
 *   (and do NOT set VITE_DGPT_API_KEY — the Worker supplies it)
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const LANGFUSE_ORIGIN = 'https://cloud.langfuse.com';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Langfuse ingestion ────────────────────────────────────────────────
    // Strip the /langfuse prefix and forward the rest (e.g. /api/public/ingestion).
    if (url.pathname === '/langfuse' || url.pathname.startsWith('/langfuse/')) {
      if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
        return new Response('Langfuse keys not configured', { status: 501, headers: CORS });
      }
      const rest = url.pathname.slice('/langfuse'.length) || '/';
      const auth = 'Basic ' + btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`);
      const upstream = await fetch(`${LANGFUSE_ORIGIN}${rest}${url.search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: await request.text(),
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Prefer the Worker's own secret key; fall back to a client-sent header.
    const auth = env.DGPT_API_KEY
      ? `Bearer ${env.DGPT_API_KEY}`
      : request.headers.get('Authorization') || '';

    // ── DeutschlandGPT speech-to-text (Whisper) ───────────────────────────
    // Multipart passthrough: keep the client's Content-Type (it carries the
    // multipart boundary) and forward the body bytes untouched.
    if (url.pathname.startsWith('/audio/')) {
      const upstream = await fetch(`https://api.deutschlandgpt.de/v2${url.pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
          Authorization: auth,
        },
        body: await request.arrayBuffer(),
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // ── DeutschlandGPT chat (default) ─────────────────────────────────────
    const upstream = await fetch('https://api.deutschlandgpt.de/v2/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: await request.text(),
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
