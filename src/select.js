import * as THREE from 'three';

/**
 * Tap / click part picking via raycasting.
 *
 * attachPicker(renderer, camera, getParts, onPick):
 *   - getParts()  returns the current parts[] array (meshes live under them)
 *   - onPick(i)   called with the picked part index, or -1 on empty space
 * Uses pointerup with a small movement threshold so orbit-drags don't count
 * as taps. Works for both mouse and touch.
 */
export function attachPicker(renderer, camera, getParts, onPick) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0, downY = 0, moved = false;

  const el = renderer.domElement;

  el.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; moved = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) moved = true;
  });
  el.addEventListener('pointerup', (e) => {
    if (moved) return; // it was a drag (orbit), not a tap
    const rect = el.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    const parts = getParts();
    const meshes = parts.map((p) => p.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      const idx = hits[0].object.userData.partIndex;
      onPick(typeof idx === 'number' ? idx : -1);
    } else {
      onPick(-1);
    }
  });
}

/**
 * Mouse/touch drag for the Assemble puzzle — the desktop half of the input
 * contract in puzzle.js (ar.js is the other half). It builds a world-space ray
 * from the camera through the cursor and hands it to the interactor; all the
 * 3D reasoning stays in puzzle.js so both surfaces behave identically.
 *
 * The interactor decides whether a press actually grabbed anything; only then do
 * we suppress OrbitControls, so an empty-space drag still orbits the scene. AR
 * has its own ray source, so this bails out during a session.
 */
export function attachDragger(renderer, camera, controls, interactor) {
  const el = renderer.domElement;
  const ndc = new THREE.Vector2();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const ray = { origin, direction };
  let dragging = false;

  function rayAt(e) {
    const rect = el.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    origin.setFromMatrixPosition(camera.matrixWorld);
    direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(origin).normalize();
    return ray;
  }

  function end(e) {
    if (!dragging) return;
    dragging = false;
    interactor.release();
    controls.enabled = true;
    try { el.releasePointerCapture(e.pointerId); } catch {}
  }

  el.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting || !interactor.active()) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (!interactor.grab(rayAt(e))) return;
    dragging = true;
    controls.enabled = false; // only once something is actually in hand
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', (e) => { if (dragging) interactor.move(rayAt(e)); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Depth control: a screen drag alone can't change how far away the part is,
  // so the wheel pushes it away / pulls it closer while it's held.
  el.addEventListener('wheel', (e) => {
    if (!dragging) return;
    e.preventDefault();
    interactor.push(-e.deltaY * 0.0015);
  }, { passive: false });
}
