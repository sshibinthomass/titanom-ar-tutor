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
const BASE = (import.meta.env.VITE_DGPT_BASE_URL || 'https://api.deutschlandgpt.de/v2').replace(/\/$/, '');
const KEY = import.meta.env.VITE_DGPT_API_KEY;
const MODEL = import.meta.env.VITE_DGPT_MODEL || 'claude-4.5-sonnet';

export function aiAvailable() {
  return !!KEY;
}

/**
 * Send chat messages, return the assistant's text.
 * messages: [{ role: 'system'|'user'|'assistant', content }]
 */
export async function chat(messages, { temperature = 0.4, maxTokens = 320 } = {}) {
  if (!aiAvailable()) throw new Error('DeutschlandGPT not configured (set VITE_DGPT_API_KEY)');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_completion_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeutschlandGPT ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}
