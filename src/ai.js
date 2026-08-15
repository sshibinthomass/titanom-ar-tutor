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
// The Fix planner's model. Planning is a one-shot structured task where quality
// beats latency (the user watches a "…planning" card, not a silent pause in
// speech), so it gets the strongest model; conversational answers stay on the
// faster default above.
export const PLAN_MODEL = import.meta.env.VITE_DGPT_PLAN_MODEL || 'claude-opus-5';
// Speech-to-text model for /audio/transcriptions. whisper-1 is verified against
// the live API; the platform also offers voxtral-mini-2507, chirp-3, scribe_v1/v2.
const STT_MODEL = import.meta.env.VITE_DGPT_STT_MODEL || 'whisper-1';

// Available if we have a key, or a custom endpoint (proxy/Worker) that adds auth itself.
export function aiAvailable() {
  return !!(KEY || BASE_ENV);
}

// STT rides the same key/proxy as chat, so availability is the same question.
export function sttAvailable() {
  return aiAvailable();
}

/**
 * Transcribe a recorded utterance (a Blob from MediaRecorder) via the
 * OpenAI-compatible Whisper endpoint. Returns the transcript text ('' if the
 * clip contained no speech). The filename extension matters: the server sniffs
 * the container from it, so pass one that matches the recorder's mime type.
 */
export async function transcribe(blob, { filename = 'utterance.webm', language = null, trace = null } = {}) {
  if (!aiAvailable()) throw new Error('DeutschlandGPT not configured (set VITE_DGPT_API_KEY)');
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', STT_MODEL);
  // ISO-639-1 language hint (the OpenAI-compatible `language` field). The app
  // is monolingual per selection, so telling Whisper which language to expect
  // is both more accurate on short clips and enforces the product rule.
  if (language) form.append('language', language);
  const startTime = new Date().toISOString();
  // No manual Content-Type — the browser must set the multipart boundary itself.
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `DeutschlandGPT STT ${res.status}: ${body.slice(0, 200)}`;
    trace?.generation({ name: 'stt', model: STT_MODEL, startTime, level: 'ERROR', statusMessage: msg });
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.text || '').trim();
  trace?.generation({ name: 'stt', model: STT_MODEL, output: text, startTime });
  return text;
}

/**
 * Send chat messages, return the assistant's text.
 * messages: [{ role: 'system'|'user'|'assistant', content }]
 *
 * Pass a Langfuse trace handle (from telemetry.startTrace) as `trace` to record
 * this call as a generation — model, I/O, token usage and latency all land in
 * Langfuse. It's optional; without it the call is untraced but identical.
 */
export async function chat(messages, { temperature = 0.4, maxTokens = 320, trace = null, name = 'deutschlandgpt', model = MODEL } = {}) {
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
    body: JSON.stringify({ model, messages, temperature, max_completion_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `DeutschlandGPT ${res.status}: ${body.slice(0, 200)}`;
    trace?.generation({ name, model, modelParameters, input: messages, startTime, level: 'ERROR', statusMessage: msg });
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  trace?.generation({ name, model, modelParameters, input: messages, output: text, usage: data.usage, startTime });
  return text;
}
