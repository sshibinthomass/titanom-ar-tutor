import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildExplodedView, setExplode, setPartExplode, isolateParts, clearPartStates, setHighlight, setGhostStyle, setAccentColor, findParts } from './explode.js';
import { hydrateIcons, setLabel, iconSvg } from './icons.js';
import { updateTweens, tweenTo, cancelTween, isTweening, easeInOutCubic, flyToParts, moveCamera } from './animate.js';
import { attachPicker, attachDragger } from './select.js';
import { selectableModes, resolveFix, resolveAssemble, resolveQuiz, applyNames, knowledgeDigest, partInfoDigest, fixSuggestions, resolvePlanParts, partLabel, canonicalName } from './modes.js';
import { LANGS, getLang, setLang, onLangChange, t, locale, applyStaticTranslations } from './i18n.js';
import { isARSupported, startAR, updateAR, endAR, requestMove, setInteractor, setManipulationEnabled, setPivotScale, getFitScale } from './ar.js';
import { startPuzzle, stopPuzzle, updatePuzzle, puzzleInteractor, isPuzzleActive, puzzleAutoPlace, puzzleHintIndices, puzzleStatus, puzzleAnswerByName, puzzleAnswerCandidates } from './puzzle.js';
import { speak, stop as stopSpeaking, isSpeaking } from './tts.js';
import { primeSfx, playSfx } from './sfx.js';
import { createRecognizer } from './voice.js';
import { answerQuestion, explainNextPart, generateFixPlan, resolveSpokenPart } from './tutor.js';
import { startFixAnim, stopFixAnim, updateFixAnim, isObjectAction } from './fixanim.js';
import { aiAvailable } from './ai.js';
// `homeView` here is the *camera's* default framing; the home screen's current
// view is aliased so the two can't be confused.
import { initHome, openHome, closeHome, isHomeOpen, homeView as homeScreenView, refreshHome } from './home.js';
import { initTelemetry, track } from './telemetry.js';
import { routePath, currentRoute, navigate, onRouteChange } from './router.js';

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
// `label` is the English name; `labelDe` the German one. The label is not just
// a dropdown caption — it is `modelLabel` in every LLM prompt ("the user is
// looking at a …"), so leaving it English in a German session would put one
// English noun in the middle of every German answer.
const MODELS = {
  'markus-chair': {
    label: 'IKEA Markus Chair',
    labelDe: 'IKEA MARKUS Bürostuhl',
    url: `${BASE_URL}models/markus-chair/scene.gltf`,
    credit: 'IKEA Markus Office Chair — Graham Rust, Sketchfab Standard',
    creditUrl: 'https://sketchfab.com/3d-models/ikea-markus-office-chair-cee12c29ebda4bcdb91b84a6f126a971',
    defaultMode: 'group', // already 47 separate meshes → one clean part per mesh
    realHeight: 1.29,     // IKEA spec: 129 cm to the top of the headrest
  },
  'office-chair': {
    label: 'Office Chair',
    labelDe: 'Bürostuhl',
    url: `${BASE_URL}models/office-chair/scene.gltf`,
    credit: 'Office Chair Modern — thethieme, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/office-chair-modern-675f34f7304e4d92812a41e9750539aa',
    defaultMode: 'component', // single fused mesh → must split by connected pieces
    // Not offered to the user: it is a second chair next to the hero Markus,
    // which makes both the home picker and the scan's "chair" answer ambiguous
    // for no teaching value. Kept in the registry (with its authored content in
    // modes.js) because it is the app's proof that `component` splitting works
    // on a fused mesh — drop this flag to put it back in the pickers.
    hidden: true,
  },
  bicycle: {
    label: 'Bicycle',
    labelDe: 'Fahrrad',
    url: `${BASE_URL}models/bicycle/scene.gltf`,
    credit: 'bicycle — local.yany, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/bicycle-8db2d442b58045baac2edfc5e9ee11e3',
    defaultMode: 'group', // 14 meshes, one per material → clean semantic parts
    realHeight: 1.05,
  },
  bed: {
    label: 'Bed Low Poly',
    labelDe: 'Bett (Low Poly)',
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
// No scene backdrop at all: the canvas is transparent (`alpha: true` above) and
// the page paints the background — a gradient, a masked dot grid and the tutor's
// dome glow, all in CSS. A solid `scene.background` would sit *in front* of
// those and the object would float on a flat slab instead of inside the space.
// Both themes are therefore handled entirely by the stylesheet; applyTheme()
// only has to flip the data-theme attribute. AR already expects this — ar.js
// saves and restores `scene.background` around a session, and null round-trips.
scene.background = null;

// The "disabled part" wireframe has to stay legible on three very different
// backdrops, so it is re-coloured per backdrop rather than picking one tint and
// hoping: dark ink on the light backdrop, a bright line on the dark one, and in
// AR — where the backdrop is whatever room the user is standing in — a saturated
// cyan at full self-lit strength, which no ordinary floor or wall competes with.
const GHOST_STYLE = {
  light: { color: 0x24476e, opacity: 0.85, intensity: 0.5 },
  dark: { color: 0x7fd4ff, opacity: 0.8, intensity: 0.95 },
  ar: { color: 0x00e0ff, opacity: 0.95, intensity: 1.2 },
};
function applyGhostTheme() {
  setGhostStyle(renderer.xr.isPresenting
    ? GHOST_STYLE.ar
    : (document.documentElement.dataset.theme === 'dark' ? GHOST_STYLE.dark : GHOST_STYLE.light));
}

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
  handsfree: document.getElementById('handsfree'),
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
  lang: document.getElementById('lang'),
  langToggle: document.getElementById('langToggle'),
  homeBtn: document.getElementById('homeBtn'),
};

// Paint the static chrome in the selected language before anything else runs,
// so the first frame is never English-then-German. Icons are drawn straight
// after: they live in sibling nodes, so translating a label never disturbs one
// and this only has to happen once.
applyStaticTranslations();
hydrateIcons();

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

/** A model's name in the selected language (dropdown, cards and LLM prompts). */
function modelLabel(m = currentModel()) {
  return (getLang() === 'de' && m?.labelDe) || m?.label || '';
}

/** The models the user may choose — the registry minus anything `hidden`. One
 *  list, feeding both the panel's dropdown and the home screen's picker. */
function selectableModels() {
  return Object.entries(MODELS)
    .filter(([, m]) => !m.hidden)
    .map(([key, m]) => ({ key, label: modelLabel(m) }));
}

// Populate model dropdown.
for (const { key, label } of selectableModels()) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = label;
  ui.model.appendChild(opt);
}
// The <option> captions are re-read on a language switch; the selected value is
// untouched, so the loaded model can never desync from the dropdown.
function relabelModels() {
  for (const opt of ui.model.options) opt.textContent = modelLabel(MODELS[opt.value]);
}
ui.model.value = DEFAULT_MODEL; // hero model: richest authored content (parts, specs, official-manual grounding)

// Telemetry: one Langfuse session per page load. Tracks voice, AI, modes, AR,
// TTS and errors. No-op (and never throws) when Langfuse isn't configured.
initTelemetry({ initialModel: ui.model.value, initialLang: getLang() });

// Generate the puzzle's ElevenLabs sound cues now, not when Assemble opens:
// generation takes seconds, and they'd miss the moment they punctuate. Cached
// in localStorage, so this is one round of requests per browser, ever.
primeSfx();

// ---- Load + build ----------------------------------------------------------

// The model the scene is actually built from (or being built from). ui.model is
// the *request* — set the instant a route arrives — so the router compares
// against this to decide whether a route still needs a load.
let loadedKey = null;

function loadModel(key) {
  const m = MODELS[key];
  loadedKey = key;
  ui.credit.innerHTML = `<a href="${m.creditUrl}" target="_blank" rel="noopener">${m.credit}</a>`;
  ui.mode.value = m.defaultMode;

  if (gltfCache.has(key)) {
    originalScene = gltfCache.get(key);
    rebuild();
    setStatus('status.ready');
    return;
  }

  setStatus('status.loading');
  loader.load(
    m.url,
    (gltf) => {
      gltfCache.set(key, gltf.scene);
      originalScene = gltf.scene;
      setStatus('status.splitting');
      rebuild();
      setStatus('status.ready');
    },
    (evt) => {
      if (evt.total) setStatus('status.loadingPct', { pct: Math.round((evt.loaded / evt.total) * 100) });
    },
    (err) => {
      console.error(err);
      setStatus('status.failed');
    }
  );
}

// The status line is written from a dozen places and has to survive a language
// switch, so it remembers its key (and vars) rather than its rendered text.
let statusKey = 'status.init';
let statusVars = null;
function setStatus(key, vars = null) {
  statusKey = key;
  statusVars = vars;
  ui.status.textContent = t(key, vars);
}

function rebuild() {
  stopPuzzle();  // release the ghosts before the geometry they borrow is disposed
  cancelBeats(); // and the step narration, before its part refs go stale
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
    return { i, tris: p.triangleCount, mesh: p.mesh, // live mesh ref: lets the console watch animations
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
    label.textContent = partLabel(p);
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
    mat.emissive.setHex(0x5b9dff);   // --accent: legend hover is the app pointing, not a fault
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
  // Already there (e.g. Explore → Quiz, both at the same spread): don't collapse
  // and re-expand for nothing.
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
// (never sinks below it — the complaint in the spread modes, where parts fan out downward).
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

// Picking a model is a navigation, not a load: it goes through the router (which
// then loads), so the address bar, the Back button and the dropdown can never
// tell three different stories about which object is on screen. The mode is
// carried over — changing the object doesn't change what you were doing to it.
ui.model.addEventListener('change', () => goTo({ kind: 'object', model: ui.model.value, mode: currentMode }));
ui.mode.addEventListener('change', () => { if (originalScene) rebuild(); });
ui.tint.addEventListener('change', () => { if (originalScene) rebuild(); });

function applyWireframe(on) {
  for (const p of parts) {
    const mats = Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material];
    for (const m of mats) {
      // A ghosted part is already wireframe by design; don't un-ghost it here —
      // move the baseline it will be restored to instead, so un-ghosting later
      // lands on the toggle's current setting rather than the one it was ghosted under.
      if (m.userData._origWireframe !== undefined) m.userData._origWireframe = on;
      else m.wireframe = on;
    }
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

// Build the mode-switch bar once. The captions come from the dictionary and are
// re-read on a language switch (relabelModes), so the bar itself is built once
// and never rebuilt — the buttons keep their listeners and their active state.
for (const m of selectableModes()) {
  const btn = document.createElement('button');
  btn.className = 'modebtn';
  btn.dataset.mode = m.id;
  // Icon names match the mode ids one-for-one (icons.js), so a mode added to
  // MODE_LIST needs an icon of the same name and nothing else here.
  setLabel(btn, t(`mode.${m.id}`), m.id);
  // The bar collapses unselected modes to icons on narrower screens, so the
  // name has to survive somewhere reachable.
  btn.title = t(`mode.${m.id}`);
  btn.addEventListener('click', () => enterMode(m.id));
  ui.modebar.appendChild(btn);
}
function relabelModes() {
  for (const b of ui.modebar.children) {
    setLabel(b, t(`mode.${b.dataset.mode}`));
    b.title = t(`mode.${b.dataset.mode}`);
  }
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
      // `icon` is optional: the Fix suggestion chips are authored symptoms, and
      // giving every symptom the same picture would say nothing.
      setLabel(el, c.label, c.icon || null);
      el.addEventListener('click', c.onClick);
      ui.cardChips.appendChild(el);
    }
  }
  // Every card carries its own explode slider. The Controls panel's copy is
  // unreachable exactly where it is most wanted — it is a gear-tap bottom sheet
  // on a phone, and hidden outright during AR — so the card is the only place
  // the spread can be adjusted on the surfaces the app is actually used on.
  // Skipped while the puzzle owns part positions, where the slider is a no-op
  // (see onExplodeChange) and would just be a dead control.
  if (!isPuzzleActive()) addCardExplodeSlider();
  ui.card.classList.add('show');
}
function hideCard() { ui.card.classList.remove('show'); }

// Reset all part visuals to a clean, fully-assembled, fully-visible state.
// The collapse animates, but a mode that immediately re-spreads (Fix, Quiz)
// replaces the tween before it ticks, so there's no collapse-then-expand
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
 * Fix opens barely exploded — just enough separation to see a part, while the
 * object still reads as a chair. The gestures are the point in Fix, and they
 * only make sense against something recognisable: tipping a chair that has been
 * blown 35% apart looks like debris rotating, not a chair going on its side.
 *
 * 7 is a slider value, not a ratio, so it means the same physical gap however
 * far a model's own range happens to run — but it is capped at a fraction of
 * the range so a model authored in small units (the slider max scales with the
 * model radius) can't be thrown wide open by it.
 */
const FIX_EXPLODE = 7;
function fixExplode() {
  setExplodeAmount(Math.min(FIX_EXPLODE, parseFloat(ui.explode.max) * 0.15), { animate: true });
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

/**
 * Blue is the app pointing at something; amber is something being *wrong*.
 *
 * Fix is the only mode with a fault in it, so it is the only mode that gets to
 * use amber — on the card (the stylesheet keys off `body[data-mode]`) and on the
 * object itself (setAccentColor). Keeping the two in step from one place is
 * what stops the card and the model disagreeing about which colour means what.
 * Values match --accent / --amber in index.html.
 */
const ACCENT_3D = { blue: 0x5b9dff, amber: 0xffbf66 };
/** How hard Fix tints a spotlit part. Low on purpose, and lower than it looks
 *  like it should be: emissive adds on top of the material and the renderer's
 *  1.35 exposure amplifies it, so 0.5 turned a dark grey seat into a flat tan
 *  slab. At this value the part reads as *warm* and still reads as a seat —
 *  which it has to, because the gestures play out on it. */
const FIX_TINT = 0.28;

function enterMode(id) {
  track('mode-switch', { metadata: { mode: id, model: ui.model.value } });
  currentMode = id;
  setModeButtons(id);
  document.body.dataset.mode = id;                 // the card's colour rule reads this
  setAccentColor(id === 'fix' ? ACCENT_3D.amber : ACCENT_3D.blue);
  syncRoute();        // every mode is a page; entering one is arriving at it
  cardExplode = null; // drop any stale inline slider before the card is rebuilt
  stopPuzzle();       // before resetParts, which assumes it owns part positions
  cancelBeats();      // ditto — a gesture writes part positions every frame
  applyARInteraction();
  resetParts();
  selectedPart = -1;
  if (!parts.length) { hideCard(); return; }

  if (id === 'explore') return enterExplore();
  if (id === 'fix') return enterFix();
  if (id === 'assemble') return enterAssemble();
  if (id === 'quiz') return enterQuiz();
}

// The card header for a mode. `stepKicker` holds the mode **id**, never this
// label — every branch that asks "is this the Fix walkthrough?" compares ids,
// so translating the header can't change control flow.
const kicker = (id) => t(`kicker.${id}`);

// --- Explore: tap a part, isolate + name it ---
function enterExplore() {
  showCard(kicker('explore'), t('explore.intro'), t('explore.partCount', { count: parts.length }));
}

// The explode slider that rides inside every card (appended by showCard), so
// parts can be spread apart without the Controls sheet — which is a gear tap
// away on mobile and hidden entirely in AR. It mirrors the panel slider; both
// drive onExplodeChange, which keeps the two in sync.
function addCardExplodeSlider() {
  const wrap = document.createElement('div');
  wrap.className = 'card-explode';
  const label = document.createElement('label');
  label.textContent = t('card.explode');
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

/**
 * Fix always opens by *asking*. That question is the mode — you say what's
 * wrong (or tap a symptom), and only then does it plan and walk you through it.
 *
 * It used to skip straight to the authored procedure when DGPT was unreachable,
 * which quietly changed what the mode *is*: a walkthrough of a repair nobody
 * asked for, with the suggestions never shown. Without AI the answer to the
 * question is simply the authored procedure instead of a generated plan (see
 * startFixRequest) — the same screen, a less specific answer.
 */
function enterFix() {
  fixSeq++; // drop any plan still in flight from a previous visit / old part list
  showFixAsk();
}

// The no-AI path: the authored procedure, played through the same beat
// walkthrough (one beat per authored step, carrying that step's authored verb)
// so it looks and sounds exactly like a generated plan.
function runAuthoredFix() {
  const proc = resolveFix(currentKey(), parts);
  steps = proc.steps.map((s) => ({
    beats: [{ indices: s.indices, action: s.action || 'inspect', text: s.text }],
    indices: s.indices,
  }));
  stepIndex = 0; stepTitle = proc.title; stepKicker = 'fix';
  fixState = 'guided';
  fixExplode();
  renderStep();
}

// The ask-screen: what problem are we solving? The chips are authored symptoms
// (fixSuggestions) but they are only canned voice inputs — tapping one and
// speaking a phrase feed the same planner. `lead` lets a finished or failed
// plan re-ask with its own line instead of the default question.
function showFixAsk(lead = '') {
  fixState = 'ask';
  steps = [];
  focusedPart = null;
  cancelBeats();
  clearPartStates(parts);
  fixExplode(); // Fix sits at its own spread throughout, including while asking
  // No icon on these: they are authored symptoms, and the same wrench on each
  // one would decorate without distinguishing. The chip shape already says
  // "tappable".
  const chips = fixSuggestions(currentKey()).map((label) => ({
    label,
    onClick: () => startFixRequest(label),
  }));
  showCard(
    kicker('fix'),
    `<b>${esc(lead || t('fix.ask'))}</b><span class="partdesc">${t('fix.askHint')}</span>`,
    '',
    { chips }
  );
  say(lead || t('fix.askSpoken'));
}

/** A problem arrived (spoken or tapped): plan it with DGPT and start the walkthrough. */
async function startFixRequest(request) {
  const my = ++fixSeq;
  fixState = 'planning';
  track('fix-request', { input: request, metadata: { model: ui.model.value, lang: getLang() } });

  // No planner to ask: answer with the authored procedure straight away rather
  // than showing a "planning…" card for a round trip that will never happen.
  if (!aiAvailable()) {
    track('fix-plan-fallback', { metadata: { model: ui.model.value, reason: 'no-ai' } });
    runAuthoredFix();
    return;
  }

  showCard(kicker('fix'), `<b>“${esc(request)}”</b><span class="partdesc">${t('fix.planning')}</span>`);
  showCaption(esc(t('fix.planningCaption', { request })));

  const plan = await generateFixPlan(getContext(), request);
  if (my !== fixSeq || currentMode !== 'fix') return; // superseded, or the mode was left

  if (!plan || !plan.steps.length) {
    if (plan?.intro) { showFixAsk(plan.intro); return; } // "that's not fixable here, because…"
    // AI unreachable mid-request: run the authored procedure so the demo never dead-ends.
    track('fix-plan-fallback', { metadata: { model: ui.model.value } });
    runAuthoredFix();
    return;
  }

  steps = plan.steps.map(toStep);
  stepIndex = 0;
  stepTitle = plan.title || t('fix.titleFor', { request });
  stepKicker = 'fix';
  fixState = 'guided';
  track('fix-plan', { metadata: { model: ui.model.value, lang: getLang(), steps: steps.length, request } });
  fixExplode();
  if (plan.intro) showCaption(esc(plan.intro));
  renderStep(plan.intro);
}

/**
 * Normalise one planned step into the shape the walkthrough plays:
 * { beats: [{ indices, action, text }], indices } — `indices` being every part
 * the step touches, which is what gets spotlighted for the whole step.
 *
 * Beat part names are resolved here rather than in the planner so a name the
 * LLM bent slightly still lands on a real part. A beat whose names resolve to
 * nothing inherits the previous beat's parts (the sentence almost always
 * continues working on the same thing) rather than animating nothing.
 */
function toStep(planStep) {
  let last = [];
  const beats = planStep.beats.map((b) => {
    let indices = isObjectAction(b.action) ? [] : resolvePlanParts(parts, b.parts);
    let action = b.action;
    if (!indices.length && !isObjectAction(action)) {
      indices = last;
      if (!indices.length) action = 'inspect';
    }
    if (indices.length) last = indices;
    return { indices, action, text: b.text };
  });
  return { beats, indices: [...new Set(beats.flatMap((b) => b.indices))] };
}

// Escape LLM-authored text before it goes near innerHTML.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A beat is held on screen at least this long, so even a four-word sentence
// gives its gesture time to read.
const MIN_BEAT_MS = 2000;

let beatSeq = 0; // newest playback wins; Next/Back/barge-in/mode-change bump it

/** Abandon any narration in flight and put the model back at rest. */
function cancelBeats() {
  beatSeq++;
  stopFixAnim();
}

/**
 * Speak one line, and report when it starts and ends.
 *
 * The gesture is started by `onStart` — i.e. when the audio is actually
 * audible, not when we asked for it — which is what keeps the motion in step
 * with the voice through ElevenLabs' generation latency. Two guards keep the
 * walkthrough moving when audio misbehaves: the gesture starts anyway after a
 * short lead if TTS never reports back (blocked autoplay, no voice), and the
 * whole beat is capped so a lost `onEnd` can never strand the sequence.
 */
function narrate(text, onStart) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let started = false, ended = false;
    const start = () => { if (!started) { started = true; onStart?.(); } };
    const end = () => {
      if (ended) return;
      ended = true;
      const left = MIN_BEAT_MS - (performance.now() - t0);
      if (left > 0) setTimeout(resolve, left); else resolve();
    };
    const words = (text.match(/\S+/g) || []).length;
    const estimate = Math.min(14000, Math.max(MIN_BEAT_MS, (words / 2.6) * 1000 + 600));
    const lead = setTimeout(start, 900);
    const cap = setTimeout(end, estimate + 6000);
    speak(text, {
      onStart: () => { clearTimeout(lead); start(); },
      onEnd: () => { clearTimeout(lead); clearTimeout(cap); start(); end(); },
    });
  });
}

/** Mark which beat is being spoken (-1 = none yet, length = all done). */
function markBeat(active) {
  const els = ui.cardBody.querySelectorAll('.beat');
  els.forEach((el, i) => {
    el.classList.toggle('active', i === active);
    el.classList.toggle('done', i < active);
  });
  // On a phone the card scrolls (max-height 42vh), so a long script would go on
  // being spoken after the line scrolled out of sight. Keep the line being said
  // visible — scrolling the card itself, never the page.
  const el = els[active];
  if (!el) return;
  const cr = ui.card.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  let delta = 0;
  if (er.top < cr.top + 8) delta = er.top - cr.top - 8;
  else if (er.bottom > cr.bottom - 8) delta = er.bottom - cr.bottom + 8;
  if (delta) ui.card.scrollTo({ top: ui.card.scrollTop + delta, behavior: 'smooth' });
}

/**
 * Walk a step's beats: highlight the sentence, fly to its parts, play its
 * gesture, speak it, and only then move on. Every await re-checks the sequence
 * token, so Next/Back or a spoken question stops the narration immediately
 * instead of talking over what comes next.
 */
async function playBeats(preface) {
  const my = ++beatSeq;
  const s = steps[stepIndex];
  if (!s) return;

  if (preface) {
    markBeat(-1);
    await narrate(preface);
    if (my !== beatSeq) return;
  }

  for (let i = 0; i < s.beats.length; i++) {
    const b = s.beats[i];
    markBeat(i);
    // Spotlight follows the sentence. A whole-object beat ("lay the chair on
    // its side") un-ghosts everything first — the chair tipping is the point,
    // and a wireframe chair tipping over reads as nothing at all.
    // The tint is amber (see ACCENT_3D) and deliberately weak: the part you are
    // about to put a spanner on must still look like the real part, so this
    // warms it rather than repainting it — the ghosted wireframe around it is
    // still what makes it stand out.
    if (isObjectAction(b.action)) clearPartStates(parts);
    else isolateParts(parts, b.indices.length ? b.indices : s.indices, { intensity: FIX_TINT });
    if (b.indices.length) {
      focusedPart = partLabel(parts[b.indices[0]]); // "what is this?" follows the narration
      flyTo(b.indices);
    }
    await narrate(b.text, () => {
      if (my !== beatSeq) return;
      startFixAnim(parts, b.indices, b.action, {
        scale: modelRadius,
        amount: parseFloat(ui.explode.value) || 0,
        group: explodedGroup,
        onGroupPose: groundExploded,
      });
    });
    if (my !== beatSeq) return;
    stopFixAnim(); // rest between sentences, so gestures never blur together
    await new Promise((r) => setTimeout(r, 200));
    if (my !== beatSeq) return;
  }
  markBeat(s.beats.length);
}

// `preface` is the plan's intro sentence, spoken once ahead of the first step.
function renderStep(preface = '') {
  const title = stepTitle, modeId = stepKicker;
  cancelBeats(); // stop the previous step's narration + restore its parts first
  if (!steps.length) { showCard(kicker(modeId), t('step.none')); return; }
  const s = steps[stepIndex];
  const stepIndices = s.indices || [];

  // Spotlight this step's part(s), ghost the rest. Fix warms its part amber (the
  // thing that's wrong); any other walkthrough leaves the material alone.
  isolateParts(parts, stepIndices, modeId === 'fix' ? { intensity: FIX_TINT } : { highlight: false });
  flyTo(stepIndices); // and bring it to the user rather than making them orbit for it

  const partName = stepIndices.length ? partLabel(parts[stepIndices[0]]) : null;
  focusedPart = partName;
  // Not gated on the planner: "something else" only re-asks the question, and
  // Fix now always has a question to go back to. Without this the no-AI
  // walkthrough is a one-way street — the suggestions become unreachable the
  // moment you pick one.
  const chips = modeId === 'fix'
    ? [
        { label: t('fix.sayAgain'), icon: 'speak', onClick: () => renderStep() },
        { label: t('fix.somethingElse'), icon: 'mic', onClick: () => { stopSpeaking(); showFixAsk(); } },
      ]
    : null;
  // The spoken script is on the card, one line per beat, and lights up as it is
  // said — so the user can read along, or catch up after looking away.
  const script = s.beats.map((b) => `<div class="beat">${esc(b.text)}</div>`).join('');
  showCard(
    kicker(modeId),
    `<b>${esc(title)}</b><div class="beats">${script}</div>`,
    t('step.counter', { index: stepIndex + 1, total: steps.length }) + (partName ? ` · ${partName}` : ''),
    { nav: true, chips }
  );
  ui.stepPrev.disabled = stepIndex === 0;
  const last = stepIndex === steps.length - 1;
  setLabel(ui.stepNext, t(last ? 'btn.done' : 'btn.next'), last ? 'check' : 'next');
  playBeats(preface);
}
function goStep(delta) {
  if (!steps.length) return;
  // 'Done' on the last Fix step closes the plan and asks for the next problem —
  // the mode's question is where it starts and where it returns to, planner or
  // no planner. (Without one, the next answer is the authored procedure again.)
  if (delta > 0 && stepIndex === steps.length - 1) {
    if (stepKicker === 'fix') showFixAsk(t('fix.done'));
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
  steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'assemble';
  setExplodeAmount(0); // collapse to rest *before* the puzzle takes over positions
  if (!steps.length) { showCard(kicker('assemble'), t('assemble.none')); return; }

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
  showCard(kicker('assemble'),
    `${bodyHtml}<div class="progress"><i style="width:${pct}%"></i></div>`,
    meta,
    { chips: [
      { label: t('assemble.hint'), icon: 'hint', onClick: puzzleHint },
      { label: t('assemble.placeForMe'), icon: 'place', onClick: () => { track('puzzle-assist'); puzzleAutoPlace(); } },
    ] });
}

// "3 wrong tries" / "3 Fehlversuche" — pluralised through the dictionary so a
// language that inflects differently only needs its own two strings.
function wrongTries(n) {
  return t(n === 1 ? 'assemble.wrongTry' : 'assemble.wrongTries', { count: n });
}

function puzzleMeta() {
  const st = puzzleStatus();
  const misses = st.mistakes ? ` · ${wrongTries(st.mistakes)}` : '';
  return t('step.counter', { index: st.stepIndex + 1, total: st.total }) + misses;
}

// A new step is armed: ask which part comes next — and do NOT name it. The
// naming line is the reward for getting it right (see onPuzzleCorrect).
function onPuzzleStep({ index, step }) {
  focusedPart = null; // don't leak the answer into the tutor's context
  const how = index === 0 ? t(recognizer ? 'assemble.dragOrSayHint' : 'assemble.dragHint') : '';
  renderPuzzleCard(
    `<b>${esc(step.prompt)}</b>${how ? `<span class="partdesc">${how}</span>` : ''}`,
    puzzleMeta()
  );
  say(index === 0 ? `${step.prompt} ${how}` : step.prompt);
}

/**
 * The piece went in. The reward is the **sound plus the card** — the naming line
 * is read, not spoken: a spoken confirmation runs longer than the pause before
 * the next step arms, so it collided with the next prompt (and, being newer, the
 * prompt cut it off mid-word). One voice per placement, and it is the one that
 * tells the learner what to do next.
 */
function onPuzzleCorrect({ step, assisted }) {
  const shown = step.label || step.name;
  focusedPart = shown || null;
  playSfx('snap'); // the whole audible reward for a correct drop
  renderPuzzleCard(
    // The tick is earned, so it only appears on a placement the learner made.
    `<b class="named">${assisted ? '' : iconSvg('check')}${esc(shown)}</b><span class="partdesc">${esc(step.text)}</span>`,
    puzzleMeta(),
    puzzleStatus().stepIndex + 1
  );
  track(assisted ? 'puzzle-assist-placed' : 'puzzle-correct', {
    metadata: { model: ui.model.value, part: step.name },  // canonical name: comparable across languages
  });
}

/**
 * A piece didn't go in. The shake and the red flash are puzzle.js's job and
 * already say the drop failed, so the words don't repeat that — they name the
 * part to reach for instead. `expected` leads; the tutor then adds why it has to
 * come first. Falls back to the step's own instruction line whenever
 * DeutschlandGPT is unreachable, so the guidance is never silent.
 */
async function onPuzzleWrong({ step, attempted, expected, expectedLabel }) {
  const seq = ++wrongSeq;
  playSfx('reject'); // immediate, unlike the AI line below
  // The tutor is prompted with the *display* name so its sentence names the
  // part the same way the card does; telemetry keeps the canonical one.
  const shown = expectedLabel || expected;
  const next = t('assemble.nextPart', { part: shown });
  renderPuzzleCard(`<b>${esc(next)}</b><span class="partdesc">${esc(step.text)}</span>`, puzzleMeta());
  showCaption(esc(next));
  track('puzzle-wrong', { metadata: { model: ui.model.value, attempted, expected, lang: getLang() } });

  const why = await explainNextPart(getContext(), {
    attempted: partLabelByName(attempted),
    expected: shown,
    stepText: step.text,
  });
  if (seq !== wrongSeq || !isPuzzleActive()) return; // superseded, or the mode changed
  renderPuzzleCard(`<b>${esc(next)}</b><span class="partdesc">${esc(why)}</span>`, puzzleMeta());
  showCaption(esc(why));
  say(why);
}

// The display name for a bare canonical part name (what puzzle.js reports).
function partLabelByName(name) {
  const p = parts.find((q) => q.name === name);
  return p ? partLabel(p) : name;
}

// Picking a part up focuses it for the tutor, so "what is this?" works mid-drag
// without naming it on screen — the question stays the user's to answer.
function onPuzzleCarry(index) {
  focusedPart = index >= 0 ? partLabel(parts[index]) : null;
}

function onPuzzleComplete({ mistakes, assists }) {
  focusedPart = null;
  const clean = mistakes === 0 && assists === 0;
  const tally = wrongTries(mistakes) + (assists ? t('assemble.assists', { count: assists }) : '');
  const line = clean ? t('assemble.clean') : t('assemble.scored', { mistakes: tally });
  showCard(
    kicker('assemble'),
    `<b>${esc(t('assemble.complete', { model: modelLabel() }))}</b><span class="partdesc">${esc(line)}</span>`,
    t('assemble.completeMeta'),
    { chips: [
      { label: t('assemble.again'), icon: 'again', onClick: () => enterMode('assemble') },
      { label: t('assemble.explore'), icon: 'explore', onClick: () => enterMode('explore') },
    ] }
  );
  say(line);
  track('puzzle-complete', { metadata: { model: ui.model.value, lang: getLang(), mistakes, assists } });
}

// --- Assemble: answering out loud -------------------------------------------
//
// The learner can *say* which piece goes on next instead of dragging it. This
// is a **mode-scoped content route**, structurally the same as Fix's spoken
// problem (handleSpeech): it only exists while a step is on screen unanswered,
// the utterance is only ever read as a part, and it can never navigate or
// switch modes. Anything that turns out to be a question falls straight through
// to the question channel, so the mic keeps working as it always did.
//
// Two reasons it earns its place over the drag: on a phone the drag is the
// fiddliest interaction in the app (all of applyAssist exists to prop it up),
// and naming a piece is a harder recall task than pointing at one — the ghost
// outline already shows *where* it goes, so the drag only ever tested which.

let answerSeq = 0;  // newest utterance wins if two answers race

// Filler an answer gets wrapped in, stripped before an exact-name match. Kept
// tiny and anchored on purpose: this is the zero-latency path, so it must be
// almost impossible to trigger by accident. Anything it is unsure about is the
// LLM resolver's problem, not something to guess at here.
const ANSWER_FILLER = /^(?:it'?s|its|that'?s|thats|this is|i think it'?s|maybe|probably|the|a|an|das ist|das|der|die|ein|eine|es ist|ich glaube|vielleicht|wohl)\s+/i;
// Only used on the no-AI path below, where nothing else can spot a question.
const QUESTION_LEAD = /^(?:what|which|where|why|how|who|can|could|should|tell|show|help|wo|was|welche[rsn]?|warum|wieso|wie|wer|kann|soll|zeig|hilf)\b/i;
// Dropped before the keyword fallback in canonicalPartName — as substrings
// these match most of the model and would resolve to an arbitrary part.
const ANSWER_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'der', 'die', 'das', 'und', 'von', 'für', 'fur', 'mit']);

/**
 * Resolve a spoken phrase to a canonical part name without an LLM round trip.
 *
 * Exact match only (after stripping filler), because a false positive here is
 * expensive: it would turn a question into a wrong answer and cost the learner
 * a mistake. The one exception is when DGPT is unconfigured — then this is the
 * only resolver there is, so it also accepts the name embedded in a short
 * phrase, guarded against anything that opens like a question.
 */
function localPartAnswer(phrase) {
  let s = phrase.toLowerCase().replace(/[.!?,;]+$/g, '').trim();
  for (let i = 0; i < 3 && ANSWER_FILLER.test(s); i++) s = s.replace(ANSWER_FILLER, '').trim();
  if (!s || s.split(/\s+/).length > 5) return null;

  // Group names first: "caster" is a better answer than "caster stem", and it
  // is what a learner actually says. `built` is matched too — not as an answer,
  // but so puzzleAnswerByName can report 'placed' and we can say so.
  const { groups, parts: loose, built } = puzzleAnswerCandidates();
  const pool = [
    ...groups.map((g) => [g.name, g.label]),
    ...loose.map((n) => [n, partLabelByName(n)]),
    ...built.map((g) => [g.name, g.label]),
  ];
  for (const [name, label] of pool) {
    if (s === name.toLowerCase() || s === label.toLowerCase()) return name;
  }
  if (aiAvailable() || QUESTION_LEAD.test(s)) return null;
  // No LLM to catch the rest, so this is the only resolver there is: accept the
  // name embedded in a short phrase, having ruled out anything question-shaped.
  return pool.find(([name, label]) => s.includes(name.toLowerCase()) || s.includes(label.toLowerCase()))?.[0] || null;
}

/**
 * Display name for an answer, which may be a semantic group ("Caster") rather
 * than a part. partLabelByName only knows parts, and would hand back the raw
 * English group name in a German session.
 */
function answerLabel(name) {
  const { groups, built } = puzzleAnswerCandidates();
  return [...groups, ...built].find((g) => g.name === name)?.label || partLabelByName(name);
}

/**
 * Walk the name the LLM echoed back to something puzzle.js matches on.
 *
 * It copies from the candidate list, which is in the *display* language, so try
 * the display name and the canonical one first. The keyword fallback is what
 * catches a near miss — the same `findParts` route `highlightPartByName` uses —
 * because a resolver that silently answers "I didn't catch that" on a name that
 * is one word off is worse than one that guesses within the model's own parts.
 */
function canonicalPartName(shown) {
  const target = (shown || '').toLowerCase().trim();
  if (!target) return null;

  const { groups } = puzzleAnswerCandidates();
  const group = groups.find((g) => g.label.toLowerCase() === target || g.name.toLowerCase() === target);
  if (group) return group.name;

  const hit = parts.find((p) => partLabel(p).toLowerCase() === target)
           || parts.find((p) => (p.name || '').toLowerCase() === target);
  if (hit) return hit.name;

  // Last resort: the whole phrase as a keyword, then its individual words.
  // findParts matches by substring, so a two-word near miss never lands whole —
  // "Gas lift" only reaches "Gas cylinder" once "gas" is tried on its own.
  // Filler words are dropped or they would match half the model.
  const walked = String(canonicalName(target) || target).toLowerCase();
  const whole = findParts(parts, [walked]);
  if (whole.length) return parts[whole[0]].name;
  const words = walked.split(/\s+/).filter((w) => w.length >= 3 && !ANSWER_STOPWORDS.has(w));
  const loose = words.length ? findParts(parts, words) : [];
  return loose.length ? parts[loose[0]].name : null;
}

/**
 * Try to read `phrase` as an answer to the current step. Returns true when it
 * was handled here, false to let handleSpeech treat it as a question.
 */
async function assembleVoiceAnswer(phrase) {
  const my = ++answerSeq;
  const before = puzzleStatus();
  if (!before) return false;

  // Fast path: they simply said the name. No round trip — and the only path
  // that still works with no DGPT configured.
  let name = localPartAnswer(phrase);

  if (!name) {
    if (!aiAvailable()) return false;   // nothing else can read it — try it as a question
    showCaption(esc(t('voice.thinking', { text: phrase })));
    const res = await resolveSpokenPart(
      getContext(), phrase, puzzleAnswerCandidates().groups.map((g) => g.label)
    );
    if (my !== answerSeq) return true;  // a newer utterance owns the step now
    if (res.question) return false;     // not an answer at all — fall through
    name = res.part ? canonicalPartName(res.part) : null;
    if (!name) {                        // meant a part, but which one is anyone's guess
      const line = t('assemble.unclear');
      showCaption(esc(line));
      say(line);
      track('puzzle-voice-answer', {
        input: phrase,
        metadata: { model: ui.model.value, lang: getLang(), part: res.part || null, outcome: 'unclear' },
      });
      return true;
    }
  }

  // The resolver is async: Next, a drag, a mode change or a language switch
  // could all have moved the puzzle on underneath it.
  const now = puzzleStatus();
  if (currentMode !== 'assemble' || !now?.awaiting || now.stepIndex !== before.stepIndex) return true;

  const outcome = puzzleAnswerByName(name);
  track('puzzle-voice-answer', {
    input: phrase,
    // Canonical name, like the drag path — telemetry stays comparable across languages.
    metadata: { model: ui.model.value, lang: getLang(), part: name, outcome },
  });

  // 'correct' and 'wrong' say nothing here on purpose: solveStep/reject have
  // already fired the cue, the card and (on a miss) the tutor's explanation,
  // exactly as they do for a drag. Speaking on top would collide with those.
  if (outcome === 'correct') hideCaption();  // the card carries the result
  else if (outcome !== 'wrong') {            // 'placed' / 'unknown' / refused
    const line = outcome === 'placed'
      ? t('assemble.alreadyOn', { part: answerLabel(name) })
      : t('assemble.unclear');
    showCaption(esc(line));
    say(line);
  }
  return true;
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
  showCaption(t('assemble.hintCaption'));
  track('puzzle-hint');
}

// --- Quiz: highlight a part, ask you to name it ---
function enterQuiz() {
  quizItems = resolveQuiz(currentKey(), parts);
  quizIndex = 0;
  mildExplode();
  if (!quizItems.length) { showCard(kicker('quiz'), t('quiz.none')); return; }
  renderQuiz();
}
function quizMeta() {
  return t('quiz.counter', { index: quizIndex + 1, total: quizItems.length });
}
function renderQuiz() {
  const q = quizItems[quizIndex];
  quizRevealed = false;
  isolateParts(parts, q.indices);
  flyTo(q.indices); // the part being asked about has to be visible to be answerable
  focusedPart = q.indices.length ? partLabel(parts[q.indices[0]]) : focusedPart;
  showCard(kicker('quiz'), esc(q.question), quizMeta(), {
    chips: [
      { label: t('quiz.reveal'), icon: 'check', onClick: revealQuiz },
      { label: t('quiz.next'), icon: 'next', onClick: nextQuiz },
    ],
  });
  say(q.question);
}
function revealQuiz() {
  if (quizRevealed) return;
  quizRevealed = true;
  const q = quizItems[quizIndex];
  showCard(kicker('quiz'), `${esc(q.question)}<br><b>${esc(t('quiz.answer', { answer: q.answer }))}</b>`, quizMeta(), {
    chips: [{ label: t('quiz.next'), icon: 'next', onClick: nextQuiz }],
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
      const name = partLabel(parts[index]);
      focusedPart = name;
      // Just the name — the authored part facts (partInfoDigest) are deliberately
      // NOT shown or spoken here. They go to the LLM as grounding (getContext),
      // so the detail surfaces only when the user actually asks about the part.
      showCard(
        kicker('explore'),
        `<b>${esc(name)}</b>`,
        t('explore.partMeta', { tris: parts[index].triangleCount.toLocaleString(locale()) })
      );
      say(name);
    } else {
      focusedPart = null;
      showCard(kicker('explore'), t('explore.intro'), t('explore.partCount', { count: parts.length }));
    }
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
    modelLabel: modelLabel(),
    // Display names, not canonical ones: the LLM answers in the selected
    // language, so the parts it is allowed to name must be spelled the way the
    // user hears them. resolvePlanParts/highlightPartByName walk them back.
    parts: parts.map((p) => partLabel(p)).filter(Boolean),
    mode: currentMode,
    focusedPart,
    // ALL authored per-part facts (MARKUS_INFO). Never shown or spoken directly
    // — they ground the LLM's answer about whichever part the question concerns.
    partInfo: partInfoDigest(currentKey()),
    // Authored repair + fault knowledge for this model, so the AI tutor grounds
    // free-form answers in the real faults instead of guessing.
    faults: knowledgeDigest(currentKey()),
  };
}

function showCaption(html) {
  ui.voiceCaption.innerHTML = html;
  ui.voiceCaption.classList.add('show');
  clearTimeout(showCaption._t);
  showCaption._t = setTimeout(() => ui.voiceCaption.classList.remove('show'), 7000);
}

// Retire a caption early. A "…thinking" placeholder outlives what it was
// waiting for whenever the result lands somewhere else — a spoken answer that
// turns out to be correct says nothing and shows up on the card instead, and
// leaving "…thinking" on screen for the full 7 s reads like a hang.
function hideCaption() {
  clearTimeout(showCaption._t);
  ui.voiceCaption.classList.remove('show');
}

// The mic is a **question channel, nothing else**: a spoken phrase never drives
// the app (no mode switches, no "next", no part selection). Misheard noise used
// to turn into commands and the app would "act on its own" — that's gone. Two
// deliberate, strictly-matched exceptions survive because they have no button
// equivalent: silencing the tutor mid-answer, and re-placing the model in AR.
//
// Both patterns accept BOTH languages at once, on purpose. They are the only
// utterances that must work under stress — you say "stop" when the tutor is
// talking over you — and a German speaker reaching for "stop" (or an English
// speaker for "halt") should not be met with silence because of a setting.
// Recognising an extra half-dozen fixed words costs nothing and can't misfire:
// MUTE_RE anchors the whole utterance, and MOVE_RE only applies inside AR to
// phrases of four words or fewer.
const MUTE_RE = /^\s*(stop|stopp|be quiet|quiet|shut up|silence|stop talking|stop speaking|halt|halt stopp|sei (?:mal )?(?:still|leise)|ruhe|schweig|hör auf|hor auf|aufhören|aufhoren)[.!\s]*$/i;
const MOVE_RE = /\b(move|reposition|verschieb\w*|versetz\w*|beweg\w*|umstellen|woanders)\b/i;

let askSeq = 0; // newest question wins: older in-flight answers are dropped

// `phrase`, not `t` — `t` is the translation function at module scope, and a
// local of that name would shadow it for this whole function.
async function handleSpeech(text) {
  const phrase = text.trim();
  if (!phrase) return;

  if (MUTE_RE.test(phrase)) { stopSpeaking(); showCaption(t('voice.muted')); track('voice-mute', { input: phrase }); return; }
  // AR-only: "move it" re-enters placement — voice is the only way (see moveARFlow).
  if (renderer.xr.isPresenting && phrase.split(/\s+/).length <= 4 && MOVE_RE.test(phrase)) {
    moveARFlow();
    track('voice-move', { input: phrase });
    return;
  }

  // Fix mode, waiting for a problem: the utterance IS the fix request — the
  // content input this mode exists to receive (a suggestion chip, spoken), not a
  // command; it never navigates or switches modes. Speaking again while a plan
  // is still being drafted simply replaces it (fixSeq — newest request wins).
  // Not gated on the planner being reachable: the ask screen is shown either
  // way, so an answer to it has to be accepted either way — startFixRequest
  // falls back to the authored procedure.
  if (currentMode === 'fix' && (fixState === 'ask' || fixState === 'planning')) {
    startFixRequest(phrase);
    return;
  }

  // Assemble, with a step on screen unanswered: the utterance is the learner's
  // *answer* — the content this mode exists to receive, exactly like Fix's
  // spoken problem above. It never navigates and never switches modes, and it
  // hands anything that turns out to be a question straight back to us.
  if (currentMode === 'assemble' && puzzleStatus()?.awaiting) {
    if (await assembleVoiceAnswer(phrase)) return;
  }

  const my = ++askSeq;
  // A question outranks the walkthrough: stop narrating steps before answering.
  // The VAD's barge-in already does this the moment the user speaks, but a
  // transcript can also arrive without it (the Web Speech fallback fires no
  // speech-start), and then the step would talk over its own answer.
  cancelBeats();
  showCaption(esc(t('voice.thinking', { text: phrase })));
  track('voice-question', { input: phrase, metadata: { mode: currentMode, lang: getLang(), part: focusedPart } });
  // The LLM answers about whichever part the question concerns and names it —
  // the app then spotlights that part, so asking about the gas lift while the
  // seat is selected highlights the gas lift and answers about it. When the
  // answer describes a physical motion, the LLM also picks the ACTION verb and
  // the part *acts it out* (a few loops, then it settles back).
  const { part, action, answer } = await answerQuestion(getContext(), phrase);
  if (my !== askSeq) return;             // a newer question superseded this answer
  // If the mic is mid-capture, hold the answer until the utterance resolves
  // instead of discarding it: if that capture turns out to be a new question,
  // askSeq supersedes this answer naturally; if it was a noise blip (or the
  // old stuck-VAD state), the user still gets answered. Dropping here silently
  // was how "it heard me but never replied" happened.
  const holdUntil = performance.now() + 8000;
  while (recognizer?.isCapturing() && performance.now() < holdUntil) {
    await new Promise((r) => setTimeout(r, 150));
    if (my !== askSeq) return;
  }
  if (my !== askSeq) return;
  if (recognizer?.isCapturing()) return; // still talking after 8 s — stay quiet
  const indices = part ? highlightPartByName(part) : [];
  showCaption(esc(answer));
  // Act the answer out while it is being spoken, and stop when it stops — the
  // same start/end signals the Fix walkthrough runs on. The beat token owns the
  // model, so a step starting meanwhile takes the gesture over cleanly.
  const gesture = action && !isPuzzleActive() && (indices.length || isObjectAction(action)) ? action : null;
  let myBeat = beatSeq;
  narrate(answer, () => {
    if (my !== askSeq || !gesture) return;
    myBeat = ++beatSeq;
    startFixAnim(parts, indices, gesture, {
      scale: modelRadius,
      amount: parseFloat(ui.explode.value) || 0,
      group: explodedGroup,
      onGroupPose: groundExploded,
    });
  }).then(() => { if (myBeat === beatSeq) stopFixAnim(); });
}

/**
 * Spotlight the part the tutor just answered about. Exact-name match first
 * (the LLM copies names from the parts list), keyword fallback for near
 * misses. Only Explore rewrites the card/selection — the other modes keep
 * their own step/symptom isolation, we just don't fight it mid-flow.
 * Returns the matched part indices ([] if none) so the caller can animate them.
 */
function highlightPartByName(name) {
  const target = (name || '').toLowerCase().trim();
  if (!target) return [];
  // The LLM copies from the parts list it was given, which is in the *display*
  // language — so match the display name first, then the canonical one, and
  // only then fall back to keywords (which are English, hence canonicalName).
  const exact = parts.find((p) => partLabel(p).toLowerCase() === target)
             || parts.find((p) => (p.name || '').toLowerCase() === target);
  const indices = exact ? findParts(parts, [exact.name]) : findParts(parts, [canonicalName(target)]);
  if (!indices.length) return [];
  focusedPart = partLabel(parts[indices[0]]);
  if (currentMode === 'explore') {
    selectedPart = indices[0];
    isolateParts(parts, indices, { highlight: false }); // match the tap look: textured part, rest ghosted
    showCard(
      kicker('explore'),
      `<b>${esc(focusedPart)}</b>`,
      indices.length > 1
        ? t('explore.groupMeta', { count: indices.length })
        : t('explore.partMeta', { tris: parts[indices[0]].triangleCount.toLocaleString(locale()) })
    );
  }
  return indices;
}

// DEBUG: simulate a spoken phrase from the console (no mic needed) — exercises
// the exact same routing as real speech, incl. Fix-mode planning.
window.__ask = handleSpeech;
// DEBUG: advance the animation stack by hand, in the render loop's own order.
// The loop is the only caller in real use, but a hidden or backgrounded tab
// gets no rAF at all, so this is how the animations stay testable headlessly.
window.__tick = (dt = 1 / 60) => {
  updatePuzzle(dt);   // first, as in the loop: the puzzle owns part positions while it runs
  updateTweens(dt);
  updateFixAnim(dt, parseFloat(ui.explode.value) || 0);
};
// DEBUG: the walkthrough currently loaded — which beats, gestures and parts the
// planner produced, and where we are in it.
window.__plan = () => ({
  title: stepTitle,
  stepIndex,
  steps: steps.map((s) => ({
    beats: s.beats?.map((b) => ({ action: b.action, text: b.text, parts: b.indices.map((i) => parts[i].name) })),
  })),
});
// DEBUG: play any gesture on any parts, for eyeballing one in isolation.
window.__gesture = (action, indices = []) => {
  cancelBeats();
  startFixAnim(parts, indices, action, {
    scale: modelRadius,
    amount: parseFloat(ui.explode.value) || 0,
    group: explodedGroup,
    onGroupPose: groundExploded,
  });
  return { action, indices };
};

// ---- The mic: push-to-talk, with hands-free as the opt-in ------------------
//
// Holding the button is the primary way to be heard, because press and release
// ARE the utterance boundaries — nothing has to infer them from a signal, so a
// quiet voice, a loud room and a mid-sentence pause all behave the same. The
// VAD's guess is still available (the Controls toggle) for when both hands are
// on the object, which is the case AR exists for.
//
// One button, two gestures:
//   hold  → talk; the release sends what was said
//   tap   → arm the mic (so the next hold records from the first millisecond),
//           or mute it again if it was already armed
const MIC_TAP_MS = 250; // shorter than this was a tap, not a question

// Mirrored from onStateChange so a language switch can relabel the mic button
// without asking the recognizer (which may not exist) what state it is in.
let micListening = false;
let micHeld = false;
let micHoldStart = 0;
let micWasArmed = false;

// Hands-free is a preference, not a screen: it follows the user across links,
// like theme and language. Default off — see the toggle's comment in index.html.
const handsFreePref = () => localStorage.getItem('handsfree') === '1';
ui.handsfree.checked = handsFreePref();

const recognizer = createRecognizer({
  onResult: handleSpeech,
  handsFree: ui.handsfree.checked,
  // Barge-in: the instant the user starts talking, the tutor yields — their next
  // question must never compete with a half-finished answer, and a Fix
  // walkthrough must not carry on to the next sentence over their voice.
  onSpeechStart: () => { stopSpeaking(); cancelBeats(); },
  // Lets the VAD demand more sustained energy while the tutor is audible, so
  // speaker bleed the echo canceller misses can't trigger a false barge-in.
  isTtsSpeaking: isSpeaking,
  onStatus: (phase) => {
    if (phase === 'transcribing') showCaption(t('voice.transcribing'));
    else if (phase === 'arming') showCaption(t('voice.arming'));
  },
  onError: (msg) => showCaption(esc(msg)),
  onStateChange: (listening) => { micListening = listening; paintMic(); },
});
if (!recognizer) {
  ui.micBtn.disabled = true;
  ui.micBtn.title = t('btn.micTitle');
}

// Three states worth telling apart: held (recording right now), hands-free and
// armed (the VAD is deciding), armed but idle (a hold will be instant).
function paintMic() {
  const hands = micListening && ui.handsfree.checked;
  setLabel(ui.micBtn, t(micHeld ? 'btn.micHold' : hands ? 'btn.micListening' : 'btn.mic'));
  ui.micBtn.classList.toggle('listening', micHeld || hands);
  ui.micBtn.classList.toggle('holding', micHeld);
  ui.micBtn.classList.toggle('armed', micListening && !micHeld && !hands);
  if (recognizer) ui.micBtn.title = t('btn.micHint');
}

function micDown(e) {
  if (!recognizer || ui.micBtn.disabled || micHeld) return;
  // A held button is not a tap, a scroll or a text selection; claiming the
  // pointer means a finger that slides off the button still ends the utterance
  // here rather than silently cancelling it.
  e.preventDefault();
  try { ui.micBtn.setPointerCapture?.(e.pointerId); } catch { /* mouse on old Safari */ }
  micHeld = true;
  micHoldStart = performance.now();
  micWasArmed = recognizer.isListening();
  stopSpeaking(); // the tutor yields even before the first syllable arrives
  cancelBeats();
  paintMic();
  showCaption(t('voice.holdHint'));
  recognizer.press();
}

function micUp(e) {
  if (!micHeld) return;
  micHeld = false;
  try { ui.micBtn.releasePointerCapture?.(e?.pointerId); } catch { /* never captured */ }
  const held = performance.now() - micHoldStart;
  const sent = recognizer.release();
  paintMic();
  if (sent) return;                       // on its way to the transcriber
  if (held < MIC_TAP_MS && micWasArmed) { // a tap on a live mic mutes it
    recognizer.stop();
    showCaption(t('voice.micOff'));
  } else {
    // Either a tap that armed the mic, or a hold too short to be a question —
    // both want the same sentence.
    showCaption(t(micWasArmed ? 'voice.holdHint' : 'voice.micArmed'));
  }
}

ui.micBtn.addEventListener('pointerdown', micDown);
ui.micBtn.addEventListener('pointerup', micUp);
ui.micBtn.addEventListener('pointercancel', micUp);
// A tab switch or an alt-tab mid-hold never delivers pointerup: close the
// utterance rather than leaving the recorder open behind a hidden page.
window.addEventListener('blur', () => micUp());
// The button lives in the AR dom-overlay, where a touch also reaches WebXR as a
// `select` — which is tap-to-place, or a puzzle drag. A hold lasts seconds, so
// this is the difference between asking a question and re-placing the chair.
ui.micBtn.addEventListener('beforexrselect', (e) => e.preventDefault());
// Keyboard parity for the desktop viewer (and for anyone who can't hold a
// pointer down): Space or Enter held on the focused button talks. `repeat`
// filters the OS key-repeat, which would otherwise re-press every ~30 ms.
ui.micBtn.addEventListener('keydown', (e) => {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  if (!e.repeat) micDown(e);
});
ui.micBtn.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); micUp(e); }
});

ui.handsfree.addEventListener('change', () => {
  const on = ui.handsfree.checked;
  localStorage.setItem('handsfree', on ? '1' : '0');
  recognizer?.setHandsFree(on);
  // The change event is a user gesture, so this is a legal moment to ask for
  // the mic — hands-free with a closed mic would just be a dead switch.
  if (on && recognizer && !recognizer.isListening()) recognizer.start();
  paintMic();
  showCaption(t(on ? 'voice.handsfreeOn' : 'voice.handsfreeOff'));
  track('handsfree', { metadata: { on } });
});

paintMic();

// AR availability + start/exit. `arSupported` is kept so a language switch
// knows which of the two AR-button captions applies.
let arSupported = true;
(async () => {
  const supported = await isARSupported();
  track('ar-support', { metadata: { supported } });
  if (!supported) {
    arSupported = false;
    setLabel(ui.startAR, t('btn.arUnsupported'));
    ui.startAR.disabled = true;
    ui.startAR.title = t('btn.arTitle');
  }
})();

// Shared AR entry points (buttons *and* voice call these). Note: WebXR
// requestSession normally needs a user gesture, so a purely voice-triggered
// start may be rejected — we catch that and tell the user to tap the button.
async function startARFlow() {
  if (renderer.xr.isPresenting) return;
  if (ui.startAR.disabled) { showCaption(t('ar.needsAndroid')); return; }
  cancelTween('camera'); // ar.js saves + owns the camera pose from here on
  try {
    document.body.classList.add('ar-active');
    track('ar-start', { metadata: { model: ui.model.value, lang: getLang() } });
    await startAR({
      renderer, scene, camera, group: explodedGroup, controls,
      overlay: document.body,
      fitBox: restBounds(), // size to the assembled chair, not its exploded spread
      onPlaced: () => {
        track('ar-placed', { metadata: { model: ui.model.value } });
        applyARInteraction(); // pivot exists only once placed — size + lock it now
        if (isPuzzleActive()) {
          showCaption(t('ar.placedPuzzle'));
          say(t('ar.placedPuzzleSpoken'));
        } else {
          showCaption(t('ar.placed'));
          say(t('ar.placedSpoken'));
        }
      },
      onSelectedChange: (sel) => {
        track(sel ? 'ar-select' : 'ar-deselect');
        showCaption(t(sel ? 'ar.grabbed' : 'ar.released'));
      },
      onEnd: () => {
        document.body.classList.remove('ar-active');
        arLifeSize = false;
        applyGhostTheme(); // back to the theme's ghost colour, off the camera feed
        track('ar-exit');
      },
    });
    applyGhostTheme(); // the session is live now → the AR ghost colour
    setInteractor(puzzleInteractor); // the finger's target ray drives part dragging
    showCaption(t('ar.pointAtFloor'));
  } catch (e) {
    console.error('AR failed', e);
    document.body.classList.remove('ar-active');
    track('ar-error', { metadata: { error: e.message }, level: 'ERROR' });
    showCaption(t('ar.failed'));
  }
}
// Voice-only ("move it"): re-enter placement so the next floor tap re-places
// the model on a fresh anchor — hands-free reposition to a new spot/surface.
// Everyday nudging is just long-press + drag, so there's no on-screen button.
function moveARFlow() {
  if (!renderer.xr.isPresenting) { showCaption(t('ar.moveFirst')); return; }
  requestMove();
  showCaption(t('ar.tapToMove'));
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
  // The backdrop is the stylesheet's job now (see scene.background = null), so
  // the only 3D thing a theme owes is the ghost wireframe, which has to stay
  // legible against whichever backdrop it ends up on.
  // The button offers the theme you'd switch TO, so it shows the other one's icon.
  setLabel(ui.themeToggle, t(dark ? 'btn.light' : 'btn.dark'), dark ? 'sun' : 'moon');
  applyGhostTheme();
  try { localStorage.setItem('theme', theme); } catch {}
}
const isDark = () => document.documentElement.dataset.theme === 'dark';
applyTheme(
  (() => { try { return localStorage.getItem('theme'); } catch { return null; } })() || 'light'
);
ui.themeToggle.addEventListener('click', () => {
  applyTheme(isDark() ? 'light' : 'dark');
});

// ---- Language --------------------------------------------------------------
// One control, everything follows: chrome, cards, authored content, part names,
// the tutor's prompts, the TTS voice and the STT language hint.

// Populate the panel's language <select> and label the corner toggle.
for (const l of LANGS) {
  const opt = document.createElement('option');
  opt.value = l.id;
  opt.textContent = l.label;
  ui.lang.appendChild(opt);
}
ui.lang.value = getLang();

// The corner button shows the language you'd switch TO, which is what a
// one-tap toggle has to say to be predictable.
function labelLangToggle() {
  const other = LANGS.find((l) => l.id !== getLang()) || LANGS[0];
  setLabel(ui.langToggle, other.short);
  ui.langToggle.dataset.next = other.id;
}
labelLangToggle();

ui.lang.addEventListener('change', () => setLang(ui.lang.value));
ui.langToggle.addEventListener('click', () => setLang(ui.langToggle.dataset.next));

/**
 * Re-render everything after a language switch.
 *
 * The chrome and the labels are re-read in place, but the *card* is not: its
 * content is authored text resolved when the mode was entered, and half of it
 * (a generated Fix plan, an answer the LLM wrote) exists only in the language
 * it was produced in. Re-entering the mode is the honest way to get a fully
 * German (or fully English) screen — the alternative is a card that stays half
 * translated, which is exactly what this feature exists to prevent.
 */
onLangChange((next) => {
  track('language-switch', { metadata: { lang: next, model: ui.model.value, mode: currentMode } });
  stopSpeaking();                    // an English sentence mid-flight would finish in English
  recognizer?.setLang();             // Web Speech needs a bounce; the VAD path re-reads per utterance
  applyStaticTranslations();
  relabelModes();
  labelLangToggle();
  relabelModels();
  refreshHome();                     // the home picker lists model names too
  ui.lang.value = next;
  applyTheme(isDark() ? 'dark' : 'light');   // re-label the theme button
  paintMic();                        // caption + title, in whichever mic state we're in
  if (!recognizer) ui.micBtn.title = t('btn.micTitle');
  if (!arSupported) { setLabel(ui.startAR, t('btn.arUnsupported')); ui.startAR.title = t('btn.arTitle'); }
  ui.status.textContent = t(statusKey, statusVars);
  buildLegend();                     // part names are display names
  enterMode(currentMode);            // re-resolve the mode's content in the new language
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
  // After updateTweens: the step clip layers over the explode state and must
  // win the frame for its own parts (it re-derives the base from the live
  // amount, so slider drags and explode tweens keep working underneath it).
  updateFixAnim(dt, parseFloat(ui.explode.value) || 0);
  controls.update();
  renderer.render(scene, camera);
});

// ---- Home screen -----------------------------------------------------------
// The front door: scan the real object with the camera, or pick from the list.
// It is an overlay over the live scene, so choosing is just a model load.

/**
 * Vision label (vision.js's closed set) → model key. `none` is deliberately
 * absent: an unmapped label is the "couldn't tell" path, and home.js sends the
 * user back to the picker rather than guessing at a model.
 *
 * "chair" lands on the hero Markus, not the office chair — every mode's content
 * is authored for the Markus, and the office chair is hidden from the pickers
 * for the same reason.
 */
const SCAN_MODELS = {
  chair: 'markus-chair',
  bicycle: 'bicycle',
  bed: 'bed',
};

initHome({
  getOptions: selectableModels,
  scanMap: SCAN_MODELS,
  // Both of these navigate and let the router do the work — see "Routing".
  // A pick keeps the mode you were in, exactly as the model dropdown does.
  onPick: (key) => { if (MODELS[key]) goTo({ kind: 'object', model: key, mode: currentMode }, 'home'); },
  onView: (view) => goTo({ kind: 'home', view }),
});

ui.homeBtn.addEventListener('click', () => goTo({ kind: 'home', view: 'choose' }));

// ---- Routing ---------------------------------------------------------------
// One link per screen: `#/`, `#/scan`, `#/objects`, `#/<model>/<mode>`. Two
// directions, and keeping them apart is what stops the URL and the app arguing:
//
//  * **state → URL** (`syncRoute`): the app writes its own address after every
//    change, so however a screen was reached — a mode button, a chip's
//    `enterMode`, a finished model load — the address bar already describes it.
//  * **URL → state** (`applyRoute`): a navigation *means* something, and this is
//    the only place that acts on it. Back/Forward, a pasted link and a cold boot
//    are then literally the same code path.
//
// Everything a user can click that changes screens goes through `goTo`, so the
// history holds exactly their steps. `applyRoute` is idempotent — it only ever
// does the part that isn't already true — which is what lets `goTo` apply
// immediately *and* the `hashchange` it triggers arrive harmlessly afterwards.

// The vocabulary a link is validated against. Only *selectable* models: the
// dropdown has no <option> for a hidden one, so pointing it at `office-chair`
// would blank ui.model.value and leave currentModel() undefined.
const routeVocab = () => ({
  models: selectableModels().map((o) => o.key),
  // Hidden modes are not link vocabulary either: a bookmark to a retired mode
  // lands on the default rather than on a screen with no button to leave it by.
  modes: selectableModes().map((m) => m.id),
  defaultMode: 'explore',
});

let applyingRoute = false;

/** Where the app *is*, derived from state — never read back from the URL. */
function stateRoute() {
  return isHomeOpen()
    ? { kind: 'home', view: homeScreenView() }
    : { kind: 'object', model: ui.model.value, mode: currentMode };
}

/** Point the address bar at wherever the app has got to. */
function syncRoute() {
  if (applyingRoute) return;   // mid-apply: the URL already says this
  const route = stateRoute();
  navigate(routePath(route));  // no-ops when nothing moved, so no junk history
  setDocumentTitle(route);
}

/** A user asked for a screen: record it in the history, then go there. */
function goTo(route, source) {
  if (!navigate(routePath(route))) return; // already there
  applyRoute(route, source);
}

/**
 * Put the app on `route`. Does only what isn't already true, so it is safe to
 * call twice for the same navigation (goTo applies eagerly; the hashchange that
 * follows lands here again).
 */
function applyRoute(route, source = 'link') {
  applyingRoute = true;
  try {
    if (route.kind === 'home') {
      stopSpeaking();          // don't let an answer carry on talking over the chooser
      openHome(route.view);
    } else {
      if (isHomeOpen()) closeHome();
      if (route.model !== loadedKey) {
        // The mode is set *before* the load: rebuild() enters `currentMode` when
        // the glTF lands, so the link's mode is where the new model opens.
        ui.model.value = route.model;
        currentMode = route.mode;
        setModeButtons(route.mode);
        track('model-load', { metadata: { model: route.model, source } });
        loadModel(route.model);
      } else if (route.mode !== currentMode) {
        enterMode(route.mode);
      }
    }
  } finally {
    applyingRoute = false;
  }
  setDocumentTitle(route);
}

/**
 * Name the tab after the screen, so a bookmark or a history entry says which
 * object and mode it is. Emoji-free `kicker.*` rather than the mode bar's
 * captions — a tab strip is not the place for 🔍.
 */
function setDocumentTitle(route) {
  const app = t('app.title');
  if (route.kind === 'home') {
    const view = route.view === 'scan' ? t('home.scan') : route.view === 'pick' ? t('home.select') : '';
    document.title = view ? `${view} · ${app}` : app;
    return;
  }
  document.title = `${modelLabel(MODELS[route.model])} · ${t(`kicker.${route.mode}`)} · ${app}`;
}

onRouteChange(() => {
  const route = currentRoute(routeVocab());
  applyRoute(route);
  // Boot normalises the URL; so must this, or a link naming something the app no
  // longer offers — a bookmark to a retired mode, a typo — leaves the address bar
  // claiming a screen the user isn't on. `replace` fires no hashchange, and
  // re-applying a route the app is already on is a no-op regardless.
  navigate(routePath(route), { replace: true });
});

// ---- Go --------------------------------------------------------------------

// Boot straight into the hero IKEA Markus and fetch nothing else — the other
// models are only loaded when the user actually selects one.
//
// On the home screen the load starts *behind* the overlay rather than after a
// choice: the Markus is both the default and the "chair" the scan resolves to,
// so by the time the user has framed a photo or read the list it is usually
// already built. A link straight to an object skips the overlay entirely and
// loads whatever that link names.
const bootRoute = currentRoute(routeVocab());
if (bootRoute.kind === 'home') loadModel(ui.model.value);
applyRoute(bootRoute, 'boot');
// Normalise what the user pasted (`#`, `#/markus-chair`, an unknown mode) to the
// canonical path, in place — replaceState fires no hashchange, and applyRoute
// has already run.
navigate(routePath(bootRoute), { replace: true });
