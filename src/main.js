import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildExplodedView, setExplode, setPartExplode, isolateParts, clearPartStates, setHighlight } from './explode.js';
import { updateTweens, tweenTo, cancelTween, isTweening, easeInOutCubic, flyToParts, moveCamera } from './animate.js';
import { attachPicker, attachDragger } from './select.js';
import { MODE_LIST, resolveFix, resolveAssemble, resolveDiagnose, resolveQuiz, applyNames, knowledgeDigest, describePart, fixSuggestions, resolvePlanParts } from './modes.js';
import { isARSupported, startAR, updateAR, endAR, requestMove, setInteractor, setManipulationEnabled, setPivotScale, getFitScale } from './ar.js';
import { startPuzzle, stopPuzzle, updatePuzzle, puzzleInteractor, isPuzzleActive, puzzleAutoPlace, puzzleHintIndices, puzzleStatus } from './puzzle.js';
import { speak, stop as stopSpeaking, isSpeaking } from './tts.js';
import { primeSfx, playSfx } from './sfx.js';
import { createRecognizer } from './voice.js';
import { answerQuestion, answerDiagnosis, explainNextPart, generateFixPlan } from './tutor.js';
import { aiAvailable } from './ai.js';
import { initTelemetry, track } from './telemetry.js';

// ---- Model registry --------------------------------------------------------

// Vite's base URL ('./' here) so model paths resolve under the GitHub Pages
// sub-path (…/titanom-ar-tutor/) as well as at localhost root. An absolute
// '/models/…' would wrongly point at the domain root on Pages.
const BASE_URL = import.meta.env.BASE_URL;

// Single source of truth for "which model does the app boot into".
const DEFAULT_MODEL = 'markus-chair';

// The IKEA Markus is the hero: every mode's content is authored against it and
// grounded in the official manual, so it is listed first, selected on boot, and
// is the only model fetched at startup. The rest are secondary demos, loaded
// lazily only if the user picks one.
//
// `realHeight` is the object's true height in metres. AR normally fits a model
// to a ~0.7 m tabletop size, which is fine for looking at but wrong for
// learning: the point of the Assemble puzzle is that reaching for a part in the
// room rehearses the real thing, so the puzzle asks AR for life-size instead.
const MODELS = {
  'markus-chair': {
    label: 'IKEA Markus Chair',
    url: `${BASE_URL}models/markus-chair/scene.gltf`,
    credit: 'IKEA Markus Office Chair — Graham Rust, Sketchfab Standard',
    creditUrl: 'https://sketchfab.com/3d-models/ikea-markus-office-chair-cee12c29ebda4bcdb91b84a6f126a971',
    defaultMode: 'group', // already 47 separate meshes → one clean part per mesh
    realHeight: 1.29,     // IKEA spec: 129 cm to the top of the headrest
  },
  'office-chair': {
    label: 'Office Chair',
    url: `${BASE_URL}models/office-chair/scene.gltf`,
    credit: 'Office Chair Modern — thethieme, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/office-chair-modern-675f34f7304e4d92812a41e9750539aa',
    defaultMode: 'component', // single fused mesh → must split by connected pieces
  },
  bicycle: {
    label: 'Bicycle',
    url: `${BASE_URL}models/bicycle/scene.gltf`,
    credit: 'bicycle — local.yany, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/bicycle-8db2d442b58045baac2edfc5e9ee11e3',
    defaultMode: 'group', // 14 meshes, one per material → clean semantic parts
    realHeight: 1.05,
  },
  bed: {
    label: 'Bed Low Poly',
    url: `${BASE_URL}models/bed/scene.gltf`,
    credit: 'Bed Low Poly — LinNacume, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/bed-low-poly-b19855811635449288827767b45d4b38',
    defaultMode: 'component', // single merged mesh → must split by connected pieces
    realHeight: 0.6,
  },
};

// ---- Renderer / scene / camera ---------------------------------------------

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Scene backdrop tracks the UI theme (set for real by applyTheme() below);
// this light default just avoids a first-frame flash before that runs.
const SCENE_BG = { light: 0xe9ecf1, dark: 0x14161c };
scene.background = new THREE.Color(SCENE_BG.light);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(3, 2.2, 3.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// Grabbing the scene mid-flight aborts the flight — otherwise the tween keeps
// writing camera.position and fights whatever the user is dragging.
controls.addEventListener('start', () => cancelTween('camera'));

// ---- Lighting --------------------------------------------------------------

scene.add(new THREE.HemisphereLight(0xffffff, 0x33353d, 0.9));

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 6, 3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
scene.add(key);

const fill = new THREE.DirectionalLight(0xaac4ff, 0.6);
fill.position.set(-4, 2, -3);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShadowMaterial({ opacity: 0.28 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- UI references ---------------------------------------------------------

const ui = {
  model: document.getElementById('model'),
  mode: document.getElementById('mode'),
  explode: document.getElementById('explode'),
  explodeVal: document.getElementById('explodeVal'),
  tint: document.getElementById('tint'),
  wireframe: document.getElementById('wireframe'),
  autorotate: document.getElementById('autorotate'),
  reset: document.getElementById('reset'),
  status: document.getElementById('status'),
  partCount: document.getElementById('partCount'),
  legend: document.getElementById('legend'),
  credit: document.getElementById('credit'),
  modebar: document.getElementById('modebar'),
  card: document.getElementById('card'),
  cardKicker: document.getElementById('cardKicker'),
  cardBody: document.getElementById('cardBody'),
  cardMeta: document.getElementById('cardMeta'),
  cardChips: document.getElementById('cardChips'),
  cardNav: document.getElementById('cardNav'),
  stepPrev: document.getElementById('stepPrev'),
  stepNext: document.getElementById('stepNext'),
  startAR: document.getElementById('startAR'),
  exitAR: document.getElementById('exitAR'),
  micBtn: document.getElementById('micBtn'),
  voiceCaption: document.getElementById('voiceCaption'),
  panelToggle: document.getElementById('panelToggle'),
  themeToggle: document.getElementById('themeToggle'),
  panel: document.querySelector('.panel'),
  sheetBackdrop: document.getElementById('sheetBackdrop'),
};

// ---- State -----------------------------------------------------------------

const loader = new GLTFLoader();
const gltfCache = new Map();
let parts = [];
let explodedGroup = null;
let originalScene = null;
let modelRadius = 1;
let modelHeight = 1;   // local-unit height at rest; the basis for AR life-size sizing

function currentModel() {
  return MODELS[ui.model.value];
}

// Populate model dropdown.
for (const [key, m] of Object.entries(MODELS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = m.label;
  ui.model.appendChild(opt);
}
ui.model.value = DEFAULT_MODEL; // hero model: richest authored content (parts, specs, official-manual grounding)

// Telemetry: one Langfuse session per page load. Tracks voice, AI, modes, AR,
// TTS and errors. No-op (and never throws) when Langfuse isn't configured.
initTelemetry({ initialModel: ui.model.value });

// Generate the puzzle's ElevenLabs sound cues now, not when Assemble opens:
// generation takes seconds, and they'd miss the moment they punctuate. Cached
// in localStorage, so this is one round of requests per browser, ever.
primeSfx();

// ---- Load + build ----------------------------------------------------------

function loadModel(key) {
  const m = MODELS[key];
  ui.credit.innerHTML = `<a href="${m.creditUrl}" target="_blank" rel="noopener">${m.credit}</a>`;
  ui.mode.value = m.defaultMode;

  if (gltfCache.has(key)) {
    originalScene = gltfCache.get(key);
    rebuild();
    ui.status.textContent = 'Ready — drag to orbit, use the slider to explode.';
    return;
  }

  ui.status.textContent = 'Loading model…';
  loader.load(
    m.url,
    (gltf) => {
      gltfCache.set(key, gltf.scene);
      originalScene = gltf.scene;
      ui.status.textContent = 'Splitting into component parts…';
      rebuild();
      ui.status.textContent = 'Ready — drag to orbit, use the slider to explode.';
    },
    (evt) => {
      if (evt.total) ui.status.textContent = `Loading model… ${Math.round((evt.loaded / evt.total) * 100)}%`;
    },
    (err) => {
      console.error(err);
      ui.status.textContent = 'Failed to load model. Check the console.';
    }
  );
}

function rebuild() {
  stopPuzzle(); // release the ghosts before the geometry they borrow is disposed
  // Any tween in flight still points at the outgoing part list — drop them both
  // before the meshes are disposed.
  cancelTween('explode');
  cancelTween('camera');
  if (explodedGroup) {
    scene.remove(explodedGroup);
    for (const p of parts) p.mesh.geometry.dispose();
  }

  const built = buildExplodedView(originalScene, {
    mode: ui.mode.value,
    tint: ui.tint.checked,
  });
  explodedGroup = built.group;
  parts = built.parts;
  applyNames(ui.model.value, parts); // semantic names for single-material models
  scene.add(explodedGroup);

  applyWireframe(ui.wireframe.checked);
  frameModel();
  buildLegend();
  ui.partCount.textContent = String(parts.length);
  onExplodeChange();
  enterMode(currentMode); // re-init the active mode against the new part list

  // DEBUG: expose part geometry (world-space bbox) for authoring semantic names.
  window.__parts = parts.map((p, i) => {
    p.mesh.geometry.computeBoundingBox();
    const b = p.mesh.geometry.boundingBox;
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    return { i, tris: p.triangleCount,
      cx: +c.x.toFixed(3), cy: +c.y.toFixed(3), cz: +c.z.toFixed(3),
      sx: +s.x.toFixed(3), sy: +s.y.toFixed(3), sz: +s.z.toFixed(3) };
  });
}

/**
 * Fit the scene to a freshly built model: ground/shadow sizing, clip planes,
 * slider range, and the home camera pose.
 *
 * Only ever called at rebuild time, with the parts at rest. It must NOT be
 * re-run to "reset the view" — measuring a spread-out model would inflate
 * modelRadius and, with it, the explode slider's own maximum. Use homeView().
 */
function frameModel() {
  const box = new THREE.Box3().setFromObject(explodedGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // While the puzzle has parts scattered the bounding box is meaningless as a
  // measure of the object, so keep the at-rest figures the whole app derives
  // from (explode range, ground size, AR life-size scale).
  if (!isPuzzleActive()) {
    modelRadius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    modelHeight = size.y || 1;
  }

  // Drop model onto the ground plane and centre it at origin X/Z.
  explodedGroup.position.set(-center.x, -box.min.y, -center.z);

  // Size the shadow-catcher ground + shadow camera to the model.
  ground.scale.set(modelRadius * 20, modelRadius * 20, 1);
  key.position.set(modelRadius * 4, modelRadius * 6, modelRadius * 3);
  const sc = key.shadow.camera;
  sc.near = modelRadius * 0.1;
  sc.far = modelRadius * 30;
  sc.left = -modelRadius * 2.5; sc.right = modelRadius * 2.5;
  sc.top = modelRadius * 2.5; sc.bottom = -modelRadius * 2.5;
  sc.updateProjectionMatrix();

  // Projection + framing always apply immediately; only the pose is optionally flown.
  camera.near = modelRadius * 0.01;
  camera.far = modelRadius * 200;
  camera.updateProjectionMatrix();

  const dist = modelRadius * 3.2;
  homePos.set(dist * 0.8, size.y * 0.6 + dist * 0.4, dist * 0.9);
  homeTarget.set(0, size.y * 0.5, 0);
  homeView();

  ui.explode.max = (modelRadius * 2.5).toFixed(3);
  ui.explode.step = (modelRadius * 0.004).toFixed(4);
  ui.explode.value = 0;
}

// The default framing, captured by frameModel() when the model was built.
const homePos = new THREE.Vector3();
const homeTarget = new THREE.Vector3();

/**
 * Return the camera to that default framing — the Reset button and "recenter".
 * Skipped during AR for the same reason as flyTo(): `camera` is the device pose
 * there. "Recenter" is still reachable by voice mid-session, so the guard has to
 * live here rather than at the call sites.
 *
 * `zoom` pulls the same pose further out along its own axis, for the Assemble
 * puzzle: it scatters parts in a ring well outside the model's own bounds, and
 * re-running frameModel() to widen the shot would inflate modelRadius (see its
 * warning) and with it the explode slider's range.
 */
const _wide = new THREE.Vector3();
function homeView({ animate = false, zoom = 1 } = {}) {
  if (renderer.xr.isPresenting) return;
  const pos = zoom === 1 ? homePos : _wide.copy(homePos).sub(homeTarget).multiplyScalar(zoom).add(homeTarget);
  moveCamera(camera, controls, pos, homeTarget, { animate });
}

function buildLegend() {
  ui.legend.innerHTML = '';
  parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const mat = Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material;
    swatch.style.background = mat && mat.color ? '#' + mat.color.getHexString() : '#8a8f9a';
    const label = document.createElement('span');
    label.textContent = p.label;
    row.append(swatch, label);
    row.addEventListener('mouseenter', () => highlight(i, true));
    row.addEventListener('mouseleave', () => highlight(i, false));
    ui.legend.appendChild(row);
  });
}

const _origEmissive = new Map();
function highlight(index, on) {
  const mat = Array.isArray(parts[index].mesh.material) ? parts[index].mesh.material[0] : parts[index].mesh.material;
  if (!mat || !mat.emissive) return;
  if (on) {
    _origEmissive.set(index, mat.emissive.getHex());
    mat.emissive.setHex(0x3355ff);
    mat.emissiveIntensity = 0.8;
  } else {
    mat.emissive.setHex(_origEmissive.get(index) ?? 0x000000);
    mat.emissiveIntensity = 1.0;
  }
}

// ---- Controls wiring -------------------------------------------------------

function onExplodeChange() {
  const amount = parseFloat(ui.explode.value);
  // The puzzle owns every part's position while it runs — setExplode would yank
  // the piece out of the user's hand and undo the scatter.
  if (!isPuzzleActive()) {
    setExplode(parts, amount);
    groundExploded(); // exploding pushes parts every direction incl. down — keep them above the floor
  }
  updateExplodeReadout(amount);
}

// Slider value + numeric readouts. Split out of onExplodeChange because the
// explode tween positions parts itself (per-part, staggered) and must not go
// back through setExplode — that would flatten the cascade to a uniform amount.
function updateExplodeReadout(amount) {
  ui.explodeVal.textContent = amount.toFixed(2);
  // Keep the Explore card's inline slider in step with the panel slider.
  if (cardExplode) {
    cardExplode.slider.value = ui.explode.value;
    cardExplode.val.textContent = amount.toFixed(2);
  }
}

// Fraction of the tween spent handing off between parts. Each part eases over
// the remaining window, so the model unpeels outward instead of inflating as one
// rigid shell. Parts are ordered largest-first, so the big shapes lead.
const EXPLODE_STAGGER = 0.45;

/**
 * Set the explode amount programmatically, optionally animated.
 *
 * Dragging the slider stays instant (a tweened drag just feels laggy); every
 * *indirect* change — entering a mode, a voice command, Reset — animates.
 */
function setExplodeAmount(amount, { animate = false, duration = 700 } = {}) {
  // The puzzle owns every part's position. The tween below writes parts directly
  // via setPartExplode(), so onExplodeChange's guard can't catch it — a voice
  // "explode" mid-build would otherwise tear the piece out of the user's hand.
  if (isPuzzleActive()) return;
  const to = THREE.MathUtils.clamp(amount, parseFloat(ui.explode.min) || 0, parseFloat(ui.explode.max));
  const from = parseFloat(ui.explode.value) || 0;

  if (!animate) {
    cancelTween('explode');
    ui.explode.value = to;
    onExplodeChange();
    return;
  }
  // Already there (e.g. Fix → Diagnose, both at the same mild spread): don't
  // collapse and re-expand for nothing.
  if (Math.abs(to - from) < 1e-4) return;

  const n = parts.length;
  tweenTo('explode', {
    duration,
    onUpdate: (eased, raw) => {
      for (let i = 0; i < n; i++) {
        const start = n > 1 ? (i / (n - 1)) * EXPLODE_STAGGER : 0;
        const local = THREE.MathUtils.clamp((raw - start) / (1 - EXPLODE_STAGGER), 0, 1);
        setPartExplode(parts[i], from + (to - from) * easeInOutCubic(local));
      }
      groundExploded();
      ui.explode.value = from + (to - from) * eased;
      updateExplodeReadout(parseFloat(ui.explode.value));
    },
  });
}

/**
 * Bounds of the model with every part at rest — what AR sizes its placement
 * against, so "fit to 0.7 m" always means the assembled object regardless of how
 * far it happens to be exploded when the session starts.
 *
 * Computed without touching the live positions: parts rest at the group origin
 * with their geometry baked to world space, so the union of their geometry
 * bounding boxes *is* the assembled model. Only the size carries over — the
 * placement itself is fully determined by the invariant that frameModel() and
 * groundExploded() maintain at rest (centred in x/z, bottom on the floor), and
 * the group's live y is contaminated by the current explode.
 */
function restBounds() {
  const local = new THREE.Box3();
  for (const p of parts) {
    if (!p.mesh.geometry.boundingBox) p.mesh.geometry.computeBoundingBox();
    local.union(p.mesh.geometry.boundingBox);
  }
  if (local.isEmpty()) return null;
  const size = local.getSize(new THREE.Vector3());
  return new THREE.Box3(
    new THREE.Vector3(-size.x / 2, 0, -size.z / 2),
    new THREE.Vector3(size.x / 2, size.y, size.z / 2)
  );
}

// Lift the whole exploded group so its lowest point rests on the ground plane
// (never sinks below it — the complaint in Diagnose, where parts fan out downward).
// Works in the group's PARENT frame, so it's correct both on the desktop scene
// (parent = scene, ground = world y0) and in AR (parent = pivot, ground = the
// floor anchor at pivot y0). Yaw + uniform scale preserve the vertical axis, so
// the parent-local box bottom is the real lowest point.
function groundExploded() {
  if (!explodedGroup || !explodedGroup.parent) return;
  const parent = explodedGroup.parent;
  parent.updateWorldMatrix(true, false);
  const invParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const box = new THREE.Box3().setFromObject(explodedGroup).applyMatrix4(invParent);
  if (box.isEmpty()) return;
  explodedGroup.position.y -= box.min.y; // shift so the parent-local bottom sits at 0
}
// A direct drag wins over any animation still in flight.
ui.explode.addEventListener('input', () => { cancelTween('explode'); onExplodeChange(); });

ui.model.addEventListener('change', () => { track('model-load', { metadata: { model: ui.model.value } }); loadModel(ui.model.value); });
ui.mode.addEventListener('change', () => { if (originalScene) rebuild(); });
ui.tint.addEventListener('change', () => { if (originalScene) rebuild(); });

function applyWireframe(on) {
  for (const p of parts) {
    const mats = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material];
    for (const m of mats) m.wireframe = on;
  }
}
ui.wireframe.addEventListener('change', () => applyWireframe(ui.wireframe.checked));

ui.reset.addEventListener('click', () => {
  setExplodeAmount(0, { animate: true });
  homeView({ animate: true });
});

window.addEventListener('resize', resize);

// ---- Modes -----------------------------------------------------------------
// Every mode drives the same core (explode + isolate/highlight + visibility).
// State lives here; each enter*() sets up the card + part visuals for a mode.

let currentMode = 'explore';
let selectedPart = -1;
let steps = [];        // fix / assemble: [{ index, text }]
let stepIndex = 0;
let stepTitle = '';
let stepKicker = '';
let diagnoses = [];    // diagnose: [{ symptoms, index, text }]
let diagnoseSeq = 0;   // guards against out-of-order AI answers when chips are tapped quickly
let quizItems = [];    // quiz: [{ index, question, answer }]
let quizIndex = 0;
let quizRevealed = false;
let focusedPart = null; // name of the currently highlighted part (for the tutor)
let cardExplode = null; // Explore card's inline explode slider { slider, val }, or null

function currentKey() { return ui.model.value; }

// Speak text via ElevenLabs (with fallback).
function say(text) {
  if (!text) return;
  speak(text);
}

// Build the mode-switch bar once.
for (const m of MODE_LIST) {
  const btn = document.createElement('button');
  btn.className = 'modebtn';
  btn.dataset.mode = m.id;
  btn.textContent = m.label;
  btn.addEventListener('click', () => enterMode(m.id));
  ui.modebar.appendChild(btn);
}

function setModeButtons(active) {
  for (const b of ui.modebar.children) b.classList.toggle('active', b.dataset.mode === active);
}

function showCard(kicker, bodyHtml, meta = '', { chips = null, nav = false } = {}) {
  ui.cardKicker.textContent = kicker;
  ui.cardBody.innerHTML = bodyHtml;
  ui.cardMeta.textContent = meta;
  ui.cardNav.style.display = nav ? 'flex' : 'none';
  ui.cardChips.innerHTML = '';
  if (chips) {
    for (const c of chips) {
      const el = document.createElement('button');
      el.className = 'chip';
      el.textContent = c.label;
      el.addEventListener('click', c.onClick);
      ui.cardChips.appendChild(el);
    }
  }
  ui.card.classList.add('show');
}
function hideCard() { ui.card.classList.remove('show'); }

// Reset all part visuals to a clean, fully-assembled, fully-visible state.
// The collapse animates, but a mode that immediately re-spreads (Fix, Diagnose,
// Quiz) replaces the tween before it ticks, so there's no collapse-then-expand
// flicker on the way in — see setExplodeAmount's no-op guard.
function resetParts() {
  clearPartStates(parts);
  for (const p of parts) p.mesh.visible = true;
  setExplodeAmount(0, { animate: true });
}

// Spread parts a little so the highlighted one is easy to see in a procedure.
function mildExplode() {
  setExplodeAmount(parseFloat(ui.explode.max) * 0.35, { animate: true });
}

/**
 * Frame a step's part(s): the guided modes move the camera to whatever they just
 * spotlighted, so the user never has to hunt for the glowing piece.
 *
 * Skipped during AR, where `camera` is the device pose and writing to it would
 * fight WebXR — there you walk around the object instead.
 */
function flyTo(indices) {
  if (renderer.xr.isPresenting || !indices || !indices.length) return;
  flyToParts({
    camera,
    controls,
    parts,
    indices,
    // Never closer than roughly the model's own size, or framing a caster would
    // put the camera inside the chair.
    minDistance: modelRadius * 1.15,
    maxDistance: modelRadius * 4,
  });
}

function enterMode(id) {
  track('mode-switch', { metadata: { mode: id, model: ui.model.value } });
  currentMode = id;
  setModeButtons(id);
  cardExplode = null; // drop any stale inline slider before the card is rebuilt
  stopPuzzle();       // before resetParts, which assumes it owns part positions
  applyARInteraction();
  resetParts();
  selectedPart = -1;
  if (!parts.length) { hideCard(); return; }

  if (id === 'explore') return enterExplore();
  if (id === 'fix') return enterFix();
  if (id === 'assemble') return enterAssemble();
  if (id === 'diagnose') return enterDiagnose();
  if (id === 'quiz') return enterQuiz();
}

// --- Explore: tap a part, isolate + name it ---
function enterExplore() {
  showCard('Explore', 'Tap any part to isolate it, then tap 🎤 and ask about it. Drag the slider to spread the parts apart.', `${parts.length} parts`);
  addCardExplodeSlider();
}

// An explode slider right inside the Explore card, so parts can be spread apart
// without opening the Controls sheet (hidden on mobile and during AR). It mirrors
// the panel slider — both drive onExplodeChange, which keeps the two in sync.
function addCardExplodeSlider() {
  const wrap = document.createElement('div');
  wrap.className = 'card-explode';
  const label = document.createElement('label');
  label.textContent = 'Explode';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = ui.explode.min;
  slider.max = ui.explode.max;
  slider.step = ui.explode.step;
  slider.value = ui.explode.value;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = parseFloat(ui.explode.value).toFixed(2);
  slider.addEventListener('input', () => {
    ui.explode.value = slider.value;
    onExplodeChange();
  });
  wrap.append(label, slider, val);
  ui.cardBody.appendChild(wrap);
  cardExplode = { slider, val };
}

// --- Fix: voice-first, DGPT-planned repair ------------------------------------
// The user says (or taps a suggested) problem; DeutschlandGPT drafts a step plan
// grounded in the authored knowledge digest and constrained to the live part
// names, and the app walks it with the same isolate + camera-flight + TTS
// pipeline the authored procedure used. Without DGPT the authored procedure
// runs exactly as before — the fallback, not the feature.
let fixState = 'ask';   // 'ask' (waiting for a problem) | 'planning' | 'guided'
let fixSeq = 0;         // newest fix request wins if two plans race

function enterFix() {
  fixSeq++; // drop any plan still in flight from a previous visit / old part list
  if (!aiAvailable()) {
    const proc = resolveFix(currentKey(), parts);
    steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'Fix';
    fixState = 'guided';
    mildExplode();
    renderStep();
    return;
  }
  showFixAsk();
}

// The ask-screen: what problem are we solving? The chips are authored symptoms
// (fixSuggestions) but they are only canned voice inputs — tapping one and
// speaking a phrase feed the same planner. `lead` lets a finished or failed
// plan re-ask with its own line instead of the default question.
function showFixAsk(lead = '') {
  fixState = 'ask';
  steps = [];
  focusedPart = null;
  clearPartStates(parts);
  setExplodeAmount(0, { animate: true });
  const chips = fixSuggestions(currentKey()).map((label) => ({
    label: `🔧 ${label}`,
    onClick: () => startFixRequest(label),
  }));
  showCard(
    'Fix',
    `<b>${lead || 'What should we fix?'}</b><span class="partdesc">Tap 🎤 and describe the problem — or pick one below.</span>`,
    '',
    { chips }
  );
  say(lead || 'What should we fix? Describe the problem, or pick a suggestion.');
}

/** A problem arrived (spoken or tapped): plan it with DGPT and start the walkthrough. */
async function startFixRequest(request) {
  const my = ++fixSeq;
  fixState = 'planning';
  track('fix-request', { input: request, metadata: { model: ui.model.value } });
  showCard('Fix', `<b>“${request}”</b><span class="partdesc">…planning the repair</span>`);
  showCaption(`“${request}” · …planning`);

  const plan = await generateFixPlan(getContext(), request);
  if (my !== fixSeq || currentMode !== 'fix') return; // superseded, or the mode was left

  if (!plan || !plan.steps.length) {
    if (plan?.intro) { showFixAsk(plan.intro); return; } // "that's not fixable here, because…"
    // AI unreachable mid-request: run the authored procedure so the demo never dead-ends.
    const proc = resolveFix(currentKey(), parts);
    steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'Fix';
    fixState = 'guided';
    track('fix-plan-fallback', { metadata: { model: ui.model.value } });
    mildExplode();
    renderStep();
    return;
  }

  steps = plan.steps.map((s) => ({ indices: resolvePlanParts(parts, s.parts), text: s.text }));
  stepIndex = 0;
  stepTitle = plan.title || `Fix: ${request}`;
  stepKicker = 'Fix';
  fixState = 'guided';
  track('fix-plan', { metadata: { model: ui.model.value, steps: steps.length, request } });
  mildExplode();
  if (plan.intro) showCaption(plan.intro);
  renderStep(plan.intro);
}

// `preface` is the plan's intro sentence, spoken once ahead of the first step.
function renderStep(preface = '') {
  const title = stepTitle, kicker = stepKicker;
  if (!steps.length) { showCard(kicker, 'No procedure for this model yet.'); return; }
  const s = steps[stepIndex];
  const stepIndices = s.indices || [];

  isolateParts(parts, stepIndices); // spotlight this step's part(s), dim the rest
  flyTo(stepIndices); // and bring it to the user rather than making them orbit for it

  const partName = stepIndices.length ? parts[stepIndices[0]].name : null;
  focusedPart = partName;
  const chips = kicker === 'Fix' && aiAvailable()
    ? [{ label: '🎤 Fix something else', onClick: () => { stopSpeaking(); showFixAsk(); } }]
    : null;
  showCard(
    kicker,
    `<b>${title}</b><br>${s.text}`,
    `Step ${stepIndex + 1} of ${steps.length}` + (partName ? ` · ${partName}` : ' · (part not matched)'),
    { nav: true, chips }
  );
  ui.stepPrev.disabled = stepIndex === 0;
  ui.stepNext.textContent = stepIndex === steps.length - 1 ? 'Done ✔' : 'Next ▶';
  say(preface ? `${preface} ${s.text}` : s.text);
}
function goStep(delta) {
  if (!steps.length) return;
  // 'Done ✔' on the last Fix step closes the plan and asks for the next problem.
  if (delta > 0 && stepIndex === steps.length - 1) {
    if (stepKicker === 'Fix' && aiAvailable()) showFixAsk('Done — that should sort it. Anything else to fix?');
    return;
  }
  stepIndex = Math.max(0, Math.min(steps.length - 1, stepIndex + delta));
  renderStep();
}
ui.stepPrev.addEventListener('click', () => goStep(-1));
ui.stepNext.addEventListener('click', () => goStep(1));

// --- Assemble: drag-to-build puzzle -----------------------------------------
// The parts scatter in a ring, the current slot is drawn as a ghost, and the
// user drags the piece they think comes next into it. The engine (puzzle.js)
// owns all the 3D; this section owns the card, the voice, and the AI correction.

let hintTimer = null;
let wrongSeq = 0;     // newest wrong answer wins if two corrections race
let arLifeSize = false;

function enterAssemble() {
  const proc = resolveAssemble(currentKey(), parts);
  steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'Assemble';
  setExplodeAmount(0); // collapse to rest *before* the puzzle takes over positions
  if (!steps.length) { showCard('Assemble', 'No procedure for this model yet.'); return; }

  startPuzzle({
    group: explodedGroup, parts, steps, radius: modelRadius,
    onStep: onPuzzleStep,
    onCorrect: onPuzzleCorrect,
    onWrong: onPuzzleWrong,
    onCarry: onPuzzleCarry,
    onComplete: onPuzzleComplete,
  });
  playSfx('dismantle'); // rides the opening teardown startPuzzle just kicked off
  track('puzzle-start', { metadata: { model: ui.model.value, steps: steps.length } });

  applyARInteraction();                       // life-size + lock the board in AR
  homeView({ animate: true, zoom: 2.1 });     // pull back to take in the scatter ring
}

/**
 * Reconcile AR with whether a puzzle is running.
 *
 * Two things change: whole-model gestures are retired (a drag must never slide
 * the board out from under the piece being placed — voice "move it" still
 * repositions), and the model is shown life-size rather than at the ~0.7 m
 * tabletop fit, so reaching for a part rehearses the real reach.
 */
function applyARInteraction() {
  if (!renderer.xr.isPresenting) { arLifeSize = false; return; }
  const puzzling = isPuzzleActive();
  setManipulationEnabled(!puzzling);

  if (puzzling && !arLifeSize) {
    const fit = getFitScale();                  // ar.js's fit-to-0.7 m group scale
    const real = currentModel().realHeight;
    if (real && modelHeight && fit) { setPivotScale(real / (modelHeight * fit)); arLifeSize = true; }
  } else if (!puzzling && arLifeSize) {
    setPivotScale(1);                           // back to the tabletop fit
    arLifeSize = false;
  }
}

// `done` overrides how many steps count as finished — on a correct placement the
// engine hasn't advanced yet, but the bar should already show the win.
function renderPuzzleCard(bodyHtml, meta, done) {
  const st = puzzleStatus();
  if (!st) return;
  const pct = Math.round(((done ?? st.stepIndex) / st.total) * 100);
  showCard('Assemble',
    `${bodyHtml}<div class="progress"><i style="width:${pct}%"></i></div>`,
    meta,
    { chips: [
      { label: '💡 Hint', onClick: puzzleHint },
      { label: '✋ Place it for me', onClick: () => { track('puzzle-assist'); puzzleAutoPlace(); } },
    ] });
}

function puzzleMeta() {
  const st = puzzleStatus();
  const misses = st.mistakes ? ` · ${st.mistakes} wrong ${st.mistakes === 1 ? 'try' : 'tries'}` : '';
  return `Step ${st.stepIndex + 1} of ${st.total}${misses}`;
}

// A new step is armed: ask which part comes next — and do NOT name it. The
// naming line is the reward for getting it right (see onPuzzleCorrect).
function onPuzzleStep({ index, step }) {
  focusedPart = null; // don't leak the answer into the tutor's context
  const how = index === 0
    ? 'Drag the right piece into the glowing outline.'
    : '';
  renderPuzzleCard(
    `<b>${step.prompt}</b>${how ? `<span class="partdesc">${how}</span>` : ''}`,
    puzzleMeta()
  );
  say(index === 0 ? `${step.prompt} Drag the right piece into the glowing outline.` : step.prompt);
}

function onPuzzleCorrect({ step, assisted }) {
  focusedPart = step.name || null;
  playSfx('snap'); // lands on the placement; the spoken line follows a beat later
  const lead = assisted ? 'That one is the' : 'Yes — the';
  renderPuzzleCard(
    `<b>${assisted ? '' : '✅ '}${step.name}</b><span class="partdesc">${step.text}</span>`,
    puzzleMeta(),
    puzzleStatus().stepIndex + 1
  );
  say(`${lead} ${step.name}. ${step.text}`);
  track(assisted ? 'puzzle-assist-placed' : 'puzzle-correct', {
    metadata: { model: ui.model.value, part: step.name },
  });
}

/**
 * A piece didn't go in. The shake and the red flash are puzzle.js's job and
 * already say the drop failed, so the words don't repeat that — they name the
 * part to reach for instead. `expected` leads; the tutor then adds why it has to
 * come first. Falls back to the step's own instruction line whenever
 * DeutschlandGPT is unreachable, so the guidance is never silent.
 */
async function onPuzzleWrong({ step, attempted, expected }) {
  const seq = ++wrongSeq;
  playSfx('reject'); // immediate, unlike the AI line below
  const next = `The ${expected} goes on next.`;
  renderPuzzleCard(`<b>${next}</b><span class="partdesc">${step.text}</span>`, puzzleMeta());
  showCaption(next);
  track('puzzle-wrong', { metadata: { model: ui.model.value, attempted, expected } });

  const why = await explainNextPart(getContext(), { attempted, expected, stepText: step.text });
  if (seq !== wrongSeq || !isPuzzleActive()) return; // superseded, or the mode changed
  renderPuzzleCard(`<b>${next}</b><span class="partdesc">${why}</span>`, puzzleMeta());
  showCaption(why);
  say(why);
}

// Picking a part up focuses it for the tutor, so "what is this?" works mid-drag
// without naming it on screen — the question stays the user's to answer.
function onPuzzleCarry(index) {
  focusedPart = index >= 0 ? parts[index].name : null;
}

function onPuzzleComplete({ mistakes, assists }) {
  focusedPart = null;
  const clean = mistakes === 0 && assists === 0;
  const line = clean
    ? 'Built it start to finish without a single wrong piece. That is the real assembly order.'
    : `Built. ${mistakes} wrong ${mistakes === 1 ? 'try' : 'tries'}${assists ? `, ${assists} placed for you` : ''} — run it again and see if you can go clean.`;
  showCard('Assemble', `<b>🎉 ${currentModel().label} assembled</b><span class="partdesc">${line}</span>`, 'Complete', {
    chips: [
      { label: '🔁 Build it again', onClick: () => enterMode('assemble') },
      { label: '🔍 Explore it', onClick: () => enterMode('explore') },
    ],
  });
  say(line);
  track('puzzle-complete', { metadata: { model: ui.model.value, mistakes, assists } });
}

// Hint: glow the piece the step wants, briefly. Deliberately a separate act from
// the prompt — asking for it is the learner's choice, not the default.
function puzzleHint() {
  const indices = puzzleHintIndices();
  if (!indices.length) return;
  clearTimeout(hintTimer);
  for (const i of indices) setHighlight(parts[i], true);
  hintTimer = setTimeout(() => {
    if (!isPuzzleActive()) return;
    for (const i of indices) setHighlight(parts[i], false);
  }, 2600);
  showCaption('That one — drag it into the outline.');
  track('puzzle-hint');
}

// --- Diagnose: pick a symptom → highlight the likely part ---
function enterDiagnose() {
  diagnoses = resolveDiagnose(currentKey(), parts);
  mildExplode();
  if (!diagnoses.length) {
    showCard('Diagnose', 'No symptoms authored for this model yet.');
    return;
  }
  const chips = diagnoses.map((d, i) => ({
    label: d.symptoms[0],
    onClick: () => showDiagnosis(i),
  }));
  showCard('Diagnose', 'What is the symptom? Pick one:', '', { chips });
}
async function showDiagnosis(i) {
  const d = diagnoses[i];
  const myReq = ++diagnoseSeq;               // newest pick wins if answers race
  isolateParts(parts, d.indices);
  flyTo(d.indices);
  const chips = diagnoses.map((dd, j) => ({ label: dd.symptoms[0], onClick: () => showDiagnosis(j) }));
  const partName = d.indices.length ? parts[d.indices[0]].name : '';
  focusedPart = partName || focusedPart;
  const kicker = partName ? `Likely part: ${partName}` : '';
  // Highlight the part immediately, then let dGPT explain the fault — grounded in
  // the authored diagnosis (d.text) so it stays on this part and can't invent.
  showCard('Diagnose', '…diagnosing', kicker, { chips });
  const ans = await answerDiagnosis(getContext(), { symptom: d.symptoms[0], part: partName, reference: d.text });
  if (myReq !== diagnoseSeq) return;         // a newer symptom was picked meanwhile
  showCard('Diagnose', ans, kicker, { chips });
  say(ans);
}

// --- Quiz: highlight a part, ask you to name it ---
function enterQuiz() {
  quizItems = resolveQuiz(currentKey(), parts);
  quizIndex = 0;
  mildExplode();
  if (!quizItems.length) { showCard('Quiz', 'No quiz authored for this model yet.'); return; }
  renderQuiz();
}
function renderQuiz() {
  const q = quizItems[quizIndex];
  quizRevealed = false;
  isolateParts(parts, q.indices);
  flyTo(q.indices); // the part being asked about has to be visible to be answerable
  focusedPart = q.indices.length ? parts[q.indices[0]].name : focusedPart;
  showCard('Quiz', q.question, `Question ${quizIndex + 1} of ${quizItems.length}`, {
    chips: [
      { label: 'Reveal answer', onClick: revealQuiz },
      { label: 'Next question ▶', onClick: nextQuiz },
    ],
  });
  say(q.question);
}
function revealQuiz() {
  if (quizRevealed) return;
  quizRevealed = true;
  const q = quizItems[quizIndex];
  showCard('Quiz', `${q.question}<br><b>Answer: ${q.answer}</b>`, `Question ${quizIndex + 1} of ${quizItems.length}`, {
    chips: [{ label: 'Next question ▶', onClick: nextQuiz }],
  });
}
function nextQuiz() {
  quizIndex = (quizIndex + 1) % quizItems.length;
  renderQuiz();
}

// --- Part picking (tap) — behaviour depends on the active mode ---
attachPicker(renderer, camera, () => parts, (index) => {
  if (currentMode === 'explore') {
    selectedPart = index;
    // No emissive glow here: keep the tapped part fully textured and just dim
    // the rest, so the real material reads instead of a teal wash.
    isolateParts(parts, index >= 0 ? [index] : [], { highlight: false });
    if (index >= 0) {
      const name = parts[index].name;
      focusedPart = name;
      // Just the name — the authored description (describePart) is deliberately
      // NOT shown or spoken here. It goes to the LLM as grounding (getContext),
      // so the detail surfaces only when the user actually asks about the part.
      showCard(
        'Explore',
        `<b>${name}</b>`,
        `${parts[index].triangleCount.toLocaleString()} triangles · ask 🎤 about this part`
      );
      say(name);
    } else {
      focusedPart = null;
      showCard('Explore', 'Tap any part to isolate it, then tap 🎤 and ask about it. Drag the slider to spread the parts apart.', `${parts.length} parts`);
    }
    addCardExplodeSlider(); // showCard rebuilt the body — re-add the inline explode slider
  }
  else if (currentMode === 'quiz' && index >= 0) {
    // Tapping a part in quiz mode is a shortcut to reveal.
    revealQuiz();
  }
});

// --- Part dragging (Assemble puzzle) — the desktop half of the input contract.
// The AR half is registered on the session in startARFlow; both feed the same
// engine, so a build behaves identically on a laptop and through a phone.
attachDragger(renderer, camera, controls, puzzleInteractor);

// ---- Tutor context, voice commands, AR -------------------------------------

function getContext() {
  return {
    modelLabel: currentModel().label,
    parts: parts.map((p) => p.name).filter(Boolean),
    mode: currentMode,
    focusedPart,
    // The authored description of the focused part (MARKUS_INFO). Never shown
    // or spoken directly — it grounds the LLM's answer when the user asks.
    focusedPartInfo: focusedPart ? describePart(currentKey(), focusedPart) : '',
    // Authored fix + diagnosis knowledge for this model, so the AI tutor grounds
    // free-form answers in the real faults instead of guessing.
    diagnostics: knowledgeDigest(currentKey()),
  };
}

function showCaption(html) {
  ui.voiceCaption.innerHTML = html;
  ui.voiceCaption.classList.add('show');
  clearTimeout(showCaption._t);
  showCaption._t = setTimeout(() => ui.voiceCaption.classList.remove('show'), 7000);
}

const ASK_HINT = 'Ask me anything about it — I answer out loud. Start talking to interrupt an answer.';

// The mic is a **question channel, nothing else**: a spoken phrase never drives
// the app (no mode switches, no "next", no part selection). Misheard noise used
// to turn into commands and the app would "act on its own" — that's gone. Two
// deliberate, strictly-matched exceptions survive because they have no button
// equivalent: silencing the tutor mid-answer, and re-placing the model in AR.
const MUTE_RE = /^\s*(stop|stopp|be quiet|quiet|shut up|silence|stop talking|stop speaking)[.!\s]*$/i;
const MOVE_RE = /\b(move|reposition)\b/i;

let askSeq = 0; // newest question wins: older in-flight answers are dropped

async function handleSpeech(text) {
  const t = text.trim();
  if (!t) return;

  if (MUTE_RE.test(t)) { stopSpeaking(); showCaption('Okay — ask away.'); track('voice-mute', { input: t }); return; }
  // AR-only: "move it" re-enters placement — voice is the only way (see moveARFlow).
  if (renderer.xr.isPresenting && t.split(/\s+/).length <= 4 && MOVE_RE.test(t)) {
    moveARFlow();
    track('voice-move', { input: t });
    return;
  }

  // Fix mode, waiting for a problem: the utterance IS the fix request — the
  // content input this mode exists to receive (a Diagnose chip, spoken), not a
  // command; it never navigates or switches modes. Speaking again while a plan
  // is still being drafted simply replaces it (fixSeq — newest request wins).
  if (currentMode === 'fix' && (fixState === 'ask' || fixState === 'planning') && aiAvailable()) {
    startFixRequest(t);
    return;
  }

  const my = ++askSeq;
  showCaption(`“${t}” · …thinking`);
  track('voice-question', { input: t, metadata: { mode: currentMode, part: focusedPart } });
  // In Explore with a part selected, pin the answer to that part — that's the
  // thing the user is asking about. Otherwise answer about the whole object.
  const scoped = currentMode === 'explore' && selectedPart >= 0 && !!focusedPart;
  const ans = await answerQuestion(getContext(), t, { focusOnly: scoped });
  if (my !== askSeq) return;             // a newer question superseded this answer
  if (recognizer?.isCapturing()) return; // the user is mid-question — never talk over them
  showCaption(ans);
  say(ans);
}

// DEBUG: simulate a spoken phrase from the console (no mic needed) — exercises
// the exact same routing as real speech, incl. Fix-mode planning.
window.__ask = handleSpeech;

const recognizer = createRecognizer({
  onResult: handleSpeech,
  // Barge-in: the instant the user starts talking, the tutor yields — their next
  // question must never compete with a half-finished answer.
  onSpeechStart: () => stopSpeaking(),
  // Lets the VAD demand more sustained energy while the tutor is audible, so
  // speaker bleed the echo canceller misses can't trigger a false barge-in.
  isTtsSpeaking: isSpeaking,
  onStatus: (phase) => { if (phase === 'transcribing') showCaption('🎧 …'); },
  onError: (msg) => showCaption(msg),
  onStateChange: (listening) => {
    ui.micBtn.classList.toggle('listening', listening);
    ui.micBtn.textContent = listening ? '🎤 Listening…' : '🎤 Ask';
  },
});
if (!recognizer) {
  ui.micBtn.disabled = true;
  ui.micBtn.title = 'Voice needs a microphone plus a DeutschlandGPT key (or Chrome).';
}
ui.micBtn.addEventListener('click', () => {
  if (!recognizer) return;
  stopSpeaking();
  if (recognizer.isListening()) {
    recognizer.stop();
  } else {
    recognizer.start();
    showCaption(ASK_HINT);
  }
});

// AR availability + start/exit.
(async () => {
  const supported = await isARSupported();
  track('ar-support', { metadata: { supported } });
  if (!supported) {
    ui.startAR.textContent = '📱 AR needs Android';
    ui.startAR.disabled = true;
    ui.startAR.title = 'WebXR AR runs on Android Chrome. The 3D view works everywhere.';
  }
})();

// Shared AR entry points (buttons *and* voice call these). Note: WebXR
// requestSession normally needs a user gesture, so a purely voice-triggered
// start may be rejected — we catch that and tell the user to tap the button.
async function startARFlow() {
  if (renderer.xr.isPresenting) return;
  if (ui.startAR.disabled) { showCaption('AR needs an Android phone. Tap 📱 for details.'); return; }
  cancelTween('camera'); // ar.js saves + owns the camera pose from here on
  try {
    document.body.classList.add('ar-active');
    track('ar-start', { metadata: { model: ui.model.value } });
    await startAR({
      renderer, scene, camera, group: explodedGroup, controls,
      overlay: document.body,
      fitBox: restBounds(), // size to the assembled chair, not its exploded spread
      onPlaced: () => {
        track('ar-placed', { metadata: { model: ui.model.value } });
        applyARInteraction(); // pivot exists only once placed — size + lock it now
        if (isPuzzleActive()) {
          showCaption('Placed at full size. Drag each part into the glowing outline. Say “move it” to re-place the build.');
          say('Placed, at full size. Drag each part into the glowing outline.');
        } else {
          showCaption('Placed! Long-press to grab it, then drag to move · pinch to zoom · twist to rotate.');
          say('Placed. Press and hold the object to grab it, then drag to move it, or pinch to resize.');
        }
      },
      onSelectedChange: (sel) => {
        track(sel ? 'ar-select' : 'ar-deselect');
        showCaption(sel
          ? 'Grabbed — drag to move · pinch to zoom · twist to rotate · tap to release.'
          : 'Released. Long-press the object again to move or resize it.');
      },
      onEnd: () => { document.body.classList.remove('ar-active'); arLifeSize = false; track('ar-exit'); },
    });
    setInteractor(puzzleInteractor); // the finger's target ray drives part dragging
    showCaption('Point at the floor, then tap to place the chair.');
  } catch (e) {
    console.error('AR failed', e);
    document.body.classList.remove('ar-active');
    track('ar-error', { metadata: { error: e.message }, level: 'ERROR' });
    showCaption('Could not start AR — tap the ▶ AR button to launch it.');
  }
}
// Voice-only ("move it"): re-enter placement so the next floor tap re-places
// the model on a fresh anchor — hands-free reposition to a new spot/surface.
// Everyday nudging is just long-press + drag, so there's no on-screen button.
function moveARFlow() {
  if (!renderer.xr.isPresenting) { showCaption('Start AR first, then say “move it”.'); return; }
  requestMove();
  showCaption('Tap the floor where you want the chair.');
}

ui.startAR.addEventListener('click', startARFlow);
ui.exitAR.addEventListener('click', () => endAR());

// Mobile: gear opens the dev-controls bottom sheet; the backdrop (or gear
// again) dismisses it. On desktop the sheet class is inert — the panel is
// always visible top-left — so this just no-ops visually there.
function toggleSheet(open) {
  const isOpen = open === undefined ? !ui.panel.classList.contains('open') : open;
  ui.panel.classList.toggle('open', isOpen);
  ui.sheetBackdrop.classList.toggle('show', isOpen);
}
ui.panelToggle.addEventListener('click', () => toggleSheet());
ui.sheetBackdrop.addEventListener('click', () => toggleSheet(false));

// ---- Theme (light default; persisted) --------------------------------------
// Light is the product default — we only flip to dark on an explicit choice,
// so a first-time visitor always lands on light regardless of their OS setting.
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  scene.background = new THREE.Color(dark ? SCENE_BG.dark : SCENE_BG.light);
  ui.themeToggle.textContent = dark ? '☀️ Light' : '🌙 Dark';
  try { localStorage.setItem('theme', theme); } catch {}
}
applyTheme(
  (() => { try { return localStorage.getItem('theme'); } catch { return null; } })() || 'light'
);
ui.themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---- Render loop -----------------------------------------------------------

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// setAnimationLoop works both for normal rAF and inside a WebXR session
// (three.js passes the XRFrame as the 2nd arg during an AR session).
let lastFrameTime = 0;
renderer.setAnimationLoop((time, frame) => {
  // Clamp the delta: a backgrounded tab resumes with a huge gap, which would
  // otherwise finish every in-flight tween in a single jump.
  const dt = lastFrameTime ? Math.min((time - lastFrameTime) / 1000, 0.1) : 0;
  lastFrameTime = time;
  if (frame) updateAR(frame);
  updatePuzzle(dt); // damped carry + snap/reject tweens + ghost pulse (no-op when idle)
  if (!renderer.xr.isPresenting) {
    resize();
    // Auto-rotate orbits around controls.target every update, so it has to yield
    // while a flight is writing the camera pose — otherwise the two fight.
    controls.autoRotate = ui.autorotate.checked && !isTweening('camera');
    controls.autoRotateSpeed = 1.2;
  }
  updateTweens(dt);
  controls.update();
  renderer.render(scene, camera);
});

// ---- Go --------------------------------------------------------------------

// Boot straight into the hero IKEA Markus and fetch nothing else — the other
// models are only loaded when the user actually selects one. Read the value off
// the dropdown (not DEFAULT_MODEL) so UI and loaded model can never desync.
loadModel(ui.model.value);
