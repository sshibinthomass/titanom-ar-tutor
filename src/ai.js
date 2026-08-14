/**
 * DeutschlandGPT client.
 * Docs: https://titanom.deutschlandgpt.de/docs/platform-api/createChatCompletion
 *   POST https://api.deutschlandgpt.de/v2/chat/completions
 *   Authorization: Bearer <key>
 *   body: { model, messages, temperature, max_completion_tokens, ... }
 *   text at: choices[0].message.content
 *
 * Only the API key is required — the base URL and model default sensibly.
 * Available models include: claude-4.5-sonnet, gpt-4o, gemini-2.5-flash.
 */
// DeutschlandGPT has no CORS, so the browser cannot call it directly.
//  • dev:  Vite proxies /dgpt-api → api.deutschlandgpt.de/v2 (see vite.config.js)
//  • prod: set VITE_DGPT_BASE_URL to a CORS-enabled proxy/Worker URL (see worker/)
const BASE_ENV = import.meta.env.VITE_DGPT_BASE_URL;
const BASE = (BASE_ENV || (import.meta.env.DEV ? '/dgpt-api' : 'https://api.deutschlandgpt.de/v2')).replace(/\/$/, '');
const KEY = import.meta.env.VITE_DGPT_API_KEY;
const MODEL = import.meta.env.VITE_DGPT_MODEL || 'claude-4.5-sonnet';

// Available if we have a key, or a custom endpoint (proxy/Worker) that adds auth itself.
export function aiAvailable() {
  return !!(KEY || BASE_ENV);
}

/**
 * Send chat messages, return the assistant's text.
 * messages: [{ role: 'system'|'user'|'assistant', content }]
 *
 * Pass a Langfuse trace handle (from telemetry.startTrace) as `trace` to record
 * this call as a generation — model, I/O, token usage and latency all land in
 * Langfuse. It's optional; without it the call is untraced but identical.
 */
export async function chat(messages, { temperature = 0.4, maxTokens = 320, trace = null, name = 'deutschlandgpt' } = {}) {
  if (!aiAvailable()) throw new Error('DeutschlandGPT not configured (set VITE_DGPT_API_KEY)');
  const startTime = new Date().toISOString();
  const modelParameters = { temperature, max_completion_tokens: maxTokens };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Send the key only if we have one; a key-holding Worker adds it instead.
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_completion_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `DeutschlandGPT ${res.status}: ${body.slice(0, 200)}`;
    trace?.generation({ name, model: MODEL, modelParameters, input: messages, startTime, level: 'ERROR', statusMessage: msg });
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  trace?.generation({ name, model: MODEL, modelParameters, input: messages, output: text, usage: data.usage, startTime });
  return text;
}
