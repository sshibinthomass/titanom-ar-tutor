/**
 * DeutschlandGPT client (OpenAI-compatible chat-completions).
 *
 * Config comes from Vite env (see .env.example). If no key is set, aiAvailable()
 * returns false and callers fall back to their authored content.
 */
const BASE = import.meta.env.VITE_DGPT_BASE_URL;
const KEY = import.meta.env.VITE_DGPT_API_KEY;
const MODEL = import.meta.env.VITE_DGPT_MODEL || 'deutschlandgpt';

export function aiAvailable() {
  return !!(BASE && KEY);
}

/**
 * Send chat messages, return the assistant's text.
 * messages: [{ role: 'system'|'user'|'assistant', content }]
 */
export async function chat(messages, { temperature = 0.4, maxTokens = 320 } = {}) {
  if (!aiAvailable()) throw new Error('DeutschlandGPT not configured');
  const res = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeutschlandGPT ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}
