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
const MODEL = import.meta.env.VITE_OPENAI_MODEL || 'gpt-5.6-terra';
// The Fix planner's model. Planning is a one-shot structured task where quality
// beats latency (the user watches a "…planning" card, not a silent pause in
// speech), so it gets the stronger model; conversational answers stay on the
// faster default above. Sol earns that slot but is *slow* — a Markus gas-lift
// plan measured ~90-120 s end to end, most of it hidden reasoning. That is
// survivable only because the card says "…planning"; don't point a spoken path
// at it.
export const PLAN_MODEL = import.meta.env.VITE_OPENAI_PLAN_MODEL || 'gpt-5.6-sol';
// The home screen's object scan (vision.js) sends an image content part, so this
// model must be multimodal — the default is (verified against the live API), but
// a deployment that points VITE_OPENAI_MODEL at a text-only model needs this
// override or the scan 400s.
export const VISION_MODEL = import.meta.env.VITE_OPENAI_VISION_MODEL || MODEL;
// Speech-to-text model for /audio/transcriptions. gpt-4o-transcribe is the
// newer, more accurate engine; whisper-1 and gpt-4o-mini-transcribe are the
// alternatives on the same endpoint. Note it hallucinates a short phrase on
// silence (whisper-1 does too) — voice.js's filler filter is what catches that.
const STT_MODEL = import.meta.env.VITE_OPENAI_STT_MODEL || 'gpt-4o-transcribe';

// ---- Model quirks -----------------------------------------------------------
// The reasoning tiers (the gpt-5.6 family here) differ from the 4.x line in two
// ways that break a caller which assumes plain chat completions. Both are
// *learned from the API* rather than hard-coded against model ids, so pointing
// VITE_OPENAI_MODEL at anything — older, newer, a proxy's own naming — keeps
// working. Same shape as tts.js dropping `language_code` for a voice model that
// won't take it: try, notice, remember, never pay for it twice.
//
//  1. They reject a custom `temperature` outright (400 unsupported_value; only
//     the default 1 is allowed), so every call in this app would fail.
//  2. Hidden reasoning tokens are spent from the *same* `max_completion_tokens`
//     budget. A caller's tight cap is then consumed entirely by thinking and the
//     reply comes back an empty string with finish_reason 'length' — silent, and
//     indistinguishable downstream from "the model had nothing to say".
const quirks = new Map(); // model id → { noTemperature, reserve }
// Headroom added once we know a model thinks before answering. Sized against
// the observed spend (a 6-step plan reasoned ~900 tokens) with room over.
const REASONING_RESERVE = 1024;

function quirksFor(model) {
  let q = quirks.get(model);
  if (!q) quirks.set(model, (q = { noTemperature: false, reserve: 0 }));
  return q;
}

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
  const q = quirksFor(model);

  // One attempt, shaped by what we've learned about this model so far.
  const post = () => {
    const body = { model, messages, max_completion_tokens: maxTokens + q.reserve };
    if (!q.noTemperature) body.temperature = temperature;
    return fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Send the key only if we have one; a key-holding Worker adds it instead.
        ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (res) => ({ res, body: res.ok ? null : await res.text().catch(() => '') }));
  };

  let { res, body } = await post();

  // Quirk 1: the model won't take our temperature. Drop it for good and retry.
  if (!res.ok && res.status === 400 && !q.noTemperature && /temperature/i.test(body || '')) {
    q.noTemperature = true;
    ({ res, body } = await post());
  }

  const modelParameters = { max_completion_tokens: maxTokens + q.reserve, ...(q.noTemperature ? {} : { temperature }) };
  if (!res.ok) {
    const msg = `OpenAI ${res.status}: ${(body || '').slice(0, 200)}`;
    trace?.generation({ name, model, modelParameters, input: messages, startTime, level: 'ERROR', statusMessage: msg });
    throw new Error(msg);
  }

  let data = await res.json();
  let text = (data.choices?.[0]?.message?.content || '').trim();

  // Quirk 2: thinking is billed against the same budget. Any sighting of
  // reasoning tokens sizes every later call to this model correctly; a reply
  // that came back *empty* because thinking ate the whole cap is retried here,
  // so the first call of a session doesn't silently return nothing. (The scan
  // asks for 12 tokens — on a reasoning model that is all reasoning, no answer.)
  const reasoned = (data.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0;
  const starved = !text && data.choices?.[0]?.finish_reason === 'length';
  if (!q.reserve && (reasoned || starved)) q.reserve = REASONING_RESERVE;
  if (starved) {
    ({ res, body } = await post());
    if (res.ok) {
      data = await res.json();
      text = (data.choices?.[0]?.message?.content || '').trim();
    }
  }

  trace?.generation({ name, model, modelParameters, input: messages, output: text, usage: data.usage, startTime });
  return text;
}
