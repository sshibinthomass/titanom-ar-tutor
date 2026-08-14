/**
 * Cloudflare Worker — CORS proxy for DeutschlandGPT.
 *
 * DeutschlandGPT's API sends no CORS headers, so a browser (e.g. the GitHub
 * Pages site) can't call it directly. This Worker forwards the request and adds
 * CORS. It also holds the API key as a secret, so the key never ships in the
 * public web bundle.
 *
 * Deploy:
 *   cd worker
 *   npx wrangler deploy
 *   npx wrangler secret put DGPT_API_KEY      # paste your DeutschlandGPT key
 *
 * Then set the app's VITE_DGPT_BASE_URL to the Worker URL it prints, e.g.
 *   https://dgpt-proxy.<your-subdomain>.workers.dev
 * and DO NOT set VITE_DGPT_API_KEY in the app (the Worker supplies it).
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: CORS });
    }
    // Prefer the Worker's own secret key; fall back to a client-sent header.
    const auth = env.DGPT_API_KEY
      ? `Bearer ${env.DGPT_API_KEY}`
      : request.headers.get('Authorization') || '';

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
