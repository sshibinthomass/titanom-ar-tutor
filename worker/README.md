# Secret-holding proxy (Cloudflare Worker)

**Only Langfuse needs this.** Its ingestion API authenticates with a *secret*
key we must never ship in public JS, so the browser posts credential-free
batches here and the Worker signs them.

OpenAI serves CORS, so the app calls `api.openai.com` straight from the page and
needs no proxy at all. The `/openai` passthrough below is offered anyway,
because a static site otherwise carries a billable OpenAI key in its bundle —
route through the Worker and the key stays a Worker secret.

| Path | Upstream | Auth injected |
|------|----------|---------------|
| `/langfuse/*` | `https://cloud.langfuse.com/*` | Basic `PUBLIC:SECRET` |
| anything else | `https://api.openai.com/v1/*` (path forwarded as-is) | Bearer `OPENAI_API_KEY` |

## Deploy (one time, ~3 min)

```bash
npx wrangler login
```

```bash
cd worker && npx wrangler deploy
```

```bash
cd worker && npx wrangler secret put LANGFUSE_PUBLIC_KEY
```

```bash
cd worker && npx wrangler secret put LANGFUSE_SECRET_KEY
```

```bash
cd worker && npx wrangler secret put OPENAI_API_KEY
```

Deploy prints a URL like `https://ai-proxy.<your-subdomain>.workers.dev`.

> ⚠️ The Worker used to be named `dgpt-proxy`. If you deployed that one, this
> deploy creates a **new** Worker at a new URL — update
> `VITE_LANGFUSE_BASE_URL` to match, and delete the old one
> (`npx wrangler delete --name dgpt-proxy`).

## Point the app at it

Add repo Secrets so the deployed site reaches the Worker:

```bash
gh secret set VITE_LANGFUSE_BASE_URL --repo sshibinthomass/titanom-ar-tutor
```

Paste `https://ai-proxy.<your-subdomain>.workers.dev/langfuse`.

Optionally route the AI through it too — then drop `VITE_OPENAI_API_KEY` from
the repo Secrets, or the bundle keeps its own copy of the key:

```bash
gh secret set VITE_OPENAI_BASE_URL --repo sshibinthomass/titanom-ar-tutor
```

Paste `https://ai-proxy.<your-subdomain>.workers.dev`.

Never set any `LANGFUSE_*` key as a repo secret — the Worker supplies those, so
they stay private. Then re-run the deploy workflow.

## Quick test

Langfuse (should return a 207 multi-status JSON with CORS headers):

```bash
curl -X POST https://ai-proxy.<your-subdomain>.workers.dev/langfuse/api/public/ingestion -H "Content-Type: application/json" -d '{"batch":[{"id":"test-1","type":"trace-create","timestamp":"2026-08-14T00:00:00Z","body":{"id":"t1","name":"curl-test"}}]}'
```

OpenAI:

```bash
curl -X POST https://ai-proxy.<your-subdomain>.workers.dev/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Say OK"}],"max_completion_tokens":10}'
```
