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
