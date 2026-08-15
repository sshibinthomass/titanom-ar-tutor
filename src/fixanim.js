import * as THREE from 'three';

/**
 * Fix-mode motion: the library of repair *gestures* the tutor acts out on the
 * model while it narrates.
 *
 * The LLM never generates motion. While planning, it splits each step into
 * spoken **beats** and tags every beat with one verb from FIX_ACTIONS; this
 * module owns what each verb looks like. A verb it invents degrades to
 * 'inspect' rather than producing garbage keyframes.
 *
 * Design rules learned the hard way:
 *
 * 1. **Never spin a large part.** A full turn on the seat or the tilt plate
 *    doesn't read as "unscrewing", it reads as the whole chair rotating. Every
 *    rotation is damped by `rotScale` — the part's own radius against the
 *    model's — so a caster twirls and a backrest barely tilts. Verbs whose
 *    whole point IS rotation (turn/lever/spin/wiggle) get a floor on that
 *    damping; decorative rotation (unscrew) does not.
 * 2. **Additive over the explode state.** Each frame a part's position is
 *    rebuilt as restPosition + direction·explodeAmount + the gesture's offset,
 *    so the explode tween, the slider and AR anchor refinement all keep working
 *    underneath. updateFixAnim must run AFTER updateTweens in the render loop.
 * 3. **Rotation and scale pivot on the part, not the group.** Geometry is baked
 *    to group space, so a bare mesh.quaternion spins the part around the group
 *    origin — the compensation is `c − q·(s·c)` with c the geometry centre.
 * 4. **Transforms only, never materials** — isolateParts owns emissive/opacity
 *    and the two must not fight.
 *
 * Object-level verbs (tip_over, stand_up, sit_test) move the whole model
 * instead of a part: "tip the chair on its side" is the single most common
 * sentence in a generated plan, and showing it is worth more than any glow.
 * They rotate about the PARENT origin, which frameModel() guarantees is the
 * model's floor-contact centre — on the desktop scene and under the AR pivot
 * alike — then re-ground via the onGroupPose callback so the chair pivots onto
 * its edge instead of sinking through the floor.
 */

/** Gestures performed on specific part(s). */
export const PART_ACTIONS = [
  'remove', 'install', 'lift_off', 'drop_in', 'unscrew', 'screw_in',
  'tap_loose', 'press_fit', 'turn', 'lever', 'wiggle', 'spin', 'swap', 'inspect',
];
/** Gestures performed on the whole object; these need no parts. */
export const OBJECT_ACTIONS = ['tip_over', 'stand_up', 'sit_test'];
export const FIX_ACTIONS = [...PART_ACTIONS, ...OBJECT_ACTIONS];

export function isObjectAction(action) {
  return OBJECT_ACTIONS.includes(action);
}

/** One line per verb, for the planner prompt — the single source of meaning. */
export const FIX_ACTION_GUIDE = [
  'remove = pull the part free along the way it comes off;',
  'install = bring the part in and seat it;',
  'lift_off = lift the part straight up off what it sits on;',
  'drop_in = lower the part straight down into place;',
  'unscrew = back a threaded fastener or part out, turn by turn;',
  'screw_in = drive it in and tighten it;',
  'tap_loose = free a seized or taper-fit joint with mallet taps;',
  'press_fit = press the part firmly home until it seats;',
  'turn = rotate a knob or dial in place;',
  'lever = flick a lever or paddle and let it return;',
  'wiggle = rock the part to check it for play or looseness;',
  'spin = roll a wheel or caster on its axle;',
  'swap = take the old part out and put the new one in;',
  'inspect = look the part over without moving it;',
  'tip_over = tip the WHOLE chair onto its side to reach underneath;',
  'stand_up = set the WHOLE chair back upright on its feet;',
  'sit_test = press down on the WHOLE chair to test it under weight.',
].join(' ');

// Seconds per loop. A beat is spoken over 2–6 s, so most gestures repeat once
// or twice while the sentence plays.
const PERIOD = {
  default: 2.6, swap: 4.2, spin: 2.0, wiggle: 1.6, lever: 2.2,
  tip_over: 6.0, stand_up: 5.0, sit_test: 3.2,
};
// Verbs that settle on their final pose instead of looping back to the start:
// "stand it upright" must END upright.
const HOLD_AT_END = new Set(['stand_up']);

const TRAVEL = 0.3;            // gesture travel, as a fraction of the model radius
const TIP_ANGLE = 1.4;         // ~80°, a chair laid on its side
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Gesture → pose at loop phase p ∈ [0,1).
 * along = travel along the part's explode direction, up = world-vertical,
 * angle = radians (damped later), axis = which axis to turn about,
 * scale = uniform scale, dy = whole-object vertical offset.
 * Every looping gesture returns to zero at p→1 so the restart never pops.
 */
const POSE = {
  remove(p) {
    return { along: p < 0.5 ? ease(seg(p, 0, 0.5)) : p < 0.72 ? 1 : 1 - ease(seg(p, 0.72, 1)) };
  },
  install(p) {
    return { along: p < 0.5 ? 1 - ease(seg(p, 0, 0.5)) : p < 0.72 ? 0 : ease(seg(p, 0.72, 1)) };
  },
  lift_off(p) { return { up: POSE.remove(p).along }; },
  drop_in(p) { return { up: POSE.install(p).along }; },

  // Turn-by-turn back-out: four discrete quarter turns, each a little further
  // out. The stepping is what reads as *threading* — a smooth spiral just looks
  // like the part spinning.
  unscrew(p) {
    if (p >= 0.78) { const b = 1 - ease(seg(p, 0.78, 1)); return { along: 0.85 * b, angle: -2 * Math.PI * b, axis: 'dir' }; }
    const turns = 4;
    const q = clamp01(p / 0.68) * turns;
    const k = Math.min(turns, Math.floor(q) + ease(q % 1));
    return { along: 0.85 * (k / turns), angle: -(Math.PI / 2) * k, axis: 'dir' };
  },
  screw_in(p) {
    const u = POSE.unscrew(p);
    return { along: 0.85 - u.along, angle: -u.angle, axis: 'dir' };
  },

  // Three decaying mallet impulses while the joint creeps apart.
  tap_loose(p) {
    const hit = p < 0.78;
    const creep = hit ? 0.2 * (p / 0.78) : 0.2 * (1 - seg(p, 0.78, 1));
    const tp = hit ? ((p / 0.78) * 3) % 1 : 0;
    return { along: creep + (hit ? 0.1 * Math.exp(-9 * tp) : 0) };
  },
  press_fit(p) {
    const out = p < 0.35 ? 0.5 * (1 - ease(seg(p, 0, 0.35)))
      : p < 0.5 ? -0.04 * Math.sin(Math.PI * seg(p, 0.35, 0.5)) // overshoot, then settle
      : p < 0.78 ? 0
      : 0.5 * ease(seg(p, 0.78, 1));
    return { along: out };
  },

  turn(p) { return { angle: 0.7 * Math.sin(2 * Math.PI * p), axis: 'dir' }; },
  lever(p) {
    const a = p < 0.2 ? ease(p / 0.2) : p < 0.45 ? 1 : p < 0.7 ? 1 - ease(seg(p, 0.45, 0.7)) : 0;
    return { angle: 0.55 * a, axis: 'roll' };
  },
  wiggle(p) {
    const env = Math.sin(Math.PI * p); // fade in and out so the loop is seamless
    return { angle: 0.16 * env * Math.sin(2 * Math.PI * 3 * p), axis: 'roll' };
  },
  // A full revolution lands back where it started, so this loops seamlessly.
  spin(p) { return { angle: 2 * Math.PI * p, axis: 'roll' }; },

  // Old one out, a beat of empty space, new one in — then a nudge to seat it.
  swap(p) {
    if (p < 0.3) return { along: ease(p / 0.3) };
    if (p < 0.46) return { along: 1 };
    if (p < 0.78) return { along: 1 - ease(seg(p, 0.46, 0.78)) };
    return { along: -0.05 * Math.sin(Math.PI * seg(p, 0.78, 1)) };
  },
  // Deliberately NOT a rotation: a slow breath, so "look this over" doesn't
  // read as the object turning.
  inspect(p) {
    const b = (1 - Math.cos(2 * Math.PI * p)) / 2;
    return { scale: 1 + 0.045 * b, up: 0.03 * b };
  },

  tip_over(p) {
    const a = p < 0.2 ? ease(p / 0.2) : p < 0.82 ? 1 : 1 - ease(seg(p, 0.82, 1));
    return { angle: TIP_ANGLE * a };
  },
  stand_up(p) { return { angle: TIP_ANGLE * (1 - ease(clamp01(p / 0.35))) }; },
  // Taking weight, twice. It has to be a *squash* rather than a drop: the model
  // is re-grounded onto the floor every frame, so a downward offset would be
  // cancelled exactly (it was, and sit_test did nothing at all). Compressing
  // keeps the feet planted and dips the seat — which is what loading it looks
  // like anyway.
  sit_test(p) { return { squash: 1 - 0.03 * (1 - Math.cos(2 * Math.PI * 2 * p)) / 2 }; },
};

let anim = null; // the one active gesture; starting another replaces (and restores) it

// DEBUG: inspect the live gesture from the console (window.__parts's sibling).
if (typeof window !== 'undefined') window.__fixanim = () => anim;

/**
 * Start (or replace) a gesture.
 *
 * opts: scale = model radius (sizes every travel), amount = the live explode
 * amount, delay = seconds before the first frame (lets a camera flight settle),
 * group + onGroupPose = the exploded group and a re-ground callback, required
 * by the object-level verbs.
 */
export function startFixAnim(parts, indices, action, { scale = 1, amount = 0, delay = 0, group = null, onGroupPose = null } = {}) {
  stopFixAnim();
  if (!FIX_ACTIONS.includes(action)) action = 'inspect';
  const object = isObjectAction(action);
  if (object && !group) return;          // nothing to move
  if (!object && !(indices && indices.length)) return;

  const centers = new Map();
  const rot = new Map();
  if (!object) {
    // Rotation damping is per part: the same verb twirls a caster and barely
    // tilts a backrest, which is what stops big parts reading as "the chair
    // is spinning".
    const rotational = ['turn', 'lever', 'spin', 'wiggle'].includes(action);
    for (const i of indices) {
      const g = parts[i].mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingSphere) g.computeBoundingSphere();
      centers.set(i, g.boundingBox.getCenter(new THREE.Vector3()));
      const ratio = (g.boundingSphere?.radius || 0) / (scale || 1);
      const damp = Math.max(0.08, Math.min(1, 1 - 2 * ratio));
      rot.set(i, rotational ? Math.max(damp, 0.5) : damp);
    }
  }

  anim = {
    parts, indices: object ? [] : [...indices], action, object,
    t: 0, delay, scale, amount, centers, rot,
    group, onGroupPose,
    groupRest: object ? group.position.clone() : null,
    // AR sizes the model by writing group.scale, so a squash has to ride on top
    // of whatever scale is already there rather than replacing it.
    groupScale: object ? group.scale.clone() : null,
    period: PERIOD[action] || PERIOD.default,
  };
}

/** Stop, and put everything back exactly where the explode state says it rests. */
export function stopFixAnim() {
  if (!anim) return;
  if (anim.object) {
    anim.group.quaternion.identity();
    anim.group.position.copy(anim.groupRest);
    anim.group.scale.copy(anim.groupScale);
    anim.onGroupPose?.();
  } else {
    for (const i of anim.indices) {
      const p = anim.parts[i];
      p.mesh.quaternion.identity();
      p.mesh.scale.set(1, 1, 1);
      p.mesh.position.copy(p.restPosition).addScaledVector(p.direction, anim.amount);
    }
  }
  anim = null;
}

export function isFixAnimActive() { return !!anim; }
export function currentFixAction() { return anim?.action || null; }

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/**
 * Advance the gesture. Call once per frame AFTER updateTweens, passing the live
 * explode amount so the gesture layers on top of whatever spread is in effect.
 */
export function updateFixAnim(dt, explodeAmount) {
  if (!anim) return;
  anim.amount = explodeAmount;
  anim.t += dt;
  const live = anim.t - anim.delay;
  if (live < 0) return; // settling window — don't touch anything yet

  // Reduced motion: hold one representative pose rather than looping.
  const raw = live / anim.period;
  const phase = prefersReducedMotion() ? 0.35
    : HOLD_AT_END.has(anim.action) ? Math.min(1, raw)
    : raw % 1;
  const pose = POSE[anim.action](phase);

  if (anim.object) {
    _q.setFromAxisAngle(AXIS_Z, pose.angle || 0);
    anim.group.quaternion.copy(_q);
    // Rotate about the parent origin — frameModel() puts the model's floor
    // contact there — then let the caller re-ground it onto the floor.
    anim.group.position.copy(anim.groupRest).applyQuaternion(_q);
    anim.group.scale.copy(anim.groupScale);
    if (pose.squash) anim.group.scale.y *= pose.squash;
    anim.onGroupPose?.(); // re-ground: the chair pivots on its edge, feet planted
    return;
  }

  const D = TRAVEL * anim.scale;
  for (const i of anim.indices) {
    const p = anim.parts[i];
    const s = pose.scale || 1;

    // 'dir' turns about the part's own explode axis (how a threaded part backs
    // out); 'roll' turns about the horizontal axis across it (how a wheel rolls
    // or a paddle pivots).
    if (pose.angle) {
      if (pose.axis === 'roll') {
        _axis.crossVectors(UP, p.direction);
        if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
      } else {
        _axis.copy(p.direction);
        if (_axis.lengthSq() < 1e-8) _axis.copy(UP);
      }
      _q.setFromAxisAngle(_axis.normalize(), pose.angle * (anim.rot.get(i) ?? 1));
    } else {
      _q.identity();
    }

    const c = anim.centers.get(i);
    p.mesh.position
      .copy(p.restPosition).addScaledVector(p.direction, explodeAmount) // explode base
      .addScaledVector(p.direction, (pose.along || 0) * D)              // gesture travel
      .add(_pivot.copy(c).multiplyScalar(s).applyQuaternion(_q).sub(c).negate()); // c − q·(s·c)
    p.mesh.position.y += (pose.up || 0) * D;
    p.mesh.quaternion.copy(_q);
    p.mesh.scale.setScalar(s);
  }
}
