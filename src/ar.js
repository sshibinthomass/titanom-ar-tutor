import * as THREE from 'three';

/**
 * Markerless WebXR AR (Android Chrome). Same approach as the reference Web-AR
 * project: immersive-ar + hit-test for floor placement, HTML kept as a
 * dom-overlay so the mode bar / cards / mic button render over the camera feed.
 *
 * Flow: start session → a reticle tracks real surfaces → tap to place the
 * exploded model → then manipulate it:
 *   • one-finger drag  → rotate around the vertical axis
 *   • two-finger pinch → scale
 *   • "Move" button    → tap a new spot to re-place it
 *
 * Scene graph once placed:
 *   anchor (matrix from the hit-test pose, on the floor)
 *     └─ pivot (user rotation + scale, about the floor contact point)
 *          └─ group (the exploded model, fit to ~0.7 m, base at y=0)
 */

let session = null;
let reticle = null;
let anchor = null;
let pivot = null;
let hitTestSource = null;
let localSpace = null;
let viewerSpace = null;
let placed = false;
let moveMode = false;

let saved = null;
let refs = null;

// Gesture state.
let gesture = null;
let overlayEl = null;

export async function isARSupported() {
  if (!('xr' in navigator)) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

/**
 * Start an AR session.
 * opts: { renderer, scene, camera, group, controls, overlay, onEnd, onPlaced }
 */
export async function startAR(opts) {
  refs = opts;
  const { renderer, scene, camera, group, controls, overlay } = opts;

  session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'local-floor'],
    domOverlay: overlay ? { root: overlay } : undefined,
  });

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

  localSpace = await session.requestReferenceSpace('local');
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4ecdc4 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // anchor (from hit-test) → pivot (user transform) → group (model).
  anchor = new THREE.Group();
  anchor.matrixAutoUpdate = false;
  scene.add(anchor);
  pivot = new THREE.Group();
  anchor.add(pivot);

  const box = new THREE.Box3().setFromObject(group);
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

  session.addEventListener('select', onSelect);
  session.addEventListener('end', onSessionEnd);

  // Gesture handlers on the dom-overlay (touch), for rotate + scale.
  overlayEl = overlay || renderer.domElement;
  overlayEl.addEventListener('touchstart', onTouchStart, { passive: false });
  overlayEl.addEventListener('touchmove', onTouchMove, { passive: false });
  overlayEl.addEventListener('touchend', onTouchEnd, { passive: false });
}

function placeAtReticle() {
  anchor.matrix.copy(reticle.matrix);
  refs.group.visible = true;
  placed = true;
  moveMode = false;
  reticle.visible = false;
  refs.onPlaced?.();
}

function onSelect() {
  if (!reticle || !reticle.visible) return;
  if (!placed || moveMode) placeAtReticle();
}

/** Re-enter placement: the next floor tap moves the model. */
export function requestMove() {
  if (placed) moveMode = true;
}

/** Call every animation frame with the XRFrame. */
export function updateAR(frame) {
  if (!frame || !hitTestSource) return;
  if (placed && !moveMode) { if (reticle) reticle.visible = false; return; }
  const results = frame.getHitTestResults(hitTestSource);
  if (results.length) {
    const pose = results[0].getPose(localSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    }
  } else {
    reticle.visible = false;
  }
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

function onTouchStart(e) {
  if (!placed || moveMode) return;
  if (isUI(e.target)) return;
  if (e.touches.length === 1) {
    gesture = { mode: 'rotate', x: e.touches[0].clientX, startRotY: pivot.rotation.y };
  } else if (e.touches.length === 2) {
    gesture = {
      mode: 'pinch',
      startDist: touchDist(e.touches),
      startAngle: touchAngle(e.touches),
      startScale: pivot.scale.x,
      startRotY: pivot.rotation.y,
    };
  }
}

function onTouchMove(e) {
  if (!gesture || !placed) return;
  if (gesture.mode === 'rotate' && e.touches.length === 1) {
    const dx = e.touches[0].clientX - gesture.x;
    pivot.rotation.y = gesture.startRotY + dx * 0.01;
    e.preventDefault();
  } else if (gesture.mode === 'pinch' && e.touches.length === 2) {
    const scale = gesture.startScale * (touchDist(e.touches) / gesture.startDist);
    pivot.scale.setScalar(Math.max(0.2, Math.min(5, scale)));
    pivot.rotation.y = gesture.startRotY + (touchAngle(e.touches) - gesture.startAngle);
    e.preventDefault();
  }
}

function onTouchEnd(e) {
  if (e.touches.length === 0) gesture = null;
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
  hitTestSource = null;
  session = null;
  placed = false;
  moveMode = false;

  refs.onEnd?.();
  refs = null;
}
