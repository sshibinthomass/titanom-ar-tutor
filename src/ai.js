/**
 * OpenAI client — the tutor's brain (chat, vision, and the STT fallback).
 * Docs: https://platform.openai.com/docs/api-reference/chat
 *   POST https://api.openai.com/v1/chat/completions
 *   Authorization: Bearer <key>
 *   body: { model, messages, temperature, max_completion_tokens, ... }
 *   text at: choices[0].message.content
 *
 * Only the API key is required — the base URL and models default sensibly.
 *
 * **Called straight from the browser, in dev and in prod alike.** OpenAI serves
 * CORS (`Access-Control-Allow-Origin: *` on /v1/*, verified against the live
 * API), so unlike the old proxied backend there is no dev-proxy or Worker hop:
 * one request, from the page, on GitHub Pages as well as localhost. Set
 * VITE_OPENAI_BASE_URL to a key-holding proxy (see worker/) if you'd rather the
 * key never reached the bundle — the client then sends no Authorization header
 * and the proxy adds it.
 */
const BASE_ENV = import.meta.env.VITE_OPENAI_BASE_URL;
const BASE = (BASE_ENV || 'https://api.openai.com/v1').replace(/\/$/, '');
const KEY = import.meta.env.VITE_OPENAI_API_KEY;
const MODEL = import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o';
// The Fix planner's model. Planning is a one-shot structured task where quality
// beats latency (the user watches a "…planning" card, not a silent pause in
// speech), so it gets the stronger model; conversational answers stay on the
// faster default above.
//
// Why gpt-4.1 and not a reasoning model: every call here sends an explicit
// `temperature` and a `max_completion_tokens` budget sized for the plan's JSON.
// The reasoning tiers pin temperature to 1 and spend part of that budget on
// hidden reasoning tokens, which truncates long plans — exactly the failure
// parseTruncated() exists to survive, so don't invite it by default.
export const PLAN_MODEL = import.meta.env.VITE_OPENAI_PLAN_MODEL || 'gpt-4.1';
// The home screen's object scan (vision.js) sends an image content part, so this
// model must be multimodal — the default is, but a deployment that points
// VITE_OPENAI_MODEL at a text-only model needs this override or the scan 400s.
export const VISION_MODEL = import.meta.env.VITE_OPENAI_VISION_MODEL || MODEL;
// Speech-to-text model for /audio/transcriptions. whisper-1 is verified against
// the live API; gpt-4o-transcribe / gpt-4o-mini-transcribe are the newer
// alternatives on the same endpoint.
const STT_MODEL = import.meta.env.VITE_OPENAI_STT_MODEL || 'whisper-1';

// Available if we have a key, or a custom endpoint (proxy/Worker) that adds auth itself.
export function aiAvailable() {
  return !!(KEY || BASE_ENV);
}

// STT rides the same key/proxy as chat, so availability is the same question.
export function sttAvailable() {
  return aiAvailable();
}

/**
 * Transcribe a recorded utterance (a Blob from MediaRecorder) via the Whisper
 * endpoint. Returns the transcript text ('' if the clip contained no speech).
 * The filename extension matters: the server sniffs the container from it, so
 * pass one that matches the recorder's mime type.
 */
export async function transcribe(blob, { filename = 'utterance.webm', language = null, trace = null } = {}) {
  if (!aiAvailable()) throw new Error('OpenAI not configured (set VITE_OPENAI_API_KEY)');
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', STT_MODEL);
  // ISO-639-1 language hint. The app is monolingual per selection, so telling
  // Whisper which language to expect is both more accurate on short clips and
  // enforces the product rule.
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
    const msg = `OpenAI STT ${res.status}: ${body.slice(0, 200)}`;
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
export async function chat(messages, { temperature = 0.4, maxTokens = 320, trace = null, name = 'openai', model = MODEL } = {}) {
  if (!aiAvailable()) throw new Error('OpenAI not configured (set VITE_OPENAI_API_KEY)');
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
    const msg = `OpenAI ${res.status}: ${body.slice(0, 200)}`;
    trace?.generation({ name, model, modelParameters, input: messages, startTime, level: 'ERROR', statusMessage: msg });
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  trace?.generation({ name, model, modelParameters, input: messages, output: text, usage: data.usage, startTime });
  return text;
}
