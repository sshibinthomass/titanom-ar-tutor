import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildExplodedView, setExplode, isolateParts, clearPartStates, setHighlight, findParts } from './explode.js';
import { attachPicker } from './select.js';
import { MODE_LIST, resolveFix, resolveAssemble, resolveDiagnose, resolveQuiz, applyNames, knowledgeDigest, describePart } from './modes.js';
import { isARSupported, startAR, updateAR, endAR, requestMove } from './ar.js';
import { speak, stop as stopSpeaking } from './tts.js';
import { createRecognizer, speechRecognitionAvailable } from './voice.js';
import { classifyCommand, answerQuestion, looksLikeQuestion, answerDiagnosis } from './tutor.js';
import { initTelemetry, track } from './telemetry.js';

// ---- Model registry --------------------------------------------------------

// Vite's base URL ('./' here) so model paths resolve under the GitHub Pages
// sub-path (…/titanom-ar-tutor/) as well as at localhost root. An absolute
// '/models/…' would wrongly point at the domain root on Pages.
const BASE_URL = import.meta.env.BASE_URL;

const MODELS = {
  'office-chair': {
    label: 'Office Chair',
    url: `${BASE_URL}models/office-chair/scene.gltf`,
    credit: 'Office Chair Modern — thethieme, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/office-chair-modern-675f34f7304e4d92812a41e9750539aa',
    defaultMode: 'component', // single fused mesh → must split by connected pieces
  },
  'markus-chair': {
    label: 'IKEA Markus Chair',
    url: `${BASE_URL}models/markus-chair/scene.gltf`,
    credit: 'IKEA Markus Office Chair — Graham Rust, Sketchfab Standard',
    creditUrl: 'https://sketchfab.com/3d-models/ikea-markus-office-chair-cee12c29ebda4bcdb91b84a6f126a971',
    defaultMode: 'group', // already 47 separate meshes → one clean part per mesh
  },
  bicycle: {
    label: 'Bicycle',
    url: `${BASE_URL}models/bicycle/scene.gltf`,
    credit: 'bicycle — local.yany, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/bicycle-8db2d442b58045baac2edfc5e9ee11e3',
    defaultMode: 'group', // 14 meshes, one per material → clean semantic parts
  },
  bed: {
    label: 'Bed Low Poly',
    url: `${BASE_URL}models/bed/scene.gltf`,
    credit: 'Bed Low Poly — LinNacume, CC-BY-4.0',
    creditUrl: 'https://sketchfab.com/3d-models/bed-low-poly-b19855811635449288827767b45d4b38',
    defaultMode: 'component', // single merged mesh → must split by connected pieces
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
ui.model.value = 'office-chair';

// Telemetry: one Langfuse session per page load. Tracks voice, AI, modes, AR,
// TTS and errors. No-op (and never throws) when Langfuse isn't configured.
initTelemetry({ initialModel: ui.model.value });

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

function frameModel() {
  const box = new THREE.Box3().setFromObject(explodedGroup);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  modelRadius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

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

  controls.target.set(0, size.y * 0.5, 0);
  const dist = modelRadius * 3.2;
  camera.position.set(dist * 0.8, size.y * 0.6 + dist * 0.4, dist * 0.9);
  camera.near = modelRadius * 0.01;
  camera.far = modelRadius * 200;
  camera.updateProjectionMatrix();
  controls.update();

  ui.explode.max = (modelRadius * 2.5).toFixed(3);
  ui.explode.step = (modelRadius * 0.004).toFixed(4);
  ui.explode.value = 0;
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
  setExplode(parts, amount);
  ui.explodeVal.textContent = amount.toFixed(2);
}
ui.explode.addEventListener('input', onExplodeChange);

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
  ui.explode.value = 0;
  onExplodeChange();
  if (explodedGroup) frameModel();
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
let lastSpoken = '';    // for the "repeat" voice command

function currentKey() { return ui.model.value; }

// Speak text via ElevenLabs (with fallback) and remember it for "repeat".
function say(text) {
  if (!text) return;
  lastSpoken = text;
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
function resetParts() {
  clearPartStates(parts);
  for (const p of parts) p.mesh.visible = true;
  ui.explode.value = 0;
  onExplodeChange();
}

// Spread parts a little so the highlighted one is easy to see in a procedure.
function mildExplode() {
  const amt = parseFloat(ui.explode.max) * 0.35;
  ui.explode.value = amt;
  onExplodeChange();
}

function enterMode(id) {
  track('mode-switch', { metadata: { mode: id, model: ui.model.value } });
  currentMode = id;
  setModeButtons(id);
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
  showCard('Explore', 'Tap any part to isolate it, then tap 🎤 and ask about it.', `${parts.length} parts`);
}

// --- Fix / Assemble: ordered steps ---
function enterFix() {
  const proc = resolveFix(currentKey(), parts);
  steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'Fix';
  mildExplode();
  renderStep();
}
function enterAssemble() {
  const proc = resolveAssemble(currentKey(), parts);
  steps = proc.steps; stepIndex = 0; stepTitle = proc.title; stepKicker = 'Assemble';
  ui.explode.value = 0; onExplodeChange();
  renderStep();
}
function renderStep() {
  const title = stepTitle, kicker = stepKicker;
  if (!steps.length) { showCard(kicker, 'No procedure for this model yet.'); return; }
  const s = steps[stepIndex];
  const stepIndices = s.indices || [];

  if (kicker === 'Assemble') {
    // Progressive build-up: reveal every part added in steps 0..stepIndex.
    const shown = new Set();
    for (let k = 0; k <= stepIndex; k++) (steps[k].indices || []).forEach((i) => shown.add(i));
    parts.forEach((p, i) => { p.mesh.visible = shown.has(i); });
    clearPartStates(parts);
    for (const i of stepIndices) setHighlight(parts[i], true); // glow the just-added group
  } else {
    isolateParts(parts, stepIndices); // spotlight this step's part(s), dim the rest
  }

  const partName = stepIndices.length ? parts[stepIndices[0]].name : null;
  focusedPart = partName;
  showCard(
    kicker,
    `<b>${title}</b><br>${s.text}`,
    `Step ${stepIndex + 1} of ${steps.length}` + (partName ? ` · ${partName}` : ' · (part not matched)'),
    { nav: true }
  );
  ui.stepPrev.disabled = stepIndex === 0;
  ui.stepNext.textContent = stepIndex === steps.length - 1 ? 'Done ✔' : 'Next ▶';
  say(s.text);
}
function goStep(delta) {
  if (!steps.length) return;
  stepIndex = Math.max(0, Math.min(steps.length - 1, stepIndex + delta));
  renderStep();
}
ui.stepPrev.addEventListener('click', () => goStep(-1));
ui.stepNext.addEventListener('click', () => goStep(1));

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
    isolateParts(parts, index >= 0 ? [index] : []);
    if (index >= 0) {
      const name = parts[index].name;
      focusedPart = name;
      const desc = describePart(currentKey(), name);
      showCard(
        'Explore',
        `<b>${name}</b>${desc ? `<span class="partdesc">${desc}</span>` : ''}`,
        `${parts[index].triangleCount.toLocaleString()} triangles · ask 🎤 about this part`
      );
      say(desc ? `${name}. ${desc}` : name);
    } else {
      focusedPart = null;
      showCard('Explore', 'Tap any part to isolate it, then tap 🎤 and ask about it.', `${parts.length} parts`);
    }
  } else if (currentMode === 'quiz' && index >= 0) {
    // Tapping a part in quiz mode is a shortcut to reveal.
    revealQuiz();
  }
});

// ---- Tutor context, voice commands, AR -------------------------------------

function getContext() {
  return {
    modelLabel: currentModel().label,
    parts: parts.map((p) => p.name).filter(Boolean),
    mode: currentMode,
    focusedPart,
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

async function explainFocused() {
  const q = focusedPart ? `What is the ${focusedPart} and how do I service it?` : 'What am I looking at?';
  showCaption('…thinking');
  // In Explore, keep "explain this" scoped to the one selected part.
  const ans = await answerQuestion(getContext(), q, { focusOnly: currentMode === 'explore' });
  showCaption(ans);
  say(ans);
}

/**
 * Explore mode is the "ask about a part" flow: a spoken phrase either selects a
 * part (a bare name or "show me the seat") or asks a question about the part
 * already selected — answered by DeutschlandGPT constrained to that part only,
 * then spoken via ElevenLabs. A question is never swallowed as a re-select.
 */
async function handleExploreSpeech(text) {
  const asking = looksLikeQuestion(text);

  // Not a question → treat as a selection ("gas cylinder", "show me the seat").
  if (!asking && selectPartByName(text)) {
    showCaption(`“${text}”`);
    track('voice-intent', { input: text, metadata: { kind: 'part-select', part: focusedPart } });
    return;
  }

  // A question, but nothing selected yet: if it names a part, select that one so
  // we have something to answer about; otherwise nudge the user to pick a part.
  if (!(selectedPart >= 0 && focusedPart)) {
    if (!selectPartByName(text)) {
      const hint = 'Tap a part first, then ask me anything about it.';
      showCaption(hint);
      say(hint);
      return;
    }
  }

  // Answer strictly about the selected part — and nothing else.
  showCaption(`“${text}” · …thinking`);
  const ans = await answerQuestion(getContext(), text, { focusOnly: true });
  showCaption(ans);
  say(ans);
  track('voice-question', { input: text, metadata: { kind: 'part-question', part: focusedPart } });
}

// Flip a checkbox and fire its change listeners (so wireframe/tint/autorotate
// behave exactly as if the user clicked them). `on` undefined → toggle.
function setToggle(el, on) {
  el.checked = on === undefined ? !el.checked : !!on;
  el.dispatchEvent(new Event('change'));
}

// Reframe the camera + collapse the explode (same as the Reset-view button).
function recenterView() {
  ui.explode.value = 0;
  onExplodeChange();
  if (explodedGroup) frameModel();
}

// Highlight a part the user named out loud. Returns true if one matched.
function selectPartByName(text) {
  const t = text.toLowerCase();
  const names = [...new Set(parts.map((p) => (p.name || '').toLowerCase()).filter(Boolean))];
  // Prefer a full-name hit ("gas cylinder"); fall back to a significant token
  // ("cylinder", "backrest") so partial phrases still land. Longest match wins.
  let best = null;
  for (const name of names) {
    if (t.includes(name) && (!best || name.length > best.key.length)) best = { name, key: name };
    for (const tok of name.split(/\s+/)) {
      if (tok.length >= 3 && new RegExp(`\\b${tok}\\b`).test(t) && (!best || tok.length > best.key.length)) {
        best = { name, key: tok };
      }
    }
  }
  if (!best) return false;

  const indices = findParts(parts, [best.name]);
  if (!indices.length) return false;
  selectedPart = indices[0];
  isolateParts(parts, indices);
  focusedPart = parts[indices[0]].name;
  showCard('Explore', `<b>${parts[indices[0]].name}</b>`, `${indices.length > 1 ? indices.length + ' pieces' : parts[indices[0]].triangleCount.toLocaleString() + ' triangles'} · say “explain this” for detail`);
  say(parts[indices[0]].name);
  return true;
}

// Switch the active model when the user names one out loud. Returns true if handled.
const MODEL_KEYWORDS = {
  'office-chair': ['office chair', 'the chair', 'chair', 'office'],
  bicycle: ['bicycle', 'bike', 'cycle'],
  bed: ['bed'],
};
function switchModelByVoice(text) {
  const t = text.toLowerCase();
  const hasVerb = /(load|switch|change|open|go to|select|bring up|give me|show me|display|put up)/.test(t);
  const short = t.split(/\s+/).length <= 3; // a bare "bicycle" is intent enough
  for (const [key, words] of Object.entries(MODEL_KEYWORDS)) {
    if (words.some((w) => t.includes(w))) {
      if (key === ui.model.value) { showCaption(`Already on the ${currentModel().label}.`); return true; }
      if (!hasVerb && !short) return false; // "the chair squeaks" shouldn't switch models
      ui.model.value = key;
      ui.model.dispatchEvent(new Event('change'));
      showCaption(`Loading the ${MODELS[key].label}…`);
      say(`Here is the ${MODELS[key].label}.`);
      return true;
    }
  }
  return false;
}

// Diagnose mode: match a spoken symptom to one of the authored symptom chips.
function pickSymptomByVoice(text) {
  if (currentMode !== 'diagnose' || !diagnoses.length) return false;
  const t = text.toLowerCase();
  for (let i = 0; i < diagnoses.length; i++) {
    if (diagnoses[i].symptoms.some((s) => t.includes(s.toLowerCase()))) { showDiagnosis(i); return true; }
  }
  return false;
}

// Quiz mode: did the spoken phrase contain the answer? Reveal + react.
function answerQuizByVoice(text) {
  if (currentMode !== 'quiz' || !quizItems.length || quizRevealed) return false;
  const q = quizItems[quizIndex];
  const key = String(q.answer).toLowerCase().replace(/^the\s+/, '').split(/[\s(]+/)[0];
  if (key.length >= 3 && text.toLowerCase().includes(key)) {
    revealQuiz();
    say(`Correct — it's ${q.answer}.`);
    return true;
  }
  return false;
}

const HELP_LINE = 'Try: “next”, “back”, “repeat”, “explode”, “put it together”, “fix it”, “quiz me”, “diagnose”, “show me the seat”, “load the bicycle”, “start AR”, or ask any question.';

// Execute a parsed (model-independent) voice command.
async function runCommand(cmd) {
  if (cmd.mode) { enterMode(cmd.mode); return; }
  switch (cmd.action) {
    case 'next':
      if (currentMode === 'fix' || currentMode === 'assemble') goStep(1);
      else if (currentMode === 'quiz') nextQuiz();
      break;
    case 'back':
      if (currentMode === 'fix' || currentMode === 'assemble') goStep(-1);
      break;
    case 'repeat': say(lastSpoken); break;
    case 'reset': enterMode(currentMode); break;
    case 'explode':
      ui.explode.value = cmd.amount ? (parseFloat(ui.explode.max) * cmd.amount).toFixed(3) : ui.explode.max;
      onExplodeChange();
      break;
    case 'collapse': ui.explode.value = 0; onExplodeChange(); break;
    case 'recenter': recenterView(); break;
    case 'reveal': if (currentMode === 'quiz') revealQuiz(); break;
    case 'wireframe': setToggle(ui.wireframe, cmd.value); break;
    case 'tint': setToggle(ui.tint, cmd.value); break;
    case 'autorotate': setToggle(ui.autorotate, cmd.value); break;
    case 'startAR': await startARFlow(); break;
    case 'exitAR': await endAR(); break;
    case 'move': moveARFlow(); break;
    case 'stopSpeaking': stopSpeaking(); break;
    case 'stopListening': recognizer?.stop(); showCaption('Mic off. Tap 🎤 to talk again.'); break;
    case 'help': showCaption(HELP_LINE); say('You can say next, back, explode, fix it, quiz me, diagnose, show me a part, load a different model, or ask me any question.'); break;
    case 'explain': await explainFocused(); break;
    default: break;
  }
}

async function handleSpeech(text) {
  const cmd = classifyCommand(text);
  if (cmd.type === 'command') {
    showCaption(`“${text}”`);
    track('voice-command', { input: text, metadata: { action: cmd.action || null, mode: cmd.mode || null } });
    await runCommand(cmd);
    return;
  }

  // Not a global command — try the data-driven intents that need the live
  // model/part/symptom lists, in order of specificity, before falling back to AI.
  if (pickSymptomByVoice(text)) { showCaption(`“${text}”`); track('voice-intent', { input: text, metadata: { kind: 'symptom' } }); return; }
  if (answerQuizByVoice(text)) { showCaption(`“${text}”`); track('voice-intent', { input: text, metadata: { kind: 'quiz-answer' } }); return; }
  if (switchModelByVoice(text)) { track('voice-intent', { input: text, metadata: { kind: 'model-switch' } }); return; }

  // Explore is the dedicated "ask about a part" mode — select vs. ask is decided
  // there, and answers are pinned to the selected part.
  if (currentMode === 'explore') { await handleExploreSpeech(text); return; }

  // Other modes: an explicit "show me X" navigation phrase can still highlight a
  // part; anything else is a general question about the whole object.
  const wantsPart = /(show|highlight|select|isolate|where|find|point to|light up|take me to|look at|focus on|which is)/.test(text.toLowerCase());
  if (wantsPart && selectPartByName(text)) { showCaption(`“${text}”`); track('voice-intent', { input: text, metadata: { kind: 'part-select', part: focusedPart } }); return; }

  showCaption(`“${text}” · …thinking`);
  const ans = await answerQuestion(getContext(), cmd.text);
  showCaption(ans);
  say(ans);
}

const recognizer = createRecognizer({
  lang: 'en-US',
  onResult: handleSpeech,
  onStateChange: (listening) => {
    ui.micBtn.classList.toggle('listening', listening);
    ui.micBtn.textContent = listening ? '🎤 Listening…' : '🎤 Ask';
  },
});
if (!recognizer) { ui.micBtn.disabled = true; ui.micBtn.title = 'Voice input needs Chrome'; }
ui.micBtn.addEventListener('click', () => {
  if (!recognizer) return;
  stopSpeaking();
  if (recognizer.isListening()) {
    recognizer.stop();
  } else {
    recognizer.start();
    showCaption(HELP_LINE); // once listening, everything below is voice-drivable
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
  try {
    document.body.classList.add('ar-active');
    track('ar-start', { metadata: { model: ui.model.value } });
    await startAR({
      renderer, scene, camera, group: explodedGroup, controls,
      overlay: document.body,
      onPlaced: () => {
        track('ar-placed', { metadata: { model: ui.model.value } });
        showCaption('Placed! Long-press to grab it, then drag to move · pinch to zoom · twist to rotate.');
        say('Placed. Press and hold the object to grab it, then drag to move it, or pinch to resize.');
      },
      onSelectedChange: (sel) => {
        track(sel ? 'ar-select' : 'ar-deselect');
        showCaption(sel
          ? 'Grabbed — drag to move · pinch to zoom · twist to rotate · tap to release.'
          : 'Released. Long-press the object again to move or resize it.');
      },
      onEnd: () => { document.body.classList.remove('ar-active'); track('ar-exit'); },
    });
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
renderer.setAnimationLoop((time, frame) => {
  if (frame) updateAR(frame);
  if (!renderer.xr.isPresenting) {
    resize();
    controls.autoRotate = ui.autorotate.checked;
    controls.autoRotateSpeed = 1.2;
  }
  controls.update();
  renderer.render(scene, camera);
});

// ---- Go --------------------------------------------------------------------

loadModel('office-chair');
