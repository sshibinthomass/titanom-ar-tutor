import * as THREE from 'three';

/**
 * Markerless WebXR AR (Android Chrome). Same approach as the reference Web-AR
 * project, ported to plain JS: immersive-ar + hit-test for floor placement,
 * HTML kept as a dom-overlay so the mode bar / cards / mic button render over
 * the camera feed.
 *
 * What makes the placed object *stable* (three things the naive version lacks):
 *
 *   1. Real WebXR **anchors**. On placement we ask the runtime for an
 *      `XRAnchor` at the floor pose and then re-read that anchor's pose *every
 *      frame*. The AR system continuously refines anchor poses as it learns the
 *      environment, so the model stays locked to the real world instead of
 *      sliding/floating when tracking drifts. (Copying the hit-test matrix once
 *      and never updating it — the old behaviour — is exactly what caused the
 *      instability.) If the device doesn't support anchors we fall back to the
 *      one-shot frozen matrix, which is still improved by (2) and (3).
 *
 *   2. A **PoseStabilizer** on the reticle: exponential-damped smoothing plus a
 *      "must be still for N frames" gate and a big-jump reject. You can't place
 *      until the surface estimate has actually converged, so you never anchor to
 *      a garbage first-frame pose.
 *
 *   3. **One** reference space for everything. Hit-test poses, anchor poses and
 *      three.js rendering all use `renderer.xr.getReferenceSpace()`, so they
 *      can't disagree about where the floor is.
 *
 * Flow: start session → a reticle tracks real surfaces (only shown once stable)
 * → tap to place the exploded model → then manipulate it:
 *   • long-press       → "grab" the object (a turquoise floor ring appears);
 *                        keep dragging the same finger to slide it. Manipulation
 *                        only acts on a *selected* object, so a stray touch
 *                        never nudges it. A tap deselects.
 *   • one-finger drag  → move it across the floor (when selected)
 *   • two-finger pinch → scale, and twist to rotate (when selected)
 *   • voice "move it"  → re-enter placement; tap a new spot to re-place it on a
 *                        fresh anchor (hands-free reposition to another surface)
 *
 * An **interactor** (the Assemble puzzle) can claim the finger instead: on
 * `selectstart` we hand it the XR input source's target ray, and if it grabs
 * something the whole-model gesture path stands down for that touch. While a
 * puzzle is running, `setManipulationEnabled(false)` retires the one-finger
 * model-move entirely, so dragging a piece can never slide the board out from
 * under it — voice "move it" remains the way to reposition.
 *
 * Scene graph once placed:
 *   anchor (matrix driven by the live XRAnchor pose, on the floor)
 *     └─ pivot (user rotation + scale, about the floor contact point)
 *          └─ group (the exploded model, fit to ~0.7 m, base at y=0)
 *
 * User yaw/scale live on `pivot`, never baked into the anchor, so anchor-pose
 * refinement each frame never fights the user's manipulation.
 */

let session = null;
let reticle = null;
let reticleShown = false;      // last state reported to onReticle (edge-triggered)
let anchor = null;
let pivot = null;
let hitTestSource = null;
let viewerSpace = null;
let placed = false;
let moveMode = false;

// WebXR anchor state.
let xrAnchor = null;          // the live XRAnchor, or null (unsupported / not yet placed)
let anchorsSupported = false;
let pendingAnchorMatrix = null; // world-space Matrix4 to spawn an anchor at, consumed on the next active frame
let anchorGen = 0;              // bumped on every (re)placement so stale async anchors are discarded

let lastTime = 0;              // for the stabilizer's dt

let saved = null;
let refs = null;

// Gesture state.
let gesture = null;
let overlayEl = null;

// Selection: the placed object must be long-pressed to "select" it before any
// rotate/zoom takes effect, so a stray touch never nudges it. A tap deselects.
let selected = false;
let selectionRing = null;
let pressTimer = null;      // fires selection after a still long-press
let pressStart = null;      // { x, y, t } of the active one-finger press
let pressMovedFar = false;  // the press turned into a drag → not a long-press/tap
let longPressFired = false; // this press was consumed to select → don't also rotate/deselect

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 12;  // finger travel that turns a press into a drag
const TAP_MAX_MS = 250;

// Interactor: an optional consumer of the finger's target ray (the Assemble
// puzzle). See setInteractor / onSelectStart.
let interactor = null;
let carrying = false;
let activeInputSource = null;
let manipulationEnabled = true;

export async function isARSupported() {
  if (!('xr' in navigator)) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

// ---- Pose stabilizer -------------------------------------------------------
// Ported from the reference PoseStabilizer. Smooths the raw hit-test pose and
// only reports "stable" once it's been still for a run of frames, so placement
// waits for the surface estimate to converge.

const MIN_STABLE_FRAMES = 8;
const POSITION_TOLERANCE_METERS = 0.025;
const MAX_JUMP_METERS = 0.35;
const DAMPING_LAMBDA = 18;

function makeStabilizer() {
  return {
    isStable: false,
    stableFrames: 0,
    lastRaw: null,
    smoothedPos: null,
    smoothedQuat: null,
  };
}
let stabilizer = makeStabilizer();

function resetStabilizer() {
  stabilizer.isStable = false;
  stabilizer.stableFrames = 0;
  stabilizer.lastRaw = null;
  stabilizer.smoothedPos = null;
  stabilizer.smoothedQuat = null;
}

function stabilizerStart(pos, quat) {
  stabilizer.isStable = false;
  stabilizer.stableFrames = 1;
  stabilizer.lastRaw = pos.clone();
  stabilizer.smoothedPos = pos.clone();
  stabilizer.smoothedQuat = quat.clone();
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

// Scratch vectors for drag-to-move (reused so a drag doesn't churn GC).
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _quat = new THREE.Quaternion();

const MOVE_METERS_PER_PX = 0.0022; // drag sensitivity for sliding on the floor

/** Feed a raw hit-test matrix; returns a smoothed Matrix4 once stable, else null. */
function stabilizerUpdate(rawMatrix, dt) {
  rawMatrix.decompose(_p, _q, _s);

  if (!stabilizer.lastRaw) {
    stabilizerStart(_p, _q);
    return null;
  }

  const movement = _p.distanceTo(stabilizer.lastRaw);
  if (movement > MAX_JUMP_METERS) {
    // Teleport-sized jump: the tracker relocalised. Restart the sequence.
    stabilizerStart(_p, _q);
    return null;
  }

  stabilizer.stableFrames = movement <= POSITION_TOLERANCE_METERS ? stabilizer.stableFrames + 1 : 1;
  stabilizer.isStable = stabilizer.stableFrames >= MIN_STABLE_FRAMES;
  stabilizer.lastRaw.copy(_p);

  const alpha = 1 - Math.exp(-DAMPING_LAMBDA * Math.max(0, dt));
  stabilizer.smoothedPos.lerp(_p, alpha);
  stabilizer.smoothedQuat.slerp(_q, alpha);

  if (!stabilizer.isStable) return null;

  return new THREE.Matrix4().compose(
    stabilizer.smoothedPos,
    stabilizer.smoothedQuat,
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * Start an AR session.
 * opts: { renderer, scene, camera, group, controls, overlay, onEnd, onPlaced,
 *         onReticle, fitBox }
 *
 * `fitBox` (optional) is the box to size the placement against, instead of the
 * group's live bounds — see the fit below for why that matters.
 */
export async function startAR(opts) {
  refs = opts;
  const { renderer, scene, camera, group, controls, overlay, fitBox } = opts;

  session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    // 'anchors' is what buys us world-locked stability; the others degrade
    // gracefully if the device doesn't offer them.
    optionalFeatures: ['dom-overlay', 'anchors', 'local-floor', 'light-estimation'],
    domOverlay: overlay ? { root: overlay } : undefined,
  });

  anchorsSupported = !!(session.enabledFeatures
    ? session.enabledFeatures.includes('anchors')
    : true); // older UAs don't expose enabledFeatures — assume yes and feature-detect per-frame

  saved = {
    background: scene.background,
    controlsEnabled: controls ? controls.enabled : false,
    groupParent: group.parent,
    groupPos: group.position.clone(),
    groupScale: group.scale.clone(),
    groupQuat: group.quaternion.clone(),
    cameraPos: camera.position.clone(),
  };

  scene.background = null; // camera passthrough
  if (controls) controls.enabled = false;

  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);

  // Hit-test rays are cast from the viewer; the resulting poses (and anchor
  // poses, and rendering) are all read in renderer.xr.getReferenceSpace() so
  // nothing disagrees about the world origin.
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4ecdc4 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // anchor (world pose) → pivot (user transform) → group (model).
  anchor = new THREE.Group();
  anchor.matrixAutoUpdate = false;
  scene.add(anchor);
  pivot = new THREE.Group();
  anchor.add(pivot);

  // A turquoise ring on the floor under the object that shows it's selected.
  // Under `pivot`, so it rotates/scales with the object — a clear affordance.
  selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.345, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4ecdc4, transparent: true, opacity: 0.85, depthTest: false })
  );
  selectionRing.position.y = 0.001;
  selectionRing.renderOrder = 999;
  selectionRing.visible = false;
  pivot.add(selectionRing);

  // Fit to ~0.7 m. Measure the *assembled* model when the caller can supply it:
  // the live bounds grow with the explode amount, so entering AR from a mode
  // that spreads the parts (Fix) would otherwise scale the
  // object down to fit its exploded silhouette — and reassembling mid-session
  // would then leave a chair well under 0.7 m standing on the floor.
  const box = fitBox || new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = 0.7 / (size.y || 1);
  pivot.add(group);
  group.scale.setScalar(s);
  group.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  group.quaternion.identity();
  group.visible = false;

  placed = false;
  moveMode = false;
  gesture = null;
  xrAnchor = null;
  pendingAnchorMatrix = null;
  anchorGen = 0;
  lastTime = 0;
  carrying = false;
  activeInputSource = null;
  resetStabilizer();

  session.addEventListener('select', onSelect);
  session.addEventListener('selectstart', onSelectStart);
  session.addEventListener('selectend', onSelectEnd);
  session.addEventListener('end', onSessionEnd);

  // Gesture handlers on the dom-overlay (touch), for rotate + scale.
  overlayEl = overlay || renderer.domElement;
  overlayEl.addEventListener('touchstart', onTouchStart, { passive: false });
  overlayEl.addEventListener('touchmove', onTouchMove, { passive: false });
  overlayEl.addEventListener('touchend', onTouchEnd, { passive: false });
}

/**
 * Show/hide the placement ring, telling the caller when it changes.
 *
 * The ring being visible *is* the "you may tap now" signal — it only appears
 * once the surface estimate has converged (see the stabilizer) — so the UI
 * guidance rides on exactly the same condition `place()` checks, rather than a
 * second guess that could disagree with the ring the user is looking at.
 */
function setReticleVisible(v) {
  if (reticle) reticle.visible = v;
  if (v !== reticleShown) {
    reticleShown = v;
    refs?.onReticle?.(v);
  }
}

/** Commit the current stable reticle pose as the model's floor anchor. */
function placeAtReticle(stableMatrix) {
  // Show it immediately at the stable pose so there's no gap while the async
  // anchor request resolves…
  anchor.matrix.copy(stableMatrix);
  anchor.matrixWorldNeedsUpdate = true;
  // …then hand the same pose to the runtime to become a tracked anchor.
  anchorGen += 1;
  if (xrAnchor) { try { xrAnchor.delete(); } catch {} xrAnchor = null; }
  pendingAnchorMatrix = stableMatrix.clone();

  refs.group.visible = true;
  placed = true;
  moveMode = false;
  setReticleVisible(false);
  resetStabilizer();
  setSelected(false); // start unselected — a long-press is needed to manipulate
  refs.onPlaced?.();
}

/** Toggle the "selected" state and its visual ring, and notify the app. */
function setSelected(sel) {
  selected = sel;
  if (selectionRing) selectionRing.visible = sel;
  refs?.onSelectedChange?.(sel);
}

function onSelect() {
  // Only place off a *stable* reticle — never a jittery first estimate.
  if (!reticle || !reticle.visible || !stabilizer.isStable) return;
  if (!placed || moveMode) {
    placeAtReticle(reticle.matrix.clone());
  }
}

/** Re-enter placement: the next floor tap moves the model. */
export function requestMove() {
  if (placed) {
    moveMode = true;
    resetStabilizer();
    setSelected(false); // re-placing; drop the current selection
  }
}

// ---- Interactor (drag a part, not the model) -------------------------------

/**
 * Register something that wants the finger's 3D ray — the Assemble puzzle.
 * Contract: `active()`, `grab(ray) → bool`, `move(ray)`, `release()`. The ray is
 * `{ origin, direction }` in world space, using scratch vectors that are valid
 * only for the duration of the call.
 */
export function setInteractor(next) {
  if (carrying && interactor && next !== interactor) { interactor.release(); carrying = false; }
  interactor = next;
}

/**
 * Turn the whole-model gestures (long-press grab, one-finger slide, pinch) on or
 * off. The puzzle switches them off so a mis-aimed drag can't move the board it
 * is being assembled on — the biggest source of "it moved on me" in AR.
 */
export function setManipulationEnabled(on) {
  manipulationEnabled = !!on;
  if (!on) {
    cancelPressTimer();
    gesture = null;
    if (selected) setSelected(false); // only fire the callback on a real change
  }
}

/** Override the user transform's scale — used to show the model life-size. */
export function setPivotScale(mult) {
  if (pivot && Number.isFinite(mult) && mult > 0) pivot.scale.setScalar(Math.max(0.05, Math.min(20, mult)));
}

/** The model group's fit scale, so callers can compute a real-world size. */
export function getFitScale() {
  return refs && refs.group ? refs.group.scale.x : 1;
}

const _rayPos = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _rayQuat = new THREE.Quaternion();
const _ray = { origin: _rayPos, direction: _rayDir };

/**
 * The finger as a 3D ray. On a handheld device the input source's
 * `targetRayMode` is 'screen': the runtime casts the ray from the viewer through
 * the touch point, which is exactly what we want and is far more accurate than
 * reconstructing NDC against the XR ArrayCamera. Read in the same reference
 * space as the anchor and the renderer, so nothing disagrees about the world.
 */
function rayFromInput(frame, inputSource) {
  if (!frame || !inputSource || !inputSource.targetRaySpace || !refs) return null;
  const refSpace = refs.renderer.xr.getReferenceSpace();
  if (!refSpace) return null;
  const pose = frame.getPose(inputSource.targetRaySpace, refSpace);
  if (!pose) return null;
  const { position: p, orientation: o } = pose.transform;
  _rayPos.set(p.x, p.y, p.z);
  _rayQuat.set(o.x, o.y, o.z, o.w);
  _rayDir.set(0, 0, -1).applyQuaternion(_rayQuat);
  return _ray;
}

// XRInputSourceEvent carries the frame it fired on, so the ray is available at
// the very start of the touch — no waiting a frame to find out what was grabbed.
function onSelectStart(e) {
  if (!placed || moveMode || !interactor || !interactor.active()) return;
  const ray = rayFromInput(e.frame, e.inputSource);
  if (!ray || !interactor.grab(ray)) return;
  carrying = true;
  activeInputSource = e.inputSource;
  cancelPressTimer();  // this touch belongs to the part, not to the model
  gesture = null;
}

function onSelectEnd() {
  if (!carrying) return;
  carrying = false;
  activeInputSource = null;
  gesture = null;
  interactor?.release();
}

/** Call every animation frame with the XRFrame. */
export function updateAR(frame) {
  if (!frame || !refs) return;
  const refSpace = refs.renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  const now = frame.predictedDisplayTime ?? performance.now();
  const dt = lastTime ? Math.min(0.1, Math.max(0, (now - lastTime) / 1000)) : 0;
  lastTime = now;

  // 1) Spawn a pending anchor now that we have an active frame + ref space.
  if (pendingAnchorMatrix && anchorsSupported && typeof frame.createAnchor === 'function') {
    const gen = anchorGen;
    const m = pendingAnchorMatrix;
    pendingAnchorMatrix = null;
    m.decompose(_p, _q, _s);
    const xform = new XRRigidTransform(
      { x: _p.x, y: _p.y, z: _p.z, w: 1 },
      { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
    );
    Promise.resolve(frame.createAnchor(xform, refSpace)).then((a) => {
      // Discard if a newer placement happened while we were awaiting.
      if (gen !== anchorGen || !a) { try { a && a.delete(); } catch {} return; }
      xrAnchor = a;
    }).catch(() => { /* anchors unavailable — keep the frozen matrix */ });
  }

  // 2) Drive the placed model from the live anchor pose (this is the stability
  //    win: the runtime keeps refining this pose, we follow it every frame).
  if (xrAnchor) {
    const pose = frame.getPose(xrAnchor.anchorSpace, refSpace);
    if (pose) {
      anchor.matrix.fromArray(pose.transform.matrix);
      anchor.matrixWorldNeedsUpdate = true;
    }
  }

  // 2b) A carried part follows the finger's live target ray. It is a child of
  //     the model group, so the anchor refinement above moves it too — the piece
  //     stays in the user's hand relative to the object, never fighting it.
  if (carrying && interactor && activeInputSource) {
    const ray = rayFromInput(frame, activeInputSource);
    if (ray) interactor.move(ray);
  }

  // 3) Reticle / hit-test only while we still need to place (or re-place).
  if (placed && !moveMode) {
    setReticleVisible(false);
    return;
  }
  if (!hitTestSource) return;

  const results = frame.getHitTestResults(hitTestSource);
  if (results.length) {
    const pose = results[0].getPose(refSpace);
    if (pose) {
      const raw = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const stable = stabilizerUpdate(raw, dt);
      if (stable) {
        setReticleVisible(true);
        reticle.matrix.copy(stable);
        reticle.matrixWorldNeedsUpdate = true;
      } else {
        // Converging: hide the ring until the pose settles so the user isn't
        // invited to tap on a wobbling target.
        setReticleVisible(false);
      }
      return;
    }
  }
  setReticleVisible(false);
  resetStabilizer();
}

export function isPlaced() {
  return placed;
}

// ---- Gestures --------------------------------------------------------------

function isUI(target) {
  return target.closest && target.closest('button, .card, .modebar, .fab-cluster, .voice-caption, .panel, select, input');
}
function touchDist(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}
function touchAngle(t) {
  return Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
}

function cancelPressTimer() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
}

/** Begin sliding the object under the current one-finger press. */
function startMoveGesture(clientX, clientY) {
  gesture = { mode: 'move', startX: clientX, startY: clientY, startPos: pivot.position.clone(), moved: false };
}

/**
 * Slide the object across the floor, camera-relative: horizontal drag moves it
 * left/right, vertical drag pushes it away / pulls it closer. The delta is
 * built in world space from the camera's (flattened) right/forward axes, then
 * rotated into the anchor's local frame — the anchor is gravity-aligned, so the
 * object stays on the floor and only its footprint position changes.
 */
function applyMove(clientX, clientY) {
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;

  const cam = refs.renderer.xr.getCamera();
  _right.setFromMatrixColumn(cam.matrixWorld, 0); _right.y = 0; _right.normalize();
  cam.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();

  _delta.set(0, 0, 0)
    .addScaledVector(_right, dx * MOVE_METERS_PER_PX)
    .addScaledVector(_fwd, -dy * MOVE_METERS_PER_PX); // drag up → push away

  anchor.getWorldQuaternion(_quat).invert();
  _delta.applyQuaternion(_quat); // world → anchor-local (yaw only, stays horizontal)

  pivot.position.copy(gesture.startPos).add(_delta);
}

function onTouchStart(e) {
  if (!placed || moveMode) return;
  if (isUI(e.target)) return;
  // A part is in hand, or the puzzle owns the finger — don't also move the model.
  if (carrying || !manipulationEnabled) return;

  if (e.touches.length === 1) {
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY, t: performance.now() };
    pressMovedFar = false;
    longPressFired = false;
    cancelPressTimer();
    if (selected) {
      // Already selected → this drag slides the object right away.
      startMoveGesture(t.clientX, t.clientY);
    } else {
      // Not selected yet → hold still to "grab" it, then keep dragging to move.
      gesture = null;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (pressMovedFar) return;
        longPressFired = true;
        setSelected(true);
        startMoveGesture(pressStart.x, pressStart.y);
      }, LONG_PRESS_MS);
    }
  } else if (e.touches.length === 2) {
    cancelPressTimer();
    // Pinch to scale + twist to rotate — also requires a prior selection.
    gesture = selected ? {
      mode: 'pinch',
      startDist: touchDist(e.touches),
      startAngle: touchAngle(e.touches),
      startScale: pivot.scale.x,
      startRotY: pivot.rotation.y,
    } : null;
  }
}

function onTouchMove(e) {
  if (!placed || moveMode) return;
  // Dragging a part: swallow the move so the dom-overlay doesn't scroll under it.
  if (carrying) { e.preventDefault(); return; }

  if (e.touches.length === 1 && pressStart) {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > MOVE_CANCEL_PX) {
      pressMovedFar = true;      // it's a drag, not a long-press / tap
      cancelPressTimer();
    }
  }

  if (!gesture) return;
  if (gesture.mode === 'move' && e.touches.length === 1) {
    applyMove(e.touches[0].clientX, e.touches[0].clientY);
    if (pressMovedFar) gesture.moved = true;
    e.preventDefault();
  } else if (gesture.mode === 'pinch' && e.touches.length === 2) {
    const scale = gesture.startScale * (touchDist(e.touches) / gesture.startDist);
    pivot.scale.setScalar(Math.max(0.2, Math.min(5, scale)));
    pivot.rotation.y = gesture.startRotY + (touchAngle(e.touches) - gesture.startAngle);
    e.preventDefault();
  }
}

function onTouchEnd(e) {
  if (e.touches.length > 0) return; // wait until all fingers are up
  cancelPressTimer();

  // A quick, still, single-finger tap (that neither selected nor moved the
  // object) deselects — the way to "let go".
  const wasTap = pressStart && !pressMovedFar && !longPressFired
    && (performance.now() - pressStart.t) < LONG_PRESS_MS
    && !(gesture && gesture.moved);
  if (wasTap && selected) setSelected(false);

  gesture = null;
  pressStart = null;
  pressMovedFar = false;
  longPressFired = false;
}

// ---- Teardown --------------------------------------------------------------

export async function endAR() {
  if (session) await session.end();
}

function onSessionEnd() {
  const { renderer, scene, camera, group, controls } = refs;

  if (overlayEl) {
    overlayEl.removeEventListener('touchstart', onTouchStart);
    overlayEl.removeEventListener('touchmove', onTouchMove);
    overlayEl.removeEventListener('touchend', onTouchEnd);
    overlayEl = null;
  }

  cancelPressTimer();
  if (carrying) { try { interactor?.release(); } catch {} }
  carrying = false;
  activeInputSource = null;
  manipulationEnabled = true; // the next session starts with normal gestures
  selected = false;
  pressStart = null;
  gesture = null;
  if (selectionRing) { selectionRing.geometry.dispose(); selectionRing.material.dispose(); selectionRing = null; }

  if (xrAnchor) { try { xrAnchor.delete(); } catch {} xrAnchor = null; }
  pendingAnchorMatrix = null;

  // Restore the model to the desktop scene.
  if (saved.groupParent) saved.groupParent.add(group);
  group.position.copy(saved.groupPos);
  group.scale.copy(saved.groupScale);
  group.quaternion.copy(saved.groupQuat);
  group.visible = true;

  if (reticle) { scene.remove(reticle); reticle.geometry.dispose(); reticle.material.dispose(); reticle = null; }
  if (anchor) { scene.remove(anchor); anchor = null; }
  pivot = null;

  scene.background = saved.background;
  if (controls) controls.enabled = saved.controlsEnabled;
  camera.position.copy(saved.cameraPos);

  renderer.xr.enabled = false;
  if (hitTestSource) { try { hitTestSource.cancel(); } catch {} hitTestSource = null; }
  viewerSpace = null;
  session = null;
  placed = false;
  moveMode = false;
  reticleShown = false;
  resetStabilizer();

  refs.onEnd?.();
  refs = null;
}
