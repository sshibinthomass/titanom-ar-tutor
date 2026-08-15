/**
 * Text-to-speech: the tutor's voice.
 *
 * Primary: ElevenLabs streaming TTS (the sponsor tech), played back through a
 * MediaSource buffer so audio starts on the FIRST mp3 chunk instead of after
 * the whole file downloads — with eleven_flash_v2_5 the tutor starts talking
 * a few hundred ms after speak(), not a second-plus. Browsers without MSE for
 * audio (iOS Safari) keep the old whole-blob path.
 * Fallback: the browser's built-in speechSynthesis, so the app still talks
 * during development when no ElevenLabs key is set.
 *
 * Two guarantees the voice pipeline leans on:
 *  - **Never two voices at once.** Every speak() takes a generation token; the
 *    ElevenLabs fetch takes ~a second, and without the token a slow first
 *    answer would start playing over a fast second one. A stale generation is
 *    discarded the moment a newer speak()/stop() has run.
 *  - **isSpeaking() is accurate**, because the VAD (voice.js) hardens its
 *    barge-in threshold while the tutor is audible.
 *
 * NOTE: audio playback needs a prior user gesture (a tap). Our UI is tap-driven,
 * so the first spoken line always follows a button press.
 */
import { track } from './telemetry.js';

const KEY = import.meta.env.VITE_ELEVENLABS_API_KEY;
const VOICE = import.meta.env.VITE_ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
// flash_v2_5 is ElevenLabs' lowest-latency model (~75 ms to first audio) and
// still multilingual — for two-sentence tutor lines the quality gap to turbo
// is inaudible, the snappiness is not.
const MODEL = import.meta.env.VITE_ELEVENLABS_MODEL || 'eleven_flash_v2_5';

export function elevenLabsAvailable() {
  return !!KEY;
}

let seq = 0;             // generation token: any stop()/speak() invalidates older ones
let currentAudio = null;
let speaking = false;

export function isSpeaking() {
  return speaking;
}

export function stop() {
  seq++;
  speaking = false;
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio._url) URL.revokeObjectURL(currentAudio._url);
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

// MSE lets us feed mp3 chunks into an <audio> element as they arrive. Safari
// on iOS has no MediaSource for audio — it takes the whole-blob path below.
function mseSupported() {
  return typeof MediaSource !== 'undefined' && !!MediaSource.isTypeSupported?.('audio/mpeg');
}

// Pipe the fetch body into a MediaSource buffer, starting playback on the
// first chunk. Throws only if nothing has played yet (so speak() can fall
// back); a failure mid-stream lets whatever buffered finish instead.
async function playStreaming(res, my) {
  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  const audio = new Audio(url);
  audio._url = url;
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  if (my !== seq) { URL.revokeObjectURL(url); res.body.cancel().catch(() => {}); return; }
  const sb = ms.addSourceBuffer('audio/mpeg');
  currentAudio = audio;
  speaking = true;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (my === seq) { speaking = false; currentAudio = null; }
  };
  const reader = res.body.getReader();
  let started = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (my !== seq) { reader.cancel().catch(() => {}); return; } // superseded: stop() already paused it
      if (done) break;
      sb.appendBuffer(value);
      await new Promise((r) => {
        sb.addEventListener('updateend', r, { once: true });
        sb.addEventListener('error', r, { once: true });
      });
      if (!started) {
        started = true;
        await audio.play().catch((e) => { console.warn('audio play blocked', e); if (my === seq) speaking = false; });
      }
    }
    if (ms.readyState === 'open') ms.endOfStream();
  } catch (e) {
    if (!started) throw e; // nothing audible yet — let speak() fall back
    console.warn('TTS stream ended early:', e.message);
    if (ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* detached */ } }
  }
}

/** Speak `text`. Resolves when playback starts (not when it ends). */
export async function speak(text) {
  if (!text) return;
  stop();
  const my = seq; // this utterance owns the channel until a newer stop()/speak()

  if (elevenLabsAvailable()) {
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream`, {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          voice_settings: { stability: 0.45, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text().catch(() => '')}`);
      if (my !== seq) { res.body?.cancel().catch(() => {}); return; } // superseded during generation
      if (mseSupported() && res.body) {
        await playStreaming(res, my);
        track('tts', { output: text, metadata: { provider: 'elevenlabs', voice: VOICE, chars: text.length, streamed: true } });
        return;
      }
      const blob = await res.blob();
      if (my !== seq) return; // superseded while the audio was downloading
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio._url = url;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (my === seq) { speaking = false; currentAudio = null; }
      };
      currentAudio = audio;
      speaking = true;
      await audio.play().catch((e) => { console.warn('audio play blocked', e); if (my === seq) speaking = false; });
      track('tts', { output: text, metadata: { provider: 'elevenlabs', voice: VOICE, chars: text.length } });
      return;
    } catch (e) {
      if (my !== seq) return; // superseded — the failure no longer matters
      console.warn('ElevenLabs TTS failed, falling back to browser speech:', e.message);
      track('tts-error', { metadata: { provider: 'elevenlabs', error: e.message }, level: 'ERROR' });
    }
  }

  // Fallback: browser speechSynthesis.
  if ('speechSynthesis' in window && my === seq) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.onend = () => { if (my === seq) speaking = false; };
    u.onerror = () => { if (my === seq) speaking = false; };
    speaking = true;
    window.speechSynthesis.speak(u);
    track('tts', { output: text, metadata: { provider: 'browser', chars: text.length } });
  }
}
