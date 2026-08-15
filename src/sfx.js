import { track } from './telemetry.js';

/**
 * Sound cues for the Assemble puzzle: a part locking in, a wrong part being
 * rejected, and the object coming apart.
 *
 * Primary: **ElevenLabs sound generation** (`/v1/sound-generation`) — the same
 * key as the tutor's voice, prompted in words like everything else in this app.
 * Fallback: a tiny WebAudio synth, so the puzzle still has feedback with no key
 * set (the same degrade-gracefully rule as tts.js and ai.js).
 *
 * ── Why these are generated ahead of time ────────────────────────────────────
 * Sound generation is a *seconds-long* request. A cue fetched when the part
 * lands would arrive long after the moment it is meant to punctuate, so nothing
 * is ever generated on demand:
 *
 *   • `primeSfx()` fetches all three once, at startup, in parallel.
 *   • The mp3 is cached in localStorage (base64), so it is one request per
 *     browser *ever*, not per session — and decoded to an AudioBuffer once, so
 *     playback is a zero-latency WebAudio call rather than an <audio> element
 *     (which stutters when re-triggered quickly).
 *   • Anything asked for before its cue is ready falls straight through to the
 *     synth. Feedback is never delayed waiting on the network.
 *
 * Bump CACHE_VERSION when a prompt changes, or browsers keep the old sound.
 */

const KEY = import.meta.env.VITE_ELEVENLABS_API_KEY;
const CACHE_VERSION = 'v1';
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';

/**
 * `prompt` is fed to ElevenLabs verbatim. Keep them short, physical and
 * explicitly non-musical — a cue that turns into a jingle fights the tutor's
 * voice, which starts speaking a beat later.
 */
const CUES = {
  snap: {
    prompt: 'A single crisp mechanical snap as a metal part clicks firmly into place. Short, clean, satisfying. No music, no reverb tail.',
    duration: 1,
    volume: 0.5,
  },
  reject: {
    prompt: 'A short soft low buzz, a gentle wrong-answer tone. Muted and warm, not harsh or alarming. No music.',
    duration: 0.9,
    volume: 0.45,
  },
  dismantle: {
    prompt: 'Metal furniture parts unlatching and separating, a soft mechanical clatter sweeping outward and settling. No music.',
    duration: 2,
    volume: 0.4,
  },
};

// ---- WebAudio plumbing -----------------------------------------------------

let ctx = null;
const buffers = new Map();   // cue → decoded AudioBuffer
const inFlight = new Map();  // cue → Promise, so priming twice is harmless
const failed = new Set();    // cue → don't keep retrying a dead endpoint

/**
 * The shared AudioContext. Created lazily and resumed on each play: browsers
 * start it suspended until a user gesture, and every cue here follows one
 * (a drag release, a mode button), so this always lands on the right side of
 * the autoplay policy.
 */
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// mp3 bytes ↔ base64, for the localStorage cache. Chunked because
// String.fromCharCode blows the argument limit on a whole clip.
function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const cacheKey = (name) => `sfx.${CACHE_VERSION}.${name}`;

function readCache(name) {
  try { return localStorage.getItem(cacheKey(name)); } catch { return null; }
}
function writeCache(name, b64) {
  try { localStorage.setItem(cacheKey(name), b64); } catch { /* quota / private mode — just don't cache */ }
}

// ---- Loading ---------------------------------------------------------------

/** Fetch (or read from cache) and decode one cue. Resolves to a buffer or null. */
function load(name) {
  if (buffers.has(name)) return Promise.resolve(buffers.get(name));
  if (inFlight.has(name)) return inFlight.get(name);
  if (failed.has(name)) return Promise.resolve(null);

  const cue = CUES[name];
  const ac = audio();
  if (!cue || !ac) return Promise.resolve(null);

  const job = (async () => {
    let b64 = readCache(name);
    let fromNetwork = false;

    if (!b64) {
      if (!KEY) { failed.add(name); return null; } // no key → synth only, don't retry
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cue.prompt,
          duration_seconds: cue.duration,
          prompt_influence: 0.5, // lean literal — these are cues, not compositions
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text().catch(() => '')}`);
      b64 = toBase64(await res.arrayBuffer());
      fromNetwork = true;
    }

    // decodeAudioData detaches its input, so decode from a fresh copy and keep
    // the base64 as the cacheable form.
    const buf = await ac.decodeAudioData(fromBase64(b64));
    buffers.set(name, buf);
    if (fromNetwork) {
      writeCache(name, b64);
      track('sfx-generated', { metadata: { cue: name, provider: 'elevenlabs', seconds: cue.duration } });
    }
    return buf;
  })().catch((e) => {
    console.warn(`ElevenLabs sound "${name}" unavailable, using the synth cue:`, e.message);
    track('sfx-error', { metadata: { cue: name, error: e.message }, level: 'ERROR' });
    failed.add(name);
    return null;
  }).finally(() => inFlight.delete(name));

  inFlight.set(name, job);
  return job;
}

/**
 * Generate + cache every cue up front. Called once at startup rather than when
 * Assemble opens, so the *first* teardown already has the real sound — that
 * first run is the demo moment, and a synth beep there is a poor first
 * impression. After one run it is served from localStorage, so it costs nothing.
 */
export function primeSfx() {
  for (const name of Object.keys(CUES)) load(name);
}

// ---- Playback --------------------------------------------------------------

/** Play a cue now. Uses the generated clip if it is ready, else the synth. */
export function playSfx(name) {
  const cue = CUES[name];
  const ac = audio();
  if (!cue || !ac) return;

  const buf = buffers.get(name);
  if (!buf) {
    synth(name, ac, cue.volume);
    load(name); // not ready yet — have it for next time
    return;
  }

  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = cue.volume;
  src.buffer = buf;
  src.connect(gain).connect(ac.destination);
  src.start();
}

// ---- Synth fallback --------------------------------------------------------
// Deliberately crude: three recognisable shapes so the puzzle still reads
// without a key. Each is a couple of nodes on a short envelope.

function envelope(ac, gainNode, volume, attack, hold, release) {
  const t = ac.currentTime;
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(volume, t + attack);
  g.setValueAtTime(volume, t + attack + hold);
  g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return t + attack + hold + release;
}

/** A short burst of white noise — the body of the click and clatter cues. */
function noiseBuffer(ac, seconds) {
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function synth(name, ac, volume) {
  const t = ac.currentTime;

  if (name === 'snap') {
    // A click (filtered noise transient) plus a bright ping on top.
    const noise = ac.createBufferSource();
    noise.buffer = noiseBuffer(ac, 0.06);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ac.createGain();
    noise.connect(hp).connect(ng).connect(ac.destination);
    const end = envelope(ac, ng, volume, 0.002, 0.005, 0.05);
    noise.start(t); noise.stop(end);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1480, t + 0.07);
    const og = ac.createGain();
    osc.connect(og).connect(ac.destination);
    const oend = envelope(ac, og, volume * 0.7, 0.005, 0.02, 0.1);
    osc.start(t); osc.stop(oend);
    return;
  }

  if (name === 'reject') {
    // A low, soft descending buzz — wrong, but not punishing.
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(105, t + 0.26);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700;
    const g = ac.createGain();
    osc.connect(lp).connect(g).connect(ac.destination);
    const end = envelope(ac, g, volume * 0.8, 0.01, 0.13, 0.16);
    osc.start(t); osc.stop(end);
    return;
  }

  // dismantle: a noise sweep that opens up and settles, like parts letting go.
  const noise = ac.createBufferSource();
  noise.buffer = noiseBuffer(ac, 1.1);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(320, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.55);
  bp.frequency.exponentialRampToValueAtTime(420, t + 1.0);
  const g = ac.createGain();
  noise.connect(bp).connect(g).connect(ac.destination);
  const end = envelope(ac, g, volume * 0.75, 0.04, 0.5, 0.5);
  noise.start(t); noise.stop(end);
}
