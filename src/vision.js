/**
 * The home screen's "Scan an object": the phone camera → one still frame →
 * DeutschlandGPT vision → which of the app's objects is the user standing in
 * front of.
 *
 * Two halves, deliberately in one module because they only exist for each
 * other: the camera plumbing (getUserMedia → <video> → a JPEG data URL) and the
 * classifier that turns that frame into one of four fixed labels.
 *
 * The labels are a **closed set** (`SCAN_LABELS`) — the scan's whole job is to
 * pick one of the models the app actually ships, so an open-ended "what is
 * this?" answer would be useless. `none` is a first-class outcome, not a
 * failure: a photo of a desk should land the user back on the picker rather
 * than on a random model.
 *
 * The labels are fixed **English identifiers**, exactly like the `PART:` /
 * `ACTION:` headers in tutor.js — they are machine-read keys, never shown to
 * the user, so they are exempt from the app's one-language rule and the prompt
 * says so explicitly.
 */
import { aiAvailable, chat, VISION_MODEL } from './ai.js';
import { startTrace } from './telemetry.js';

/** The only answers the classifier may give. Order is the prompt's order. */
export const SCAN_LABELS = ['chair', 'bicycle', 'bed', 'none'];

// Tolerant matching for a model that answers with a sentence, a synonym, or —
// deep in a German session — the German word, despite being told not to. The
// scan is one tap and re-taking a photo is annoying, so we read a near-miss
// rather than throwing the frame away.
const LABEL_PATTERNS = [
  ['chair', /\b(chair|stuhl|sessel|seat)\b/i],
  ['bicycle', /\b(bicycle|bike|cycle|fahrrad|rad)\b/i],
  ['bed', /\b(bed|mattress|bett|matratze)\b/i],
  ['none', /\b(none|nothing|unknown|keine[sr]?|nichts)\b/i],
];

// ---- Camera ----------------------------------------------------------------

/**
 * Open the rear camera into a <video>. Resolves with the MediaStream, which the
 * caller MUST hand back to `stopCamera` — a live stream keeps the camera LED on
 * and, on a phone, keeps the radio-hot ISP running.
 *
 * `facingMode: { ideal: 'environment' }` rather than `exact`: a laptop has only
 * a front camera and `exact` would reject outright, leaving the desktop demo
 * with no scan at all.
 */
export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-camera');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
  video.srcObject = stream;
  // iOS Safari fullscreens an inline video without these, which would throw the
  // user out of the app mid-scan.
  video.setAttribute('playsinline', '');
  video.muted = true;
  try { await video.play(); } catch { /* autoplay policy: the frame still arrives */ }
  return stream;
}

/** Release the camera. Safe to call with null / an already-stopped stream. */
export function stopCamera(stream, video = null) {
  for (const track of stream?.getTracks?.() || []) track.stop();
  if (video) video.srcObject = null;
}

/**
 * Grab the current video frame as a JPEG data URL.
 *
 * Downscaled to `maxSize` on the long edge: telling a chair from a bed does not
 * need 1280 px, and a vision model is billed (and slowed) by pixels. 768 is the
 * tile size these models reason at anyway.
 */
export function captureFrame(video, { maxSize = 768, quality = 0.8 } = {}) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error('no-frame');
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// ---- Classification --------------------------------------------------------

/**
 * Ask DeutschlandGPT which of the app's objects the photo shows.
 * Returns one of SCAN_LABELS — 'none' whenever we can't be confident, including
 * when the AI is unconfigured or unreachable, so the caller has exactly one
 * "couldn't tell, pick manually" path to handle.
 */
export async function identifyObject(dataUrl) {
  const trace = startTrace('scan-object', { metadata: { labels: SCAN_LABELS.join(',') } });

  if (!aiAvailable()) {
    trace.end({ output: 'none', metadata: { aiAvailable: false } });
    return 'none';
  }

  const system = [
    'You are an object classifier for an augmented-reality repair tutor.',
    'Look at the photo and decide which ONE of these objects it shows:',
    'chair — any chair, especially an office or desk chair such as an IKEA MARKUS;',
    'bicycle — any bicycle;',
    'bed — any bed, or a mattress on a frame;',
    'none — anything else, an empty room, or a photo too dark or blurred to be sure.',
    'If several objects appear, pick the one the photo is mainly about — the largest and most central.',
    'If you are not confident, answer none. A wrong guess is worse than none.',
    // Same exemption as the PART: / ACTION: headers in tutor.js — these four
    // words are machine-read identifiers, so the one-language rule does not
    // apply to them and the model must not translate them.
    'Answer with exactly one of these four words in lowercase English and nothing else. They are fixed identifiers: never translate them, never add punctuation or explanation.',
  ].join(' ');

  try {
    const raw = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Which one is it?' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      { temperature: 0, maxTokens: 12, model: VISION_MODEL, trace, name: 'scan-classify' }
    );
    const label = normalizeLabel(raw);
    trace.end({ output: label, metadata: { raw } });
    return label;
  } catch (e) {
    console.warn('identifyObject failed:', e.message);
    trace.end({ output: 'none', metadata: { error: e.message } });
    return 'none';
  }
}

function normalizeLabel(raw) {
  const text = (raw || '').trim().toLowerCase();
  if (SCAN_LABELS.includes(text)) return text;
  for (const [label, re] of LABEL_PATTERNS) if (re.test(text)) return label;
  return 'none';
}
