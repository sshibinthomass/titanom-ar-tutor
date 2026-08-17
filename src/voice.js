/**
 * Speech-to-text: the tutor's ears.
 *
 * Capture is a MediaRecorder feeding the STT provider chain (stt.js: ElevenLabs
 * Scribe v2 first, OpenAI Whisper fallback). What differs is who decides where an
 * utterance *starts and ends* — and there are two answers, because they fail in
 * opposite ways:
 *
 *  - **Push-to-talk (the default).** The user holds the 🎤 button; press and
 *    release ARE the boundaries. Nothing to tune, nothing to mis-hear: a quiet
 *    voice, a noisy hall, a long thinking pause mid-sentence and an AGC-boosted
 *    room all behave identically, because none of them are being interpreted.
 *    This is the reliable path and the one a demo should stand on.
 *  - **Hands-free (opt-in).** A WebAudio VAD guesses the boundaries from band-
 *    limited energy against an adaptive noise floor. It is what makes the tutor
 *    usable with both hands on the object — the whole point in AR — but it is a
 *    guess, and a guess that is wrong cuts a sentence in half or never fires.
 *
 * **Who holds the microphone open** follows from that, and it is not a detail:
 * a live capture track puts the phone's audio session into *communication* mode
 * (Android needs it for the platform echo canceller; iOS's PlayAndRecord
 * category is the same story), and that mode routes playback to the **earpiece**
 * — the tutor's voice suddenly comes out of the receiver you hold to your ear
 * instead of the loudspeaker, and stays there for as long as the track lives.
 * So:
 *
 *  - Under push-to-talk the mic is opened by the press and **closed by the
 *    release**, as soon as the recorder has handed over its audio. Nothing is
 *    kept warm between questions, which is what puts the answer back on the
 *    loudspeaker. It costs the opening moments of the first syllable while
 *    getUserMedia resolves — the caption says the mic is coming up.
 *  - Hands-free is the one mode that genuinely needs a track that outlives an
 *    utterance, so there it stays open (and earpiece routing with it) until the
 *    toggle goes off.
 *
 * Echo cancellation follows the same split: it is what the VAD needs to hear the
 * user over the tutor, and it is also what forces communication mode, so only
 * hands-free asks for it. Push-to-talk has nothing to cancel — main.js keeps the
 * tutor silent while the button is down.
 *
 * Fallback: the Web Speech API, used only when neither remote STT is
 * configured (Android Chrome + desktop Chrome only). It supports the same two
 * shapes: press/release map onto start/stop, hands-free onto its auto-restart.
 *
 * Both paths expose the same interface from createRecognizer():
 *   { start, stop, press, release, setHandsFree, setLang, isListening, isCapturing }
 * and both fire onSpeechStart() the instant the user begins talking — main.js
 * uses that to interrupt the tutor's voice (barge-in), so the user can always
 * talk over an answer.
 */
import { sttAvailable, transcribe } from './stt.js';
import { track } from './telemetry.js';
import { speechLang, t, getLang } from './i18n.js';

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
const MIN_PUSH_MS = 250;             // a held button is deliberate, so the bar is lower —
                                     // but below this it was a tap, not a question
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
// Both lists are always active: the filler a model hallucinates is a property
// of the *model*, not of the selected language — German audio transcribed by a
// German-pinned Scribe still comes back as "Thank you." on a noise burst,
// because that phrase dominates its training data. Checking both costs nothing
// and each list is short.
const JUNK = new Set([
  // English
  'you', 'yeah', 'uh', 'um', 'hmm', 'mm', 'huh', 'oh', 'ah', 'so', 'the', 'a',
  'okay', 'ok', 'bye', 'thanks', 'thank you', 'thank you for watching',
  // German — the same shape of hallucination, plus the subtitle-corpus sign-offs
  // ('Untertitel von…' / 'Vielen Dank') that German STT emits on empty audio.
  'ja', 'nein', 'äh', 'ähm', 'hm', 'hmm', 'ach', 'also', 'und', 'der', 'die', 'das',
  'okay', 'tschüss', 'danke', 'vielen dank', 'danke schön', 'dankeschön',
  'untertitel', 'untertitel von stephanie geiges', 'untertitelung des zdf',
  'untertitelung des zdf 2020', 'so weit so gut',
]);
function isJunk(text) {
  const s = (text || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return !s || s.length < 2 || JUNK.has(s);
}

/**
 * Create a recognizer. Returns null only if neither path is possible.
 *  onResult(transcript)        — a full utterance was heard and transcribed
 *  onSpeechStart()             — the user just started talking (fire barge-in here)
 *  onStateChange(listening)    — mic armed/disarmed
 *  onStatus(phase)             — 'arming' while the mic is coming up,
 *                                'transcribing' while an utterance is at the API
 *  onError(message)            — user-facing problem (mic blocked, network down)
 *  isTtsSpeaking()             — supplied by main.js; hardens the VAD while the
 *                                tutor's own voice is playing
 *  handsFree                   — start with VAD utterance detection on (default off:
 *                                push-to-talk is the reliable path)
 */
export function createRecognizer(opts = {}) {
  if (remoteSttAvailable()) return createVadRecognizer(opts);
  if (speechRecognitionAvailable()) return createWebSpeechRecognizer(opts);
  return null;
}

// ---- Primary: VAD + MediaRecorder + remote STT (Scribe v2 / Whisper) --------

function createVadRecognizer({ onResult, onStateChange, onSpeechStart, onStatus, onError, isTtsSpeaking, handsFree = false } = {}) {
  let listening = false;
  let pressed = false;      // the push-to-talk button is down right now
  let pressFlushed = false; // …and whether this press already sent its audio
  let session = 0;          // bumped on stop(); async continuations check it
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let freq = null;
  let bandLo = 1, bandHi = 1;
  let tick = null;
  let capTimer = null;      // push-to-talk runaway cap (no VAD ticker to carry it)

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

    // Push-to-talk owns the boundaries while the button is down. The press
    // already stated "speech starts now" and the release will state where it
    // ends — which is exactly what everything below spends its effort guessing,
    // so guessing alongside it could only overrule a fact with an estimate. The
    // runaway cap still applies (a button held down by a pocket, or forgotten).
    if (pressed) {
      if (now - speechStartAt > MAX_UTTER_MS) release();
      return;
    }
    // Mic armed, nobody holding: keep the floor calibrated above (so turning
    // hands-free on mid-session isn't starting from cold) and keep recycling
    // the recorder, but never open an utterance on our own.
    if (!handsFree) {
      if (now - recStartedAt > IDLE_RESTART_MS) restartRecorder();
      return;
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
    rec = null;
    if (handsFree) {
      if (listening) startRecorder(); // the VAD needs a live recorder for the next question
    } else {
      // Push-to-talk: the utterance is over, so the microphone must actually
      // close — a live track holds the audio session in communication mode and
      // the answer would come out of the earpiece. Wait for the recorder's final
      // blob first: pulling the tracks out from under an open MediaRecorder
      // truncates it. `releaseStream` leaves `session` alone, so the audio
      // already on its way to the transcriber still gets answered.
      done.then(() => { if (mySession === session && !pressed) releaseStream(); });
    }
    onStatus?.('transcribing');
    sendChain = sendChain.then(async () => {
      const blob = await done;
      if (!blob || mySession !== session) return;
      try {
        const { text, provider } = await transcribe(blob, { filename: `utterance.${ext}` });
        if (mySession !== session) return;
        if (isJunk(text)) { onStatus?.('listening'); return; }
        track('stt', { output: text, metadata: { provider, lang: getLang(), bytes: blob.size } });
        onResult?.(text);
      } catch (e) {
        console.warn('transcription failed:', e.message);
        track('stt-error', { metadata: { error: e.message }, level: 'ERROR' });
        if (mySession === session) onError?.(t('voice.sttFailed'));
      }
    });
  }

  // ---- Push-to-talk -------------------------------------------------------

  /**
   * The button went down: open the microphone (unless hands-free already has it
   * open) and start recording. The press pays for getUserMedia — that is the
   * price of a mic that isn't left running between questions, and the reason
   * `onStatus('arming')` fires: the caption tells the user the mic is coming up
   * rather than letting them talk into a stream that doesn't exist yet.
   */
  async function press() {
    if (pressed) return;
    pressed = true;
    pressFlushed = false;
    if (!listening) {
      onStatus?.('arming');
      await openMic(handsFree);
      // Let go while the mic was coming up: release() found nothing to end, so
      // closing it is on us — otherwise a stray tap leaves the track running.
      if (!pressed) { if (!handsFree && listening) releaseStream(); return; }
      if (!listening) { pressed = false; return; } // getUserMedia refused; openMic reported it
    } else {
      // Hands-free already had the mic: a fresh recorder, so the blob is this
      // utterance and nothing else. The gap between stopping the old one and
      // starting this one is a few lines of JS — no one begins a sentence that
      // fast after pressing a button.
      restartRecorder();
    }
    speechActive = true;
    speechStartAt = performance.now();
    lastVoiceAt = speechStartAt;
    // Without the VAD's ticker there is nothing watching a button held down by a
    // pocket, so push-to-talk carries its own runaway cap.
    if (!handsFree) capTimer = setTimeout(() => { if (pressed) release(); }, MAX_UTTER_MS);
    onSpeechStart?.();                    // barge-in: the tutor yields the floor
  }

  /**
   * The button came up. Returns true if an utterance was sent for
   * transcription — main.js reads that to tell a real hold from a tap.
   */
  function release() {
    // Already let go — which is what the MAX_UTTER_MS cap does to a button held
    // down for a quarter of a minute. Report that press's outcome, so the real
    // release doesn't tell the user their question went nowhere.
    if (!pressed) return pressFlushed;
    pressed = false;
    clearTimeout(capTimer);
    capTimer = null;
    if (!speechActive) return false;      // released before the mic finished opening
    const duration = performance.now() - speechStartAt;
    speechActive = false;
    aboveCount = 0;
    if (duration >= MIN_PUSH_MS) { pressFlushed = true; flushUtterance(); return true; }
    // A tap, not a question: throw the audio away — and under push-to-talk let
    // the microphone go with it, so a mis-tap doesn't leave the tutor talking
    // into the earpiece for the rest of the session.
    if (handsFree) restartRecorder();
    else releaseStream();
    return false;
  }

  function setHandsFree(on) {
    handsFree = !!on;
    aboveCount = 0;
    if (pressed) return; // a hold owns the mic; its release will apply the new rule
    // Turning it off ends the VAD's business with the microphone — nothing else
    // is left to close it, and leaving it open would keep the tutor's voice in
    // the earpiece for a mode that no longer needs to hear anything.
    if (!handsFree && listening) stop();
  }

  // Arming the mic ahead of a press is a hands-free-only idea now: under
  // push-to-talk the press opens it and the release closes it.
  async function start() { return openMic(true); }

  /**
   * Open the microphone. `vad` also builds the WebAudio analysis graph on top —
   * under push-to-talk there is nothing to detect (the button states both
   * boundaries), so the analyser, the worklet and its output node are skipped
   * entirely rather than left running against a mic that closes in a second.
   */
  async function openMic(vad) {
    if (listening) return;
    listening = true;
    const mySession = ++session;
    onStateChange?.(true);
    try {
      // Noise suppression + AGC clean the signal before either the VAD or the
      // transcriber sees it. Echo cancellation is asked for only by hands-free:
      // it is what keeps the tutor's own voice out of the VAD, and it is also
      // what forces the phone into communication mode (see the module header).
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: !!vad, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      listening = false;
      onStateChange?.(false);
      onError?.(t('voice.micBlocked'));
      track('stt-error', { metadata: { provider: 'whisper', error: e.name || e.message }, level: 'ERROR' });
      return;
    }
    if (!listening || mySession !== session) {
      // stop() was tapped while the permission prompt was up
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return;
    }
    [blobType, ext] = pickMime();
    if (!vad) { startRecorder(); return; }
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

  /**
   * Let the microphone go: tracks stopped, audio graph closed. It deliberately
   * does NOT bump `session`, so an utterance already on its way to the
   * transcriber still comes back and gets answered — this runs *because* that
   * utterance was captured, not to cancel it.
   */
  function releaseStream() {
    listening = false;
    speechActive = false;
    clearInterval(tick);
    tick = null;
    clearTimeout(capTimer);
    capTimer = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* already stopped */ } }
    rec = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    audioCtx?.close().catch(() => {});
    audioCtx = null;
    analyser = null;
    onStateChange?.(false);
  }

  // The hard stop: everything above, plus a session bump that discards whatever
  // was in flight. This is mute, and mute means "forget what I just said too".
  function stop() {
    pressed = false;
    pressFlushed = false;
    session++;
    releaseStream();
  }

  return {
    start,
    stop,
    press,
    release,
    setHandsFree,
    // No-op by design: this path reads the app language straight from i18n on
    // every request (stt.js pins `language_code` per utterance), so a language
    // switch takes effect on the very next thing the user says — no restart,
    // no state to keep in sync here.
    setLang() {},
    isListening: () => listening,
    isCapturing: () => speechActive, // mid-utterance right now? (held counts)
  };
}

// ---- Fallback: Web Speech API (Chrome only, no OpenAI key needed) --------------

function createWebSpeechRecognizer({ lang = null, onResult, onStateChange, onSpeechStart, handsFree = false } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  // Web Speech has no auto-detect worth the name, so it must be told the
  // language. Default to the app's, not to en-US.
  rec.lang = lang || speechLang();
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false; // one phrase per start; we restart while "listening" is on

  let listening = false;
  let capturing = false;
  let pressed = false;
  let pressedAt = 0;

  rec.onspeechstart = () => { capturing = true; onSpeechStart?.(); };
  rec.onspeechend = () => { capturing = false; };
  rec.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript.trim();
    if (t && !isJunk(t)) onResult?.(t);
  };
  rec.onend = () => {
    capturing = false;
    // Auto-restart so it keeps listening until explicitly stopped — but only in
    // hands-free. Under push-to-talk the release is what ends the phrase, and
    // restarting there would re-open the mic the user just closed.
    if (listening && handsFree && !pressed) {
      try { rec.start(); } catch { /* already starting */ }
    } else if (!listening) {
      onStateChange?.(false);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      listening = false;
      pressed = false;
      onStateChange?.(false);
    }
  };

  return {
    start() {
      if (listening) return;
      listening = true;
      if (handsFree) { try { rec.start(); } catch { /* already started */ } }
      onStateChange?.(true);
    },
    stop() {
      listening = false;
      pressed = false;
      try { rec.stop(); } catch { /* not running */ }
      onStateChange?.(false);
    },
    // Press/release map straight onto Web Speech's own phrase boundaries — the
    // engine still decides where words are, we just decide when it may listen.
    press() {
      if (pressed) return;
      pressed = true;
      pressedAt = performance.now();
      if (!listening) { listening = true; onStateChange?.(true); }
      onSpeechStart?.();
      try { rec.start(); } catch { /* already running from hands-free */ }
    },
    // Web Speech delivers asynchronously, so "did this produce words?" isn't
    // knowable yet — report whether we asked it to, and let onResult fire when
    // it lands. `stop()` finalises what it heard; below the threshold it was a
    // tap, and `abort()` throws the fragment away instead of submitting it.
    release() {
      if (!pressed) return false;
      pressed = false;
      if (performance.now() - pressedAt < MIN_PUSH_MS) {
        try { rec.abort(); } catch { /* not running */ }
        return false;
      }
      try { rec.stop(); } catch { /* not running */ }
      return true;
    },
    setHandsFree(on) {
      handsFree = !!on;
      if (!listening || pressed) return;
      if (handsFree) { try { rec.start(); } catch { /* already running */ } }
      else { try { rec.stop(); } catch { /* not running */ } }
    },
    // A live SpeechRecognition ignores a mid-session `lang` change, so bounce
    // it: onend's auto-restart picks the new language up on the next phrase.
    setLang(l) {
      const next = l || speechLang();
      if (rec.lang === next) return;
      rec.lang = next;
      if (listening) { try { rec.stop(); } catch { /* not running */ } }
    },
    isListening: () => listening,
    isCapturing: () => capturing || pressed,
  };
}
