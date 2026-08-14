# DeutschlandGPT CORS proxy (Cloudflare Worker)

DeutschlandGPT's API has **no CORS**, so the browser (GitHub Pages site) can't
call it directly. This tiny Worker proxies the request, adds CORS, and holds the
API key as a secret so it never ships in the public bundle.

## Deploy (one time, ~3 min)

```bash
cd worker
npx wrangler login          # opens the browser to log into Cloudflare (free account)
npx wrangler deploy         # prints your Worker URL
npx wrangler secret put DGPT_API_KEY   # paste your DeutschlandGPT key when prompted
```

It prints a URL like `https://dgpt-proxy.<your-subdomain>.workers.dev`.

## Point the app at it

Add a repo Secret so the deployed site calls the Worker instead of DGPT directly:

```bash
gh secret set VITE_DGPT_BASE_URL --repo sshibinthomass/titanom-ar-tutor
# paste: https://dgpt-proxy.<your-subdomain>.workers.dev
```

Do **not** set `VITE_DGPT_API_KEY` as a repo secret — the Worker supplies the key,
so it stays private. Then re-run the deploy workflow.

## Quick test

```bash
curl -X POST https://dgpt-proxy.<your-subdomain>.workers.dev/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-4.5-sonnet","messages":[{"role":"user","content":"Say OK"}],"max_completion_tokens":10}'
```

Should return a JSON completion with CORS headers.
