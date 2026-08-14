/**
 * Text-to-speech: the tutor's voice.
 *
 * Primary: ElevenLabs streaming TTS (the sponsor tech).
 * Fallback: the browser's built-in speechSynthesis, so the app still talks
 * during development when no ElevenLabs key is set.
 *
 * NOTE: audio playback needs a prior user gesture (a tap). Our UI is tap-driven,
 * so the first spoken line always follows a button press.
 */
import { track } from './telemetry.js';

const KEY = import.meta.env.VITE_ELEVENLABS_API_KEY;
const VOICE = import.meta.env.VITE_ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const MODEL = import.meta.env.VITE_ELEVENLABS_MODEL || 'eleven_turbo_v2_5';

export function elevenLabsAvailable() {
  return !!KEY;
}

let currentAudio = null;

export function stop() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Speak `text`. Resolves when playback starts (not when it ends). */
export async function speak(text) {
  if (!text) return;
  stop();

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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      currentAudio.onended = () => URL.revokeObjectURL(url);
      await currentAudio.play().catch((e) => console.warn('audio play blocked', e));
      track('tts', { output: text, metadata: { provider: 'elevenlabs', voice: VOICE, chars: text.length } });
      return;
    } catch (e) {
      console.warn('ElevenLabs TTS failed, falling back to browser speech:', e.message);
      track('tts-error', { metadata: { provider: 'elevenlabs', error: e.message }, level: 'ERROR' });
    }
  }

  // Fallback: browser speechSynthesis.
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
    track('tts', { output: text, metadata: { provider: 'browser', chars: text.length } });
  }
}
