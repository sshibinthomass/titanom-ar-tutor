/**
 * Cloudflare Worker — secret-holding proxy for the deployed site.
 *
 * Only one upstream *needs* this: **Langfuse** ingestion authenticates with a
 * secret key, which must never ship in public JS. OpenAI serves CORS, so the
 * bundle calls it directly and this Worker is optional for the AI — but routing
 * OpenAI through it too keeps the (billable) OpenAI key off a static site,
 * which is the only reason the /openai passthrough below exists.
 *
 * Routes (by path):
 *   /langfuse/*   → https://cloud.langfuse.com/*   (Basic auth = public:secret)
 *   anything else → https://api.openai.com/v1/*    (Bearer OPENAI_API_KEY)
 *
 * Deploy:
 *   cd worker
 *   npx wrangler deploy
 *   npx wrangler secret put LANGFUSE_PUBLIC_KEY    # pk-lf-...
 *   npx wrangler secret put LANGFUSE_SECRET_KEY    # sk-lf-...
 *   npx wrangler secret put OPENAI_API_KEY         # only if you proxy OpenAI too
 *
 * Then in the app:
 *   VITE_LANGFUSE_BASE_URL = https://ai-proxy.<subdomain>.workers.dev/langfuse
 *   VITE_OPENAI_BASE_URL   = https://ai-proxy.<subdomain>.workers.dev   (optional)
 *   (with the latter set, do NOT set VITE_OPENAI_API_KEY — the Worker supplies it)
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const LANGFUSE_ORIGIN = 'https://cloud.langfuse.com';
const OPENAI_ORIGIN = 'https://api.openai.com/v1';

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

    // ── OpenAI passthrough ────────────────────────────────────────────────
    // The path is forwarded as-is, so /chat/completions and
    // /audio/transcriptions both land on the right endpoint. Prefer the
    // Worker's own secret; fall back to a client-sent header.
    const auth = env.OPENAI_API_KEY
      ? `Bearer ${env.OPENAI_API_KEY}`
      : request.headers.get('Authorization') || '';

    // Multipart (STT) must keep the client's Content-Type — it carries the
    // boundary — and the body bytes must pass through untouched.
    const contentType = request.headers.get('Content-Type') || 'application/json';
    const isMultipart = contentType.startsWith('multipart/');
    const upstream = await fetch(`${OPENAI_ORIGIN}${url.pathname}${url.search}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: auth },
      body: isMultipart ? await request.arrayBuffer() : await request.text(),
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
