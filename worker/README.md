# CORS + secret-injecting proxy (Cloudflare Worker)

Two of our upstreams can't be called from the browser directly:

- **DeutschlandGPT** sends no CORS headers.
- **Langfuse** ingestion needs a *secret* key we must never ship in public JS.

This one tiny Worker fronts both. It adds CORS and injects the credentials
(held as Worker secrets), so no key ever reaches the browser. It routes by path:

| Path | Upstream | Auth injected |
|------|----------|---------------|
| `/langfuse/*` | `https://cloud.langfuse.com/*` | Basic `PUBLIC:SECRET` |
| anything else | DeutschlandGPT chat completions | Bearer `DGPT_API_KEY` |

## Deploy (one time, ~3 min)

```bash
cd worker
npx wrangler login          # opens the browser to log into Cloudflare (free account)
npx wrangler deploy         # prints your Worker URL
npx wrangler secret put DGPT_API_KEY          # DeutschlandGPT key
npx wrangler secret put LANGFUSE_PUBLIC_KEY   # pk-lf-...
npx wrangler secret put LANGFUSE_SECRET_KEY   # sk-lf-...
```

It prints a URL like `https://dgpt-proxy.<your-subdomain>.workers.dev`.

## Point the app at it

Add repo Secrets so the deployed site calls the Worker instead of the upstreams:

```bash
gh secret set VITE_DGPT_BASE_URL --repo sshibinthomass/titanom-ar-tutor
# paste: https://dgpt-proxy.<your-subdomain>.workers.dev

gh secret set VITE_LANGFUSE_BASE_URL --repo sshibinthomass/titanom-ar-tutor
# paste: https://dgpt-proxy.<your-subdomain>.workers.dev/langfuse
```

Do **not** set `VITE_DGPT_API_KEY` or any `LANGFUSE_*` key as a repo secret — the
Worker supplies them, so they stay private. Then re-run the deploy workflow.

## Quick test

DeutschlandGPT:

```bash
curl -X POST https://dgpt-proxy.<your-subdomain>.workers.dev/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"Say OK"}],"max_completion_tokens":10}'
```

Langfuse (should return a 207 multi-status JSON with CORS headers):

```bash
curl -X POST https://dgpt-proxy.<your-subdomain>.workers.dev/langfuse/api/public/ingestion \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"id":"test-1","type":"trace-create","timestamp":"2026-08-14T00:00:00Z","body":{"id":"t1","name":"curl-test"}}]}'
```
