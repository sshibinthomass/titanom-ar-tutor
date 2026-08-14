/**
 * Langfuse telemetry — traces the whole app: voice utterances, AI answers
 * (with model + token usage + latency), mode/model switches, AR events, TTS,
 * and errors.
 *
 * 🔐 Secrets never touch the browser. The client POSTs *credential-free* batches
 * to a proxy that injects Langfuse Basic auth server-side:
 *   • dev:  /lf-api/*  → the Vite proxy adds auth from LANGFUSE_* in .env
 *                        (non-VITE names ⇒ never bundled). See vite.config.js.
 *   • prod: VITE_LANGFUSE_BASE_URL → the Cloudflare Worker's /langfuse route,
 *                        which holds the keys as Worker secrets. See worker/.
 * If no base URL is resolvable, every export below is a graceful no-op, so the
 * app runs identically with telemetry off (same pattern as ai.js / tts.js).
 *
 * We speak the Langfuse ingestion API directly (a batch of {id,type,timestamp,
 * body} events → POST /api/public/ingestion) rather than pull in the langfuse
 * SDK — it keeps the repo's "no extra runtime deps" rule and needs no secret.
 */
const BASE = (import.meta.env.VITE_LANGFUSE_BASE_URL || (import.meta.env.DEV ? '/lf-api' : '')).replace(/\/$/, '');
const RELEASE = import.meta.env.VITE_LANGFUSE_RELEASE || 'ar-repair-tutor';
const ENV = import.meta.env.DEV ? 'development' : 'production';

export function telemetryAvailable() { return !!BASE; }

// crypto.randomUUID needs a secure context (Pages is https, localhost counts);
// fall back to a manual v4 so telemetry never throws on an odd browser.
const uuid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));
const now = () => new Date().toISOString();

let sessionId = null;
const queue = [];
let flushTimer = null;

function enqueue(type, body) {
  if (!BASE) return;
  queue.push({ id: uuid(), type, timestamp: now(), body });
  if (queue.length >= 15) flush();
  else scheduleFlush();
}

// Debounce so a burst of events (an utterance → generation → trace) ships as one
// batch, while a lone event still leaves within ~1.2s so demos feel live.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1200);
}

async function flush({ keepalive = false } = {}) {
  if (!BASE || !queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(`${BASE}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
      keepalive, // lets a flush-on-hide outlive the page (unlike sendBeacon, keeps CORS + headers)
    });
  } catch (e) {
    // Telemetry must never break the app — drop the batch and move on.
    if (import.meta.env.DEV) console.warn('[telemetry] flush failed:', e.message);
  }
}

/** Start a session (one per page load) and wire the flush-on-close handlers. */
export function initTelemetry(meta = {}) {
  if (!BASE || sessionId) return;
  sessionId = uuid();
  track('session-start', { metadata: { ...meta, userAgent: navigator.userAgent } });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush({ keepalive: true });
  });
  addEventListener('pagehide', () => flush({ keepalive: true }));
}

function traceBody(id, name, input, output, metadata) {
  return {
    id, name, sessionId, input, output,
    metadata: { environment: ENV, ...metadata },
    tags: [ENV], timestamp: now(), release: RELEASE,
  };
}

const NOOP_TRACE = { id: null, generation() {}, event() {}, end() {} };

/**
 * A trace handle for one user action. Attach a `generation` for an LLM call,
 * add `event`s for sub-steps, then `end` it with the final output.
 * Returns a no-op handle when telemetry is off, so callers need no guards.
 */
export function startTrace(name, { input = null, metadata = {} } = {}) {
  if (!BASE) return NOOP_TRACE;
  const id = uuid();
  const start = now();
  return {
    id,
    /** Record an LLM call: model, I/O, token usage and latency. */
    generation({ name: gname = 'generation', model, modelParameters, input: gin, output, usage, startTime, endTime, level, statusMessage } = {}) {
      enqueue('generation-create', {
        id: uuid(), traceId: id, name: gname, model, modelParameters,
        input: gin, output,
        // Map OpenAI-style usage → Langfuse's usage shape (drives cost estimates).
        usage: usage && { input: usage.prompt_tokens, output: usage.completion_tokens, total: usage.total_tokens, unit: 'TOKENS' },
        startTime: startTime || start, endTime: endTime || now(), level, statusMessage,
      });
    },
    event(ename, { input: ein = null, output: eout = null, metadata: emeta = null, level } = {}) {
      enqueue('event-create', { id: uuid(), traceId: id, name: ename, startTime: now(), input: ein, output: eout, metadata: emeta, level });
    },
    end({ output = null, metadata: extra = null } = {}) {
      const body = traceBody(id, name, input, output, extra ? { ...metadata, ...extra } : metadata);
      body.timestamp = start; // anchor the trace at when the action began
      enqueue('trace-create', body);
    },
  };
}

/** One-off trace for a discrete action (mode switch, model load, AR event, error). */
export function track(name, { input = null, output = null, metadata = {}, level } = {}) {
  if (!BASE) return;
  const body = traceBody(uuid(), name, input, output, metadata);
  if (level) body.metadata.level = level;
  enqueue('trace-create', body);
}
