import * as THREE from 'three';

/**
 * Markerless WebXR AR (Android Chrome). Same approach as the reference Web-AR
 * project: immersive-ar + hit-test for floor placement, HTML kept as a
 * dom-overlay so the mode bar / cards / mic button render over the camera feed.
 *
 * Flow: start session → a reticle tracks real surfaces → tap to place the
 * exploded model there (reparented into an anchor and scaled to ~0.7 m) → all
 * modes run in AR. Tap the reticle again (before placing) re-aims.
 */

let session = null;
let reticle = null;
let anchor = null;
let hitTestSource = null;
let localSpace = null;
let viewerSpace = null;
let placed = false;

// Saved desktop state, restored on exit.
let saved = null;
let refs = null;

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

  // Save desktop state.
  saved = {
    background: scene.background,
    controlsEnabled: controls ? controls.enabled : false,
    groupParent: group.parent,
    groupPos: group.position.clone(),
    groupScale: group.scale.clone(),
    groupQuat: group.quaternion.clone(),
    cameraPos: camera.position.clone(),
  };

  scene.background = null; // transparent → camera passthrough shows through
  if (controls) controls.enabled = false;

  renderer.xr.enabled = true;
  await renderer.xr.setSession(session);

  localSpace = await session.requestReferenceSpace('local');
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  // Reticle that snaps to detected surfaces.
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4ecdc4 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Anchor holds the model; placed at the reticle on tap.
  anchor = new THREE.Group();
  anchor.matrixAutoUpdate = false;
  scene.add(anchor);

  // Reparent the model into the anchor and normalise it to ~0.7 m tall,
  // base on the floor, centred horizontally.
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = 0.7 / (size.y || 1);
  anchor.add(group);
  group.scale.setScalar(s);
  group.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  group.quaternion.identity();
  group.visible = false; // hidden until placed

  placed = false;
  session.addEventListener('select', onSelect);
  session.addEventListener('end', onSessionEnd);
}

function onSelect() {
  if (placed || !reticle || !reticle.visible) return;
  anchor.matrix.copy(reticle.matrix);
  refs.group.visible = true;
  placed = true;
  reticle.visible = false;
  refs.onPlaced?.();
}

/** Call every animation frame with the XRFrame (three.js passes it to the loop). */
export function updateAR(frame) {
  if (!frame || !hitTestSource || placed) return;
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

export async function endAR() {
  if (session) await session.end();
}

function onSessionEnd() {
  const { renderer, scene, camera, group, controls } = refs;

  // Restore the model to the desktop scene.
  if (saved.groupParent) saved.groupParent.add(group);
  group.position.copy(saved.groupPos);
  group.scale.copy(saved.groupScale);
  group.quaternion.copy(saved.groupQuat);
  group.visible = true;

  if (reticle) { scene.remove(reticle); reticle.geometry.dispose(); reticle.material.dispose(); reticle = null; }
  if (anchor) { scene.remove(anchor); anchor = null; }

  scene.background = saved.background;
  if (controls) controls.enabled = saved.controlsEnabled;
  camera.position.copy(saved.cameraPos);

  renderer.xr.enabled = false;
  hitTestSource = null;
  session = null;
  placed = false;

  refs.onEnd?.();
  refs = null;
}
