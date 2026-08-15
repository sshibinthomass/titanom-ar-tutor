/**
 * The home screen — the app's front door, over the 3D scene.
 *
 * Two ways in, and they answer the same question ("what are we working on?")
 * from opposite ends:
 *  1. **Scan an object** — open the rear camera, take one photo, and let
 *     DeutschlandGPT vision (vision.js) say which of the app's objects it is.
 *     A hit selects that model automatically; `none` drops the user on the
 *     picker rather than guessing.
 *  2. **Select an object** — the plain list, for when the object isn't in front
 *     of you (or the camera / AI isn't available).
 *
 * The module owns the overlay's DOM and the camera lifecycle; it does *not*
 * know the model registry. The caller passes `getOptions()` (fresh each render,
 * so a language switch relabels), a `scanMap` from vision label → model key,
 * and `onPick(key)`.
 *
 * Each view is a page with its own link (`#/`, `#/scan`, `#/objects`), so the
 * buttons here don't switch view themselves — they **ask** for one
 * (`onView(name)`), the caller routes, and the route calls `openHome(view)`
 * back. One direction only: without it, a click would change the view and the
 * resulting navigation would change it a second time, restarting the camera.
 *
 * The camera is the one resource here that leaks visibly — a stream left open
 * keeps the phone's camera indicator lit — so every exit from the scan view
 * (capture, back, pick, closing the overlay, a page hide) runs through
 * `releaseCamera()`.
 */
import { t } from './i18n.js';
import { startCamera, stopCamera, captureFrame, identifyObject } from './vision.js';

let el = null;          // cached DOM refs
let cfg = null;         // { getOptions, scanMap, onPick, onView }
const VIEWS = ['choose', 'scan', 'pick'];
let view = 'choose';    // which of VIEWS is on screen — mirrors the route
let stream = null;      // live camera stream, or null
let scanSeq = 0;        // newest scan wins: a slow classification can't apply after Back
let scanPhase = 'live'; // 'live' (aiming) | 'result' (a still on screen) — the
                        // capture button is the same button in both, so its
                        // action is dispatched from here rather than rebound.

export function initHome(options) {
  cfg = options;
  el = {
    root: document.getElementById('home'),
    choose: document.getElementById('homeChoose'),
    pick: document.getElementById('homePick'),
    scan: document.getElementById('homeScan'),
    list: document.getElementById('homeList'),
    scanBtn: document.getElementById('homeScanBtn'),
    selectBtn: document.getElementById('homeSelectBtn'),
    video: document.getElementById('homeVideo'),
    shot: document.getElementById('homeShot'),
    capture: document.getElementById('homeCapture'),
    scanStatus: document.getElementById('homeScanStatus'),
    scanAlt: document.getElementById('homeScanAlt'),
    backs: document.querySelectorAll('[data-home-back]'),
  };

  // These ask for a view rather than showing one — see the module header.
  el.scanBtn.addEventListener('click', () => cfg.onView('scan'));
  el.selectBtn.addEventListener('click', () => cfg.onView('pick'));
  for (const b of el.backs) b.addEventListener('click', () => cfg.onView('choose'));
  el.scanAlt.addEventListener('click', () => cfg.onView('pick'));
  // Retake is not a view change — it re-arms the camera on the page we are on.
  el.capture.addEventListener('click', () => (scanPhase === 'live' ? capture() : showScan()));

  // A backgrounded tab keeps the camera on otherwise — on a phone that reads as
  // the app spying while the user is in another app.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseCamera();
  });

  renderList();
}

export function isHomeOpen() {
  return el?.root.classList.contains('show') || false;
}

/**
 * Open the home screen on one of its views — the router's entry point, so this
 * is also what a pasted `#/scan` link runs.
 *
 * Re-opening the view already on screen is a no-op: the same route can arrive
 * twice (a click that navigates, then the `hashchange` it caused) and the
 * second one must not re-open the camera.
 */
export function openHome(next = 'choose') {
  if (!el || !VIEWS.includes(next)) return;
  renderList();
  const reopening = el.root.classList.contains('show') && next === view;
  el.root.classList.add('show');
  document.body.classList.add('home-open');
  if (reopening) return;
  if (next === 'scan') showScan();
  else showView(next);
}

/** Which view is on screen — the module's half of the route. */
export function homeView() {
  return view;
}

export function closeHome() {
  if (!el) return;
  releaseCamera();
  el.root.classList.remove('show');
  document.body.classList.remove('home-open');
}

/** Re-render the option labels after a language switch (the static strings are
 *  handled by applyStaticTranslations; the model names are not). */
export function refreshHome() {
  if (!el) return;
  renderList();
  if (!el.scan.hidden) {
    setScanStatus(statusKey, statusVars);
    el.capture.textContent = t(scanPhase === 'live' ? 'scan.capture' : 'scan.retake');
  }
}

// ---- Views -----------------------------------------------------------------

function showView(name) {
  scanSeq++;                       // abandon any classification still in flight
  if (name !== 'scan') releaseCamera();
  view = name;
  el.choose.hidden = name !== 'choose';
  el.pick.hidden = name !== 'pick';
  el.scan.hidden = name !== 'scan';
}

function renderList() {
  if (!cfg) return;
  el.list.innerHTML = '';
  for (const { key, label } of cfg.getOptions()) {
    const btn = document.createElement('button');
    btn.className = 'home-item';
    btn.textContent = label;
    btn.addEventListener('click', () => pick(key));
    el.list.appendChild(btn);
  }
}

function pick(key) {
  closeHome();
  cfg.onPick(key);
}

// ---- Scan ------------------------------------------------------------------

async function showScan() {
  showView('scan');
  scanPhase = 'live';
  el.shot.hidden = true;
  el.video.hidden = false;
  el.capture.textContent = t('scan.capture');
  el.capture.disabled = true;
  setScanStatus('scan.starting');
  try {
    stream = await startCamera(el.video);
    el.capture.disabled = false;
    setScanStatus('scan.hint');
  } catch (e) {
    // A denied permission is the common case and has its own fix; everything
    // else (no camera, insecure context, device in use) shares one line, since
    // the user's move is the same either way — use the list.
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    setScanStatus(denied ? 'scan.blocked' : 'scan.noCamera');
    el.capture.disabled = true;
  }
}

async function capture() {
  const seq = ++scanSeq;
  let shot;
  try {
    shot = captureFrame(el.video);
  } catch {
    setScanStatus('scan.noFrame');
    return;
  }

  // Freeze the still in place of the live preview: the classification takes a
  // second or two and a moving preview invites the user to keep aiming at
  // something the model is no longer looking at.
  el.shot.src = shot;
  el.shot.hidden = false;
  el.video.hidden = true;
  el.capture.disabled = true;
  releaseCamera();
  setScanStatus('scan.identifying');

  const label = await identifyObject(shot);
  if (seq !== scanSeq) return;     // user went Back (or re-scanned) meanwhile

  const key = cfg.scanMap[label];
  if (!key) {
    // 'none' also covers "the AI isn't configured or didn't answer" — one
    // dead end, one way out: retake, or use the list.
    scanPhase = 'result';
    setScanStatus('scan.none');
    el.capture.textContent = t('scan.retake');
    el.capture.disabled = false;
    return;
  }

  const option = cfg.getOptions().find((o) => o.key === key);
  setScanStatus('scan.found', { object: option?.label || key });
  // A beat to read the result before the overlay drops — otherwise the answer
  // flashes past and the model just changes on its own.
  setTimeout(() => { if (seq === scanSeq) pick(key); }, 900);
}

// The scan's status line is generated, not static markup, so — like main.js's
// status pill — it remembers its key rather than its rendered text and can be
// re-read in the new language.
let statusKey = 'scan.hint';
let statusVars = null;
function setScanStatus(key, vars = null) {
  statusKey = key;
  statusVars = vars;
  el.scanStatus.textContent = t(key, vars);
}

function releaseCamera() {
  stopCamera(stream, el?.video);
  stream = null;
}
