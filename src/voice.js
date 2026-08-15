/**
 * Speech-to-text: the tutor's ears.
 *
 * Primary: an always-on microphone pipeline — a WebAudio VAD (voice-activity
 * detector) finds utterances, MediaRecorder captures them, and the STT
 * provider chain (stt.js: ElevenLabs Scribe v2 first, DGPT Whisper fallback)
 * turns them into text. This replaces the Web Speech API as the main path
 * because it is far more reliable: it works on every browser with a mic
 * (including iOS Safari, which has no SpeechRecognition), it applies the
 * browser's echo cancellation + noise suppression to the capture, and the
 * VAD's adaptive noise floor keeps ambient noise from being mistaken for
 * speech.
 *
 * Fallback: the Web Speech API, used only when neither remote STT is
 * configured (Android Chrome + desktop Chrome only).
 *
 * Both paths expose the same interface from createRecognizer():
 *   { start, stop, setLang, isListening, isCapturing }
 * and both fire onSpeechStart() the instant the user begins talking — main.js
 * uses that to interrupt the tutor's voice (barge-in), so the user can always
 * talk over an answer.
 */
import { sttAvailable, transcribe } from './stt.js';
import { track } from './telemetry.js';

// ---- VAD tuning (byte-magnitude units from AnalyserNode, 0–255) -------------
const FRAME_MS = 30;                 // VAD sampling cadence
const SPEECH_BAND = [300, 3400];     // Hz — the telephone voice band; ignores hum + hiss
const ONSET_FRAMES = 3;              // ~90 ms of sustained energy = speech began
const ONSET_FRAMES_WHILE_TTS = 8;    // stricter while the tutor talks, so its own
                                     // voice (or its echo) can't trigger a barge-in
const HANG_MS = 650;                 // this much silence ends the utterance — long enough
                                     // for a mid-sentence breath, short enough that the
                                     // answer doesn't feel like it waits on a timer
const MIN_UTTER_MS = 300;            // shorter = a door slam / cough, not a question
const MAX_UTTER_MS = 15000;          // force-flush a monologue so it still gets answered
const IDLE_RESTART_MS = 8000;        // recycle the recorder while silent → small uploads
const FLOOR_MIN = 3;                 // noise-floor clamp: never fully deaf…
const FLOOR_MAX = 90;                // …and never adapted up to speech level
const FLOOR_WIN_FRAMES = 100;        // ~3 s minimum-statistics window for the floor

export function speechRecognitionAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function remoteSttAvailable() {
  return sttAvailable() && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export function voiceAvailable() {
  return remoteSttAvailable() || speechRecognitionAvailable();
}

// STT models hallucinate fillers ("you", "thank you") on borderline audio, and
// a noise burst that slips past the VAD comes back as one of these. A
// transcript that is ONLY a filler is noise, not a question — drop it silently.
const JUNK = new Set([
  'you', 'yeah', 'uh', 'um', 'hmm', 'mm', 'huh', 'oh', 'ah', 'so', 'the', 'a',
  'okay', 'ok', 'bye', 'thanks', 'thank you', 'thank you for watching',
]);
function isJunk(text) {
  const s = (text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return !s || s.length < 2 || JUNK.has(s);
}

/**
 * Create a recognizer. Returns null only if neither path is possible.
 *  onResult(transcript)        — a full utterance was heard and transcribed
 *  onSpeechStart()             — the user just started talking (fire barge-in here)
 *  onStateChange(listening)    — mic toggled on/off
 *  onStatus(phase)             — 'transcribing' while an utterance is at the API
 *  onError(message)            — user-facing problem (mic blocked, network down)
 *  isTtsSpeaking()             — supplied by main.js; hardens the VAD while the
 *                                tutor's own voice is playing
 */
export function createRecognizer(opts = {}) {
  if (remoteSttAvailable()) return createVadRecognizer(opts);
  if (speechRecognitionAvailable()) return createWebSpeechRecognizer(opts);
  return null;
}

// ---- Primary: VAD + MediaRecorder + remote STT (Scribe v2 / Whisper) --------

function createVadRecognizer({ onResult, onStateChange, onSpeechStart, onStatus, onError, isTtsSpeaking } = {}) {
  let listening = false;
  let session = 0;          // bumped on stop(); async continuations check it
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let freq = null;
  let bandLo = 1, bandHi = 1;
  let tick = null;

  let rec = null;           // current MediaRecorder
  let recStartedAt = 0;
  let blobType = '';
  let ext = 'webm';

  let floor = 8;            // adaptive ambient-noise estimate
  let winMin = Infinity;    // quietest frame of the current floor window
  let winCount = 0;         // frames into the current floor window
  let aboveCount = 0;       // recent frames above the onset threshold
  let speechActive = false;
  let speechStartAt = 0;
  let lastVoiceAt = 0;
  let sendChain = Promise.resolve(); // serializes transcriptions → answers stay in order

  // Safari records AAC-in-MP4; Chrome/Firefox do Opus-in-WebM. The extension we
  // send must match, because the server sniffs the container from the filename.
  function pickMime() {
    const candidates = [
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/webm', 'webm'],
      ['audio/mp4', 'mp4'],
      ['audio/ogg;codecs=opus', 'ogg'],
    ];
    for (const [m, e] of candidates) {
      if (MediaRecorder.isTypeSupported?.(m)) return [m, e];
    }
    return ['', 'webm'];
  }

  function startRecorder() {
    const r = new MediaRecorder(stream, blobType ? { mimeType: blobType, audioBitsPerSecond: 48000 } : undefined);
    // Per-recorder chunk array (not a shared one): the final dataavailable of an
    // old recorder fires after the next one starts, and must not leak into it.
    r._chunks = [];
    r.ondataavailable = (e) => { if (e.data && e.data.size) r._chunks.push(e.data); };
    r.start();
    rec = r;
    recStartedAt = performance.now();
  }

  function stopRecorder(r) {
    return new Promise((resolve) => {
      if (!r || r.state === 'inactive') return resolve(null);
      r.onstop = () => resolve(new Blob(r._chunks, { type: blobType || 'audio/webm' }));
      try { r.stop(); } catch { resolve(null); }
    });
  }

  // Recycle the recorder without keeping the audio (silence, or a too-short blip).
  function restartRecorder() {
    stopRecorder(rec);
    if (listening) startRecorder();
  }

  function bandEnergy() {
    analyser.getByteFrequencyData(freq);
    let sum = 0;
    for (let i = bandLo; i <= bandHi; i++) sum += freq[i];
    return sum / (bandHi - bandLo + 1);
  }

  function step() {
    if (!listening) return;
    const now = performance.now();
    const energy = bandEnergy();
    // Live tuning tap: set window.__vadHook in devtools to watch energy vs the
    // adaptive floor on a real device (a noisy demo hall needs real numbers).
    window.__vadHook?.(now, energy, floor, speechActive, aboveCount);

    // Minimum-statistics floor: chase the quietest moment of the last ~3 s, in
    // BOTH states. Real speech always leaves dips between words, so the window
    // minimum stays near the room's ambient level — but energy that never dips
    // for 3 s straight is noise by definition, and the floor must rise to meet
    // it. Without this, a steady hum (fan, AGC-boosted room tone) above the
    // floor locks the VAD in "speech" forever: the floor could only adapt
    // during silence, and the VAD never saw silence again — utterances ran to
    // the 15 s cap and answers were held back for a capture that never ended.
    winMin = Math.min(winMin, energy);
    if (++winCount >= FLOOR_WIN_FRAMES) {
      floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, floor + (winMin - floor) * 0.5));
      winMin = Infinity;
      winCount = 0;
    }

    // Hysteresis: harder to enter speech than to stay in it, so a word's quiet
    // tail doesn't chop the utterance while random peaks still can't start one.
    // The margins are deliberately modest — a soft or far-from-the-mic voice
    // must still clear them; the junk filter catches what noise sneaks through.
    const enterAt = floor + Math.max(7, floor * 0.5);
    const exitAt = floor + Math.max(4, floor * 0.3);

    if (!speechActive) {
      // Fast-down tracking between the window updates, so a loud burst that
      // briefly raised the floor doesn't deafen the next quiet question.
      if (energy < floor) floor = Math.max(FLOOR_MIN, floor + (energy - floor) * 0.25);
      const need = isTtsSpeaking?.() ? ONSET_FRAMES_WHILE_TTS : ONSET_FRAMES;
      // Decay on a quiet frame instead of resetting: real speech dips between
      // syllables, and a hard reset made longer onsets nearly unreachable.
      // Noise still can't accumulate — under ~50% duty cycle it random-walks
      // back to zero. While the tutor is audible the hard reset stays, so
      // speaker bleed the echo canceller misses can't build up to a barge-in.
      aboveCount = energy > enterAt ? aboveCount + 1 : (isTtsSpeaking?.() ? 0 : Math.max(0, aboveCount - 1));
      if (aboveCount >= need) {
        speechActive = true;
        speechStartAt = now - aboveCount * FRAME_MS;
        lastVoiceAt = now;
        onSpeechStart?.(); // barge-in: main.js silences the tutor here
      } else if (now - recStartedAt > IDLE_RESTART_MS) {
        restartRecorder(); // drop accumulated silence so uploads stay tiny
      }
    } else {
      if (energy > exitAt) lastVoiceAt = now;
      if (now - lastVoiceAt > HANG_MS || now - speechStartAt > MAX_UTTER_MS) {
        const duration = lastVoiceAt - speechStartAt;
        speechActive = false;
        aboveCount = 0;
        if (duration >= MIN_UTTER_MS) flushUtterance();
        else restartRecorder(); // a blip — not worth an API round-trip
      }
    }
  }

  function flushUtterance() {
    const mySession = session;
    const done = stopRecorder(rec);
    if (listening) startRecorder(); // keep the mic hot for the next question
    onStatus?.('transcribing');
    sendChain = sendChain.then(async () => {
      const blob = await done;
      if (!blob || mySession !== session) return;
      try {
        const { text, provider } = await transcribe(blob, { filename: `utterance.${ext}` });
        if (mySession !== session) return;
        if (isJunk(text)) { onStatus?.('listening'); return; }
        track('stt', { output: text, metadata: { provider, bytes: blob.size } });
        onResult?.(text);
      } catch (e) {
        console.warn('transcription failed:', e.message);
        track('stt-error', { metadata: { error: e.message }, level: 'ERROR' });
        if (mySession === session) onError?.("Couldn't reach the transcription service — check the connection and try again.");
      }
    });
  }

  async function start() {
    if (listening) return;
    listening = true;
    const mySession = ++session;
    onStateChange?.(true);
    try {
      // The three constraints are the noise strategy's first line: the browser's
      // echo canceller keeps the tutor's own TTS out of the mic (what makes
      // barge-in usable on a phone speaker), and noise suppression + AGC clean
      // the signal before the VAD ever sees it.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      listening = false;
      onStateChange?.(false);
      onError?.('Microphone blocked — allow mic access for this site and tap 🎤 again.');
      track('stt-error', { metadata: { provider: 'whisper', error: e.name || e.message }, level: 'ERROR' });
      return;
    }
    if (!listening || mySession !== session) {
      // stop() was tapped while the permission prompt was up
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    await audioCtx.resume().catch(() => {}); // mobile: context starts suspended until a gesture
    const srcNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    // Light smoothing only: every notch here delays onset detection by a frame
    // or two, and onset is what barge-in and short answers ride on.
    analyser.smoothingTimeConstant = 0.3;
    srcNode.connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    bandLo = Math.max(1, Math.round(SPEECH_BAND[0] / binHz));
    bandHi = Math.min(analyser.frequencyBinCount - 1, Math.round(SPEECH_BAND[1] / binHz));
    [blobType, ext] = pickMime();
    floor = 8;
    winMin = Infinity;
    winCount = 0;
    aboveCount = 0;
    speechActive = false;
    startRecorder();
    await startTicker(srcNode, mySession);
  }

  // The VAD must tick even when JS timers don't: Chrome throttles setInterval
  // to 1 Hz in occluded/background windows and under battery/energy saver —
  // the symptom is speech that goes unnoticed for seconds, or an utterance
  // that ends but isn't flushed until long after. An AudioWorklet is driven by
  // the audio rendering thread, which keeps real-time cadence as long as the
  // mic stream is live, so a tick arrives every FRAME_MS of *audio* time no
  // matter what the page's timers are doing. setInterval survives only as the
  // fallback where AudioWorklet is missing.
  async function startTicker(srcNode, mySession) {
    if (audioCtx.audioWorklet) {
      try {
        const samplesPerTick = Math.round(audioCtx.sampleRate * (FRAME_MS / 1000));
        const code = `registerProcessor('vad-tick', class extends AudioWorkletProcessor {
          constructor() { super(); this.n = 0; }
          process() {
            this.n += 128; // one render quantum
            if (this.n >= ${samplesPerTick}) { this.n = 0; this.port.postMessage(0); }
            return true;
          }
        });`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        await audioCtx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
        if (!listening || mySession !== session) return; // stopped while the module loaded
        const node = new AudioWorkletNode(audioCtx, 'vad-tick');
        node.port.onmessage = () => step();
        // The worklet only renders while it's on a path to the destination;
        // route it there through a zero gain so the mic never becomes audible.
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        srcNode.connect(node);
        node.connect(mute);
        mute.connect(audioCtx.destination);
        return;
      } catch (e) {
        console.warn('VAD worklet unavailable, falling back to timer ticks:', e.message);
      }
    }
    if (listening && mySession === session) tick = setInterval(step, FRAME_MS);
  }

  function stop() {
    listening = false;
    session++;
    speechActive = false;
    clearInterval(tick);
    tick = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* already stopped */ } }
    rec = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    analyser = null;
    onStateChange?.(false);
  }

  return {
    start,
    stop,
    setLang() { /* Scribe/Whisper auto-detect the language (German + English both work) */ },
    isListening: () => listening,
    isCapturing: () => speechActive, // mid-utterance right now?
  };
}

// ---- Fallback: Web Speech API (Chrome only, no DGPT key needed) --------------

function createWebSpeechRecognizer({ lang = 'en-US', onResult, onStateChange, onSpeechStart } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false; // one phrase per start; we restart while "listening" is on

  let listening = false;
  let capturing = false;

  rec.onspeechstart = () => { capturing = true; onSpeechStart?.(); };
  rec.onspeechend = () => { capturing = false; };
  rec.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript.trim();
    if (t && !isJunk(t)) onResult?.(t);
  };
  rec.onend = () => {
    capturing = false;
    // Auto-restart so it keeps listening until explicitly stopped.
    if (listening) {
      try { rec.start(); } catch { /* already starting */ }
    } else {
      onStateChange?.(false);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      listening = false;
      onStateChange?.(false);
    }
  };

  return {
    start() {
      if (listening) return;
      listening = true;
      try { rec.start(); } catch { /* already started */ }
      onStateChange?.(true);
    },
    stop() {
      listening = false;
      try { rec.stop(); } catch { /* not running */ }
      onStateChange?.(false);
    },
    setLang(l) { rec.lang = l; },
    isListening: () => listening,
    isCapturing: () => capturing,
  };
}
