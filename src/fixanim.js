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
 * 1. **Gestures move along the part's own axis.** `part.direction` is purely
 *    radial (centroid minus model centre) — fine for exploding, wrong for
 *    repair: it points a seat bolt sideways and gives a central part like the
 *    gas cylinder a nearly arbitrary direction. `workingAxis()` instead reads
 *    the part's geometry, so a cylinder comes out along its length and a wheel
 *    rolls about its axle. See its comment for the orientation rule.
 * 2. **Never spin a large part.** A full turn on the seat or the tilt plate
 *    doesn't read as "unscrewing", it reads as the whole chair rotating. Every
 *    rotation is damped by `rotScale` — the part's own radius against the
 *    model's — so a caster twirls and a backrest barely tilts. Verbs whose
 *    whole point IS rotation get a floor on that damping; decorative rotation
 *    (unscrew) does not.
 * 3. **Additive over the explode state.** Each frame a part's position is
 *    rebuilt as restPosition + direction·explodeAmount + the gesture's offset,
 *    so the explode tween, the slider and AR anchor refinement all keep working
 *    underneath. updateFixAnim must run AFTER updateTweens in the render loop.
 *    Note the explode base keeps using `direction` — that is explode.js's
 *    contract; only the gesture travel uses the working axis.
 * 4. **Rotation and scale pivot on the part, not the group.** Geometry is baked
 *    to group space, so a bare mesh.quaternion spins the part around the group
 *    origin — the compensation is `c − q·(S·c)` with c the geometry centre.
 * 5. **Transforms only, never materials** — isolateParts owns emissive/opacity
 *    and the two must not fight.
 *
 * Object-level verbs move the whole model instead of a part: "tip the chair on
 * its side" is among the most common sentences in a generated plan, and showing
 * it is worth more than any glow. They rotate about the PARENT origin, which
 * frameModel() guarantees is the model's floor-contact centre — on the desktop
 * scene and under the AR pivot alike — then re-ground via the onGroupPose
 * callback so the chair pivots onto its edge instead of sinking through
 * the floor.
 */

/** Gestures performed on specific part(s). */
export const PART_ACTIONS = [
  'remove', 'install', 'lift_off', 'drop_in', 'slide_out', 'slide_in',
  'unscrew', 'screw_in', 'unclip', 'tap_loose', 'press_fit', 'align',
  'turn', 'lever', 'wiggle', 'tug', 'spin', 'swap',
  'grease', 'wipe', 'stretch', 'inspect',
];
/** Gestures performed on the whole object; these need no parts. */
export const OBJECT_ACTIONS = ['tip_over', 'flip_over', 'stand_up', 'sit_test', 'rock_test', 'roll_away'];
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
  'slide_out = slide the part out sideways;',
  'slide_in = slide the part in sideways;',
  'unscrew = back a threaded fastener or part out, turn by turn;',
  'screw_in = drive it in and tighten it;',
  'unclip = pry or pop a clip, cap or press-fit cover off;',
  'tap_loose = free a seized or taper-fit joint with mallet taps;',
  'press_fit = press the part firmly home until it seats;',
  'align = line the part up with its holes or slot before fixing it;',
  'turn = rotate a knob or dial in place;',
  'lever = flick a lever or paddle and let it return;',
  'wiggle = rock the part to check it for play or looseness;',
  'tug = pull on the part in short sharp tugs to check it is secure;',
  'spin = roll a wheel or caster on its axle;',
  'swap = take the old part out and put the new one in;',
  'grease = work grease or lubricant into the part or its joint;',
  'wipe = clean, wipe or clear debris off the part;',
  'stretch = show fabric or mesh stretching, sagging or losing tension;',
  'inspect = look the part over without moving it;',
  'tip_over = tip the WHOLE chair onto its side to reach underneath;',
  'flip_over = turn the WHOLE chair fully upside down to work on the base;',
  'stand_up = set the WHOLE chair back upright on its feet;',
  'sit_test = press down on the WHOLE chair to test it under weight;',
  'rock_test = rock the WHOLE chair side to side to check it for wobble;',
  'roll_away = roll the WHOLE chair across the floor on its casters.',
].join(' ');

// Seconds per loop. A beat is spoken over 2–6 s, so most gestures repeat once
// or twice while the sentence plays.
const PERIOD = {
  default: 2.6, swap: 4.2, spin: 2.0, wiggle: 1.6, lever: 2.2, tug: 2.2,
  grease: 2.4, wipe: 2.4, align: 2.8, unclip: 3.0, stretch: 3.0,
  tip_over: 6.0, flip_over: 6.5, stand_up: 5.0, sit_test: 3.2, rock_test: 3.0, roll_away: 4.0,
};
// Verbs that settle on their final pose instead of looping back to the start:
// "stand it upright" must END upright.
const HOLD_AT_END = new Set(['stand_up']);
// Verbs whose point IS rotation: they keep a floor under the size damping, or a
// caster's roll would be damped down to a twitch.
const ROTATIONAL = new Set(['turn', 'lever', 'spin', 'wiggle', 'rock_test']);
// `spin` completes a whole revolution, which is what makes it loop seamlessly —
// damping it to a fraction of a turn leaves the wheel snapping back each cycle.
// It is only ever chosen for wheels, so a full turn is right anyway.
const UNDAMPED = new Set(['spin']);

const TIP_ANGLE = 1.4;         // ~80°, a chair laid on its side
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The axis a part is worked along, read from the shape of the part itself.
 *
 * Three cases, because the answer is the opposite for the two common shapes:
 *  - **rod** (one dimension much longer): its length. A gas cylinder, a bolt or
 *    a caster stem threads, taps and pulls out end-on.
 *  - **plate** (one dimension much shorter): its *normal* — the short way. You
 *    lift a seat off its face, not edgewise, and peel a mesh panel off the
 *    frame. Getting this backwards slid the seat sideways out of the chair.
 *    It also gives a disc-shaped knob the axis it actually turns about.
 *  - **blob** (no dominant shape): fall back to the radial explode direction,
 *    which at least points away from the model.
 *
 * Orientation: a vertical axis always points UP, because things come off
 * upward — the sign is otherwise ambiguous for a central part, and "remove"
 * driving the gas cylinder down through the floor is the failure it prevents.
 * Horizontal axes point away from the model centre.
 */
function workingAxis(part) {
  const g = part.mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3());
  const dims = [s.x, s.y, s.z];
  const max = Math.max(...dims), min = Math.min(...dims);
  const mid = dims.reduce((a, b) => a + b, 0) - max - min;
  let i;
  if (max > mid * 1.4) i = dims.indexOf(max);        // rod → along its length
  else if (mid > min * 1.4) i = dims.indexOf(min);   // plate → along its normal
  else return part.direction.clone();                // blob → radial
  const axis = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  if (i === 1) return axis;                                  // vertical: always up
  if (axis.dot(part.direction) < 0) axis.negate();            // else: away from centre
  return axis;
}

/**
 * Gesture → pose at loop phase p ∈ [0,1).
 * along/lat/up = travel along the working axis, its horizontal component, and
 * world-vertical; angle = radians (damped later) about `axis`; scale = uniform;
 * stretch = scale along the working axis only; squash/dx = whole-object.
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
  slide_out(p) { return { lat: POSE.remove(p).along }; },
  slide_in(p) { return { lat: POSE.install(p).along }; },

  // Turn-by-turn back-out: four discrete quarter turns, each a little further
  // out. The stepping is what reads as *threading* — a smooth spiral just looks
  // like the part spinning.
  unscrew(p) {
    if (p >= 0.78) { const b = 1 - ease(seg(p, 0.78, 1)); return { along: 0.85 * b, angle: -2 * Math.PI * b, axis: 'work' }; }
    const turns = 4;
    const q = clamp01(p / 0.68) * turns;
    const k = Math.min(turns, Math.floor(q) + ease(q % 1));
    return { along: 0.85 * (k / turns), angle: -(Math.PI / 2) * k, axis: 'work' };
  },
  screw_in(p) {
    const u = POSE.unscrew(p);
    return { along: 0.85 - u.along, angle: -u.angle, axis: 'work' };
  },

  // Pry, then pop: the cap levers over on one edge and springs free.
  unclip(p) {
    if (p < 0.32) return { angle: 0.35 * ease(p / 0.32), axis: 'roll', along: 0.05 * ease(p / 0.32) };
    if (p < 0.46) { const b = ease(seg(p, 0.32, 0.46)); return { angle: 0.35 * (1 - b), axis: 'roll', along: 0.05 + 0.75 * b }; }
    if (p < 0.72) return { along: 0.8 };
    return { along: 0.8 * (1 - ease(seg(p, 0.72, 1))) };
  },

  // Three decaying mallet impulses while the joint creeps apart. The strikes are
  // phase-shifted to land *inside* the window (at 0.13, 0.39, 0.65) rather than
  // on p=0: an impulse at the loop boundary made every repeat open with a jolt
  // out of nowhere, because the pose at p=0 no longer matched the pose at p=1.
  tap_loose(p) {
    const hit = p < 0.78;
    const creep = hit ? 0.2 * (p / 0.78) : 0.2 * (1 - seg(p, 0.78, 1));
    const tp = hit ? ((p / 0.78) * 3 + 0.5) % 1 : 0.5;
    return { along: creep + 0.1 * Math.exp(-9 * tp) };
  },
  press_fit(p) {
    const out = p < 0.35 ? 0.5 * (1 - ease(seg(p, 0, 0.35)))
      : p < 0.5 ? -0.04 * Math.sin(Math.PI * seg(p, 0.35, 0.5)) // overshoot, then settle
      : p < 0.78 ? 0
      : 0.5 * ease(seg(p, 0.78, 1));
    return { along: out };
  },
  // Hunting for the holes: an offset that shrinks as it converges into place.
  align(p) {
    const decay = Math.exp(-3.2 * p);
    return { lat: 0.22 * decay * Math.sin(2 * Math.PI * 2.5 * p), angle: 0.2 * decay * Math.sin(2 * Math.PI * 2.5 * p), axis: 'roll' };
  },

  turn(p) { return { angle: 0.7 * Math.sin(2 * Math.PI * p), axis: 'work' }; },
  lever(p) {
    const a = p < 0.2 ? ease(p / 0.2) : p < 0.45 ? 1 : p < 0.7 ? 1 - ease(seg(p, 0.45, 0.7)) : 0;
    return { angle: 0.55 * a, axis: 'roll' };
  },
  wiggle(p) {
    const env = Math.sin(Math.PI * p); // fade in and out so the loop is seamless
    return { angle: 0.16 * env * Math.sin(2 * Math.PI * 3 * p), axis: 'roll' };
  },
  // Three short sharp pulls: is it actually tight?
  tug(p) {
    if (p >= 0.85) return { along: 0 };
    const tp = (p / 0.85 * 3) % 1;
    return { along: 0.18 * (tp < 0.35 ? ease(tp / 0.35) : 1 - ease((tp - 0.35) / 0.65)) };
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

  // Working it in: two small circles in the plane of the joint.
  grease(p) {
    const env = Math.sin(Math.PI * p);
    return { along: 0.07 * env * Math.cos(2 * Math.PI * 2 * p), up: 0.07 * env * Math.sin(2 * Math.PI * 2 * p) };
  },
  // Cleaning strokes back and forth across the face of the part.
  wipe(p) {
    const env = Math.sin(Math.PI * p);
    return { lat: 0.14 * env * Math.sin(2 * Math.PI * 2 * p), up: 0.02 * env };
  },
  // Fabric losing its tension: it elongates along its own axis and sags.
  stretch(p) {
    const b = (1 - Math.cos(2 * Math.PI * p)) / 2;
    return { stretch: 1 + 0.12 * b, up: -0.04 * b };
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
  flip_over(p) {
    const a = p < 0.22 ? ease(p / 0.22) : p < 0.82 ? 1 : 1 - ease(seg(p, 0.82, 1));
    return { angle: Math.PI * a };
  },
  stand_up(p) { return { angle: TIP_ANGLE * (1 - ease(clamp01(p / 0.35))) }; },
  // Taking weight, twice. It has to be a *squash* rather than a drop: the model
  // is re-grounded onto the floor every frame, so a downward offset would be
  // cancelled exactly (it was, and sit_test did nothing at all). Compressing
  // keeps the feet planted and dips the seat — which is what loading it looks
  // like anyway.
  sit_test(p) { return { squash: 1 - 0.03 * (1 - Math.cos(2 * Math.PI * 2 * p)) / 2 }; },
  rock_test(p) { return { angle: 0.13 * Math.sin(2 * Math.PI * 2 * p) }; },
  roll_away(p) {
    const b = p < 0.45 ? ease(p / 0.45) : p < 0.6 ? 1 : 1 - ease(seg(p, 0.6, 1));
    return { dx: 0.9 * b };
  },
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
  const axes = new Map();
  if (!object) {
    for (const i of indices) {
      const part = parts[i];
      const g = part.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingSphere) g.computeBoundingSphere();
      centers.set(i, g.boundingBox.getCenter(new THREE.Vector3()));

      const work = workingAxis(part).normalize();
      // Sideways: the horizontal part of the working axis, so a slide never
      // drifts vertically. A vertical working axis has none, so fall back to
      // something horizontal and perpendicular.
      const lat = new THREE.Vector3(work.x, 0, work.z);
      if (lat.lengthSq() < 1e-6) lat.crossVectors(UP, part.direction);
      if (lat.lengthSq() < 1e-6) lat.set(1, 0, 0);
      // Rolling: the horizontal axis across the part — a wheel's axle.
      const roll = new THREE.Vector3().crossVectors(UP, work);
      if (roll.lengthSq() < 1e-6) roll.crossVectors(UP, part.direction);
      if (roll.lengthSq() < 1e-6) roll.set(1, 0, 0);
      // Travel is sized to the PART, not the model: a bolt cap sliding as far
      // as the seat does reads as the cap being thrown across the room. Clamped
      // so a tiny part still moves visibly and a huge one doesn't fly off.
      const partR = g.boundingSphere?.radius || 0;
      const travel = Math.max(0.07 * scale, Math.min(0.32 * scale, partR * 2.2));
      axes.set(i, { work, lat: lat.normalize(), roll: roll.normalize(), travel });

      // Rotation damping is per part: the same verb twirls a caster and barely
      // tilts a backrest, which is what stops big parts reading as "the chair
      // is spinning".
      const ratio = (g.boundingSphere?.radius || 0) / (scale || 1);
      const damp = Math.max(0.08, Math.min(1, 1 - 2 * ratio));
      rot.set(i, UNDAMPED.has(action) ? 1 : ROTATIONAL.has(action) ? Math.max(damp, 0.5) : damp);
    }
  }

  anim = {
    parts, indices: object ? [] : [...indices], action, object,
    t: 0, delay, scale, amount, centers, rot, axes,
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
const _pivot = new THREE.Vector3();
const _scale = new THREE.Vector3();
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
    anim.group.position.x += (pose.dx || 0) * anim.scale;
    anim.group.scale.copy(anim.groupScale);
    if (pose.squash) anim.group.scale.y *= pose.squash;
    anim.onGroupPose?.(); // re-ground: the chair pivots on its edge, feet planted
    return;
  }

  for (const i of anim.indices) {
    const p = anim.parts[i];
    const ax = anim.axes.get(i);
    const D = ax.travel;

    if (pose.angle) {
      _q.setFromAxisAngle(pose.axis === 'roll' ? ax.roll : ax.work, pose.angle * (anim.rot.get(i) ?? 1));
    } else {
      _q.identity();
    }

    // Uniform breath, or a stretch along the part's own axis only.
    if (pose.stretch) {
      const k = pose.stretch - 1;
      _scale.set(1 + k * Math.abs(ax.work.x), 1 + k * Math.abs(ax.work.y), 1 + k * Math.abs(ax.work.z));
    } else {
      _scale.setScalar(pose.scale || 1);
    }

    const c = anim.centers.get(i);
    p.mesh.position
      .copy(p.restPosition).addScaledVector(p.direction, explodeAmount) // explode base
      .addScaledVector(ax.work, (pose.along || 0) * D)                  // along its own axis
      .addScaledVector(ax.lat, (pose.lat || 0) * D)                     // sideways
      .add(_pivot.copy(c).multiply(_scale).applyQuaternion(_q).sub(c).negate()); // c − q·(S·c)
    p.mesh.position.y += (pose.up || 0) * D;
    p.mesh.quaternion.copy(_q);
    p.mesh.scale.copy(_scale);
  }
}
