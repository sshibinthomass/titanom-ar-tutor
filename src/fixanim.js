import * as THREE from 'three';
import { easeInOutCubic } from './animate.js';

/**
 * Fix-mode motion primitives: short looping clips that *show* a step's physical
 * operation on its part(s) — pulling out, screwing, tapping loose, pressing in.
 *
 * The LLM never generates motion. It picks a verb from FIX_ACTIONS (per fix
 * step, and per spoken answer via the ACTION: header) and this module owns what
 * each verb looks like — so a hallucinated verb degrades to 'inspect' instead
 * of garbage keyframes.
 *
 * The layer is **additive over the explode state**: every frame each animated
 * part's position is recomputed as restPosition + direction·explodeAmount +
 * the clip's offset, with the live amount passed into updateFixAnim. That is
 * what keeps it from fighting the explode tween, the slider, and AR anchor
 * refinement — the same channel discipline the rest of the motion system uses.
 * updateFixAnim must run AFTER updateTweens in the render loop so the clip wins
 * over the explode tween for its own parts.
 *
 * Rotation gotcha: part geometry is baked to group space, so rotating
 * mesh.quaternion spins the part around the GROUP origin. Every rotating clip
 * compensates with the part's cached bbox centre c: position += c − q·c, which
 * turns the spin into one about the part's own centre.
 *
 * Transforms only, never materials — isolateParts owns emissive/opacity and
 * the two must not fight.
 */

export const FIX_ACTIONS = ['remove', 'install', 'unscrew', 'screw_in', 'tap_loose', 'press_fit', 'turn', 'inspect'];

/** One line per verb, for LLM prompts — the single source of what each means. */
export const FIX_ACTION_GUIDE =
  'remove = pull or lift the part off/out; install = fit the part into place; ' +
  'unscrew = undo fasteners; screw_in = tighten fasteners; ' +
  'tap_loose = free a seized joint with taps; press_fit = press the part firmly home; ' +
  'turn = rotate a knob or work a lever; inspect = look at or check the part only.';

const PERIOD = 2.8;   // seconds per loop, including the tail pause
const TRAVEL = 0.28;  // full travel distance as a fraction of the model radius

// Reduced motion: hold a single representative pose instead of looping.
function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (p, a, b) => clamp01((p - a) / (b - a));

// Each clip maps loop phase [0,1) → { along (travel × D along the explode
// direction), angle (radians about the direction axis — or world Y if `yaw`),
// lift (world-up bob × D) }. Loops end back at zero so the restart never pops.
const POSE = {
  remove(p) {
    const along = p < 0.55 ? easeInOutCubic(seg(p, 0, 0.55))
      : p < 0.75 ? 1
      : 1 - easeInOutCubic(seg(p, 0.75, 1));
    return { along };
  },
  install(p) {
    const along = p < 0.45 ? 1 - easeInOutCubic(seg(p, 0, 0.45))
      : p < 0.8 ? 0
      : easeInOutCubic(seg(p, 0.8, 1));
    return { along };
  },
  // The spiral: rotation rides the travel, so unscrewing visibly *winds* out.
  unscrew(p) { const { along } = POSE.remove(p); return { along, angle: along * 4 * Math.PI }; },
  screw_in(p) { const { along } = POSE.install(p); return { along, angle: along * 4 * Math.PI }; },
  // Three mallet taps per loop, each jolt decaying, while the part creeps out —
  // the taps visibly "work the taper loose".
  tap_loose(p) {
    const active = p < 0.75;
    const creep = active ? 0.18 * (p / 0.75) : 0.18 * (1 - seg(p, 0.75, 1));
    const tp = active ? ((p / 0.75) * 3) % 1 : 0;
    return { along: creep + (active ? 0.08 * Math.exp(-8 * tp) : 0) };
  },
  press_fit(p) {
    const along = p < 0.35 ? 0.45 * (1 - easeInOutCubic(seg(p, 0, 0.35)))
      : p < 0.8 ? 0
      : 0.45 * easeInOutCubic(seg(p, 0.8, 1));
    return { along };
  },
  turn(p) { return { along: 0, angle: 0.5 * Math.sin(2 * Math.PI * p) }; },
  inspect(p) {
    return { along: 0, yaw: true, angle: 0.18 * Math.sin(2 * Math.PI * p), lift: 0.02 * (1 - Math.cos(2 * Math.PI * p)) / 2 };
  },
};

let anim = null; // the one active clip; starting a new one replaces (and restores) the old

// DEBUG: inspect the live clip from the console (window.__parts's sibling).
if (typeof window !== 'undefined') window.__fixanim = () => anim;

/**
 * Start (or replace) a clip on the given part indices.
 * opts: scale = model radius (sizes the travel), amount = current explode
 * amount (for restore), delay = seconds to wait before the first frame (lets
 * the mild-explode tween + camera flight settle), loops = how many loops
 * before auto-stopping (Infinity = until replaced/stopped).
 */
export function startFixAnim(parts, indices, action, { scale = 1, amount = 0, delay = 0, loops = Infinity } = {}) {
  stopFixAnim();
  if (!indices || !indices.length) return;
  if (!FIX_ACTIONS.includes(action)) action = 'inspect';
  const centers = new Map();
  for (const i of indices) {
    const g = parts[i].mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    centers.set(i, g.boundingBox.getCenter(new THREE.Vector3()));
  }
  anim = { parts, indices, action, t: 0, delay, loops, scale, amount, centers };
}

/** Stop the clip and put its parts back exactly where the explode says they rest. */
export function stopFixAnim() {
  if (!anim) return;
  for (const i of anim.indices) {
    const p = anim.parts[i];
    p.mesh.quaternion.identity();
    p.mesh.position.copy(p.restPosition).addScaledVector(p.direction, anim.amount);
  }
  anim = null;
}

export function isFixAnimActive() { return !!anim; }

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _rotC = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Advance the clip. Call once per frame AFTER updateTweens, passing the live
 * explode amount — the clip layers on top of whatever explode state exists.
 */
export function updateFixAnim(dt, explodeAmount) {
  if (!anim) return;
  anim.amount = explodeAmount;
  anim.t += dt;
  const live = anim.t - anim.delay;
  if (live < 0) return; // settling window: don't touch the parts yet
  if (live / PERIOD >= anim.loops) { stopFixAnim(); return; }

  const phase = prefersReducedMotion() ? 0.3 : (live % PERIOD) / PERIOD;
  const D = TRAVEL * anim.scale;
  const pose = POSE[anim.action](phase);

  for (const i of anim.indices) {
    const p = anim.parts[i];
    _axis.copy(pose.yaw ? UP : p.direction);
    if (_axis.lengthSq() < 1e-8) _axis.copy(UP);
    _axis.normalize();
    _q.setFromAxisAngle(_axis, pose.angle || 0);

    const c = anim.centers.get(i);
    p.mesh.position
      .copy(p.restPosition).addScaledVector(p.direction, explodeAmount) // the explode base
      .addScaledVector(p.direction, (pose.along || 0) * D)              // the clip's travel
      .add(_rotC.copy(c).applyQuaternion(_q).sub(c).negate());          // c − q·c: spin about own centre
    p.mesh.position.y += (pose.lift || 0) * D;
    p.mesh.quaternion.copy(_q);
  }
}
