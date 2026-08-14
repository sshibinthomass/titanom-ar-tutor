import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildExplodedView, setExplode, isolateParts, clearPartStates, setHighlight } from './explode.js';
import { attachPicker } from './select.js';
import { MODE_LIST, resolveFix, resolveAssemble, resolveDiagnose, resolveQuiz, applyNames } from './modes.js';
import { isARSupported, startAR, updateAR, endAR, requestMove } from './ar.js';
import { speak, stop as stopSpeaking } from './tts.js';
import { createRecognizer, speechRecognitionAvailable } from './voice.js';
import { classifyCommand, answerQuestion } from './tutor.js';

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
scene.background = new THREE.Color(0x14161c);

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
  moveBtn: document.getElementById('moveBtn'),
  voiceCaption: document.getElementById('voiceCaption'),
  panelToggle: document.getElementById('panelToggle'),
  panel: document.querySelector('.panel'),
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

ui.model.addEventListener('change', () => loadModel(ui.model.value));
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
  showCard('Explore', 'Tap any part to isolate it and read its name.', `${parts.length} parts`);
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
function showDiagnosis(i) {
  const d = diagnoses[i];
  isolateParts(parts, d.indices);
  const chips = diagnoses.map((dd, j) => ({ label: dd.symptoms[0], onClick: () => showDiagnosis(j) }));
  const partName = d.indices.length ? parts[d.indices[0]].name : '';
  focusedPart = partName || focusedPart;
  showCard('Diagnose', d.text, partName ? `Likely part: ${partName}` : '', { chips });
  say(d.text);
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
      focusedPart = parts[index].name;
      showCard('Explore', `<b>${parts[index].name}</b>`, `${parts[index].triangleCount.toLocaleString()} triangles · tap empty space to clear`);
      say(parts[index].name);
    } else {
      focusedPart = null;
      showCard('Explore', 'Tap any part to isolate it and read its name.', `${parts.length} parts`);
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
  const ans = await answerQuestion(getContext(), q);
  showCaption(ans);
  say(ans);
}

// Execute a parsed voice command.
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
    case 'explode': ui.explode.value = ui.explode.max; onExplodeChange(); break;
    case 'explain': await explainFocused(); break;
    default: break;
  }
}

async function handleSpeech(text) {
  const cmd = classifyCommand(text);
  if (cmd.type === 'command') { showCaption(`“${text}”`); await runCommand(cmd); return; }
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
  if (recognizer.isListening()) recognizer.stop(); else recognizer.start();
});

// AR availability + start/exit.
(async () => {
  if (!(await isARSupported())) {
    ui.startAR.textContent = '📱 AR needs Android';
    ui.startAR.disabled = true;
    ui.startAR.title = 'WebXR AR runs on Android Chrome. The 3D view works everywhere.';
  }
})();

ui.startAR.addEventListener('click', async () => {
  try {
    document.body.classList.add('ar-active');
    await startAR({
      renderer, scene, camera, group: explodedGroup, controls,
      overlay: document.body,
      onPlaced: () => {
        ui.moveBtn.classList.remove('active');
        showCaption('Placed! Drag to rotate · pinch to scale · ✋ Move to reposition.');
        say('Placed. Drag with one finger to rotate, or pinch to resize.');
      },
      onEnd: () => { document.body.classList.remove('ar-active'); ui.moveBtn.classList.remove('active'); },
    });
    showCaption('Point at the floor, then tap to place the chair.');
  } catch (e) {
    console.error('AR failed', e);
    document.body.classList.remove('ar-active');
    showCaption('Could not start AR: ' + e.message);
  }
});
ui.exitAR.addEventListener('click', () => endAR());
ui.moveBtn.addEventListener('click', () => {
  requestMove();
  ui.moveBtn.classList.add('active');
  showCaption('Tap the floor where you want the chair.');
});

// Mobile: gear toggles the dev panel.
ui.panelToggle.addEventListener('click', () => ui.panel.classList.toggle('open'));

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
