/**
 * Speech-to-text transcription: the provider chain behind the mic.
 *
 * Primary: **ElevenLabs Scribe v2** (`POST /v1/speech-to-text`) — the sponsor's
 * STT, called straight from the browser with the same key the voice already
 * uses. It leads because it is strong on accented / far-mic / noisy speech —
 * the exact audio a phone held at a chair produces.
 *
 * Fallback: OpenAI transcription (ai.transcribe, `gpt-4o-transcribe` by
 * default) — used when no ElevenLabs key is set, or per-utterance when Scribe
 * fails. A 4xx from Scribe (key without STT permission, unknown model) retires
 * it for the whole session, so later utterances go straight to OpenAI instead
 * of paying a doomed request first; a network error / 5xx is treated as
 * transient and Scribe stays primary.
 *
 * Both paths return { text, provider } so the caller can report which engine
 * actually heard the user.
 */
import { sttAvailable as whisperAvailable, transcribe as whisperTranscribe } from './ai.js';
import { track } from './telemetry.js';
import { sttLang } from './i18n.js';

const KEY = import.meta.env.VITE_ELEVENLABS_API_KEY;
// scribe_v2 is verified against the live API (accepted by /v1/speech-to-text).
const SCRIBE_MODEL = import.meta.env.VITE_ELEVENLABS_STT_MODEL || 'scribe_v2';

let scribeUsable = !!KEY; // flipped off for the session on a hard (4xx) failure

export function sttAvailable() {
  return scribeUsable || whisperAvailable();
}

async function scribeTranscribe(blob, filename, lang) {
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model_id', SCRIBE_MODEL);
  // Pin the transcription to the app's selected language rather than letting
  // Scribe auto-detect. The app is monolingual per selection, so a hint is
  // strictly better: it stops a short or noisy German utterance being
  // auto-detected as English (or Dutch — the usual near-miss), which used to
  // come back as a nonsense transcript. It also enforces the product rule that
  // input is read in the selected language whatever the user speaks.
  form.append('language_code', lang);
  // Event tags ("(laughter)", "(door slams)") would be read back as part of the
  // question text — the tutor wants the words only.
  form.append('tag_audio_events', 'false');
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': KEY }, // no Content-Type: the browser sets the multipart boundary
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs STT ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * Transcribe a recorded utterance (a Blob from MediaRecorder).
 * Returns { text, provider } — text is '' if the clip contained no speech.
 * The filename extension must match the recorder's mime type: both backends
 * sniff the container from it.
 */
export async function transcribe(blob, { filename = 'utterance.webm' } = {}) {
  const lang = sttLang();
  if (scribeUsable) {
    try {
      const text = await scribeTranscribe(blob, filename, lang);
      return { text, provider: 'scribe' };
    } catch (e) {
      if (e.status >= 400 && e.status < 500) scribeUsable = false;
      console.warn('Scribe STT failed, falling back to OpenAI transcription:', e.message);
      track('stt-error', { metadata: { provider: 'scribe', error: e.message, lang, retired: !scribeUsable }, level: 'ERROR' });
      if (!whisperAvailable()) throw e; // no fallback configured — surface the real error
    }
  }
  const text = await whisperTranscribe(blob, { filename, language: lang });
  return { text, provider: 'whisper' };
}
