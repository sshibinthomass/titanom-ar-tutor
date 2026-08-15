import * as THREE from 'three';

/**
 * Motion: a tiny tween engine plus the camera flight that frames a part.
 *
 * Everything the app animates (the explode amount, the orbit camera) is driven
 * from the single `updateTweens(dt)` call in main.js's render loop — no timers,
 * no extra rAF, and nothing keeps running once a tween finishes.
 *
 * Tweens are keyed by channel ('explode', 'camera') so starting a new one
 * *replaces* the old rather than both fighting over the same value — mashing
 * Next through Fix steps stays sane instead of stacking half-finished flights.
 */

// Respect the OS "reduce motion" setting: tweens complete on creation, which is
// exactly the snap-to-final behaviour the app had before any of this existed.
function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const tweens = new Map();

/**
 * Start (or replace) a tween on `key`.
 * `onUpdate(eased, raw)` gets both curves — `raw` is what per-part staggering
 * needs, since each part eases over its own slice of the timeline.
 */
export function tweenTo(key, { duration = 600, onUpdate, onComplete } = {}) {
  tweens.delete(key);
  if (prefersReducedMotion() || duration <= 0) {
    onUpdate?.(1, 1);
    onComplete?.();
    return;
  }
  tweens.set(key, { t: 0, duration: duration / 1000, onUpdate, onComplete });
}

export function cancelTween(key) {
  tweens.delete(key);
}

export function isTweening(key) {
  return tweens.has(key);
}

/** Advance every live tween. `dt` in seconds. */
export function updateTweens(dt) {
  if (!tweens.size || !(dt > 0)) return;
  for (const [key, tw] of [...tweens]) {
    tw.t += dt;
    const raw = Math.min(1, tw.t / tw.duration);
    tw.onUpdate?.(easeInOutCubic(raw), raw);
    // Delete before onComplete so the callback is free to start a new tween
    // on the same key without it being immediately wiped.
    if (raw >= 1) {
      tweens.delete(key);
      tw.onComplete?.();
    }
  }
}

// ---- Camera flight ---------------------------------------------------------

const _box = new THREE.Box3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _sph = new THREE.Spherical();
const _ray = new THREE.Raycaster();

/** World-space bounding sphere of the given part indices. null if none are visible. */
export function partsBounds(parts, indices) {
  _box.makeEmpty();
  for (const i of indices) {
    const p = parts[i];
    if (!p || !p.mesh.visible) continue;
    p.mesh.updateWorldMatrix(true, false); // ancestors too: the group moves as it explodes
    _box.expandByObject(p.mesh);
  }
  if (_box.isEmpty()) return null;
  return _box.getBoundingSphere(new THREE.Sphere());
}

// A ghosted part (isolateParts dims everything else to ~7% opacity) doesn't
// really block the view, so it must not count as an occluder — otherwise every
// Fix step, where all the *other* parts are ghosted, would read as "occluded"
// and swing the camera around for no reason.
function isSolid(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => m && m.visible !== false && !(m.transparent && m.opacity < 0.5));
}

function isOccluded(camPos, target, parts, targetSet) {
  _dir.copy(target).sub(camPos);
  const dist = _dir.length();
  if (dist < 1e-6) return false;
  _dir.multiplyScalar(1 / dist);

  const candidates = [];
  for (let i = 0; i < parts.length; i++) {
    if (targetSet.has(i)) continue;
    const mesh = parts[i].mesh;
    if (mesh.visible && isSolid(mesh)) candidates.push(mesh);
  }
  if (!candidates.length) return false;

  _ray.set(camPos, _dir);
  _ray.near = 0;
  _ray.far = dist * 0.98; // stop just short of the target itself
  return _ray.intersectObjects(candidates, false).length > 0;
}

/**
 * Fly the orbit camera so `indices` sit centred and comfortably framed.
 *
 * The user's viewing angle is preserved by default — a guided step that spun the
 * whole view every time gets nauseating fast — and we only orbit to a new azimuth
 * when something solid is actually in the way.
 *
 * The destination is re-derived every frame from the parts' live bounds, because
 * an explode tween may be running at the same time: parts move, and grounding the
 * group shifts it vertically, so a destination frozen at t=0 would leave the
 * camera drifting toward a stale point while the model slides out from under it.
 *
 * Returns false when there is nothing to frame, so the caller can leave the view be.
 */
export function flyToParts({
  camera,
  controls,
  parts,
  indices,
  minDistance = 0,
  maxDistance = Infinity,
  duration = 750,
  padding = 1.9,
  allowOrbit = true,
  onDone,
}) {
  const sphere = partsBounds(parts, indices);
  if (!sphere) return false;

  // Distance that fits a sphere of `r`, against the narrower of the two FOVs so
  // a portrait phone doesn't crop the part sideways the way a vertical-only fit
  // would. Re-evaluated per frame: an explode tween is usually running alongside
  // this one, and a group like "Seat" (two islands) genuinely grows as it
  // spreads — sizing off the t=0 bounds would leave the camera too close by the
  // time the part arrives, and would frame the same step differently depending
  // on whether it was reached mid-explode or after.
  const fitDistance = (r) => {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    return THREE.MathUtils.clamp(
      (Math.max(r, 1e-4) * padding) / Math.sin(Math.min(vFov, hFov) / 2),
      minDistance,
      maxDistance
    );
  };
  const distance = fitDistance(sphere.radius);

  // Current view direction, with the elevation clamped to a flattering band —
  // straight-down or ground-level framings both read badly.
  _dir.copy(camera.position).sub(controls.target);
  if (_dir.lengthSq() < 1e-8) _dir.set(0.8, 0.6, 0.9);
  _sph.setFromVector3(_dir.normalize());
  const phi = THREE.MathUtils.clamp(_sph.phi, THREE.MathUtils.degToRad(35), THREE.MathUtils.degToRad(80));

  // Keep the current azimuth unless something solid blocks it; then take the
  // smallest turn that clears the view.
  let theta = _sph.theta;
  if (allowOrbit) {
    const targetSet = new Set(indices);
    const offsets = [0];
    for (let a = 25; a <= 180; a += 25) offsets.push(a, -a);
    for (const deg of offsets) {
      const candidate = _sph.theta + THREE.MathUtils.degToRad(deg);
      _probe.setFromSpherical(new THREE.Spherical(distance, phi, candidate)).add(sphere.center);
      if (!isOccluded(_probe, sphere.center, parts, targetSet)) {
        theta = candidate;
        break;
      }
    }
  }

  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const unit = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta));
  const aim = sphere.center.clone();
  const endPos = new THREE.Vector3();
  let fit = distance;

  tweenTo('camera', {
    duration,
    onUpdate: (eased) => {
      const live = partsBounds(parts, indices);
      if (live) {
        aim.copy(live.center);
        fit = fitDistance(live.radius);
      }
      endPos.copy(unit).multiplyScalar(fit).add(aim);
      endPos.y = Math.max(endPos.y, fit * 0.08); // never dive under the floor
      camera.position.lerpVectors(startPos, endPos, eased);
      controls.target.lerpVectors(startTarget, aim, eased);
      controls.update();
    },
    onComplete: onDone,
  });
  return true;
}

/** Move the camera to an explicit pose — tweened, or snapped when `animate` is false. */
export function moveCamera(camera, controls, position, target, { animate = false, duration = 750 } = {}) {
  if (!animate) {
    cancelTween('camera');
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
    return;
  }
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const endPos = position.clone();
  const endTarget = target.clone();
  tweenTo('camera', {
    duration,
    onUpdate: (eased) => {
      camera.position.lerpVectors(startPos, endPos, eased);
      controls.target.lerpVectors(startTarget, endTarget, eased);
      controls.update();
    },
  });
}
