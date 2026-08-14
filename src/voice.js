/**
 * Speech-to-text via the Web Speech API (SpeechRecognition).
 * Supported on Android Chrome + desktop Chrome; not on iOS Safari.
 */
export function speechRecognitionAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Create a recognizer. Returns { start, stop, setLang } or null if unsupported.
 *  onResult(transcript) — a final phrase was heard
 *  onStateChange(listening:boolean)
 */
export function createRecognizer({ lang = 'en-US', onResult, onStateChange } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false; // one phrase per start; we restart while "listening" is on

  let listening = false;

  rec.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript.trim();
    if (t) onResult?.(t);
  };
  rec.onend = () => {
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
  };
}
