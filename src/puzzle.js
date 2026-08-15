import * as THREE from 'three';
import { setHighlight } from './explode.js';

/**
 * Assemble as a drag-to-build puzzle.
 *
 * The parts are scattered on the floor around the build spot, the current step's
 * slot is drawn as a translucent "ghost", and the user drags a part into it:
 * right part → it snaps home, wrong part → red flash + shake and it floats back.
 * The prompt asks *which* part goes next; the teaching line is spoken only after
 * the attempt, so the mode trains recall instead of recognition.
 *
 * ── Why this works identically on desktop and in AR ───────────────────────────
 * Every measurement happens in the exploded group's **local** space:
 *
 *   • Geometry is baked to world space at build time, so a part's rest position
 *     is (0,0,0) and its slot is simply "where its geometry already is".
 *   • Pointer rays arrive in world space and are converted with `worldToLocal`,
 *     so the AR pivot's user scale (0.2–5×) and yaw, and the per-frame anchor
 *     pose refinement, all cancel out. One snap radius (a fraction of the model
 *     radius) is correct at every scale.
 *   • A carried part is a child of the group, so when the AR runtime nudges the
 *     anchor the part travels with the model instead of fighting it.
 *
 * Input is abstracted to a ray, so both surfaces share one implementation:
 *   • desktop — `attachDragger` in select.js builds the ray from camera + cursor
 *   • AR      — ar.js reads the XR input source's target ray (`targetRayMode:
 *               'screen'`, i.e. the finger), valid for exactly the span of the
 *               drag (selectstart → selectend)
 *
 * Stability, since a hand-held phone ray is noisy: the carried part chases a
 * *smoothed* target (the same exponential damping the AR reticle uses) rather
 * than teleporting to the raw ray each frame, and ar.js locks whole-model
 * manipulation while the puzzle is running so a drag can never move the board.
 */

// ---- Tuning ----------------------------------------------------------------

const SNAP_FRACTION = 0.34;   // catch radius, as a fraction of the model radius
const PART_FRACTION = 0.75;   // …but never tighter than this fraction of the part's own radius
const ASSIST_RADIUS = 1.9;    // magnetism reach, in catch radii
const ASSIST_LAMBDA = 9;      // how hard the slot pulls once you're aiming at it
const CARRY_LAMBDA = 16;      // damping while carried (higher = more responsive, less smooth)
const RETURN_LAMBDA = 9;      // damping flying back to the scatter ring
const SCATTER_LAMBDA = 5.5;   // the opening teardown — slower, so it reads as weight
const SCATTER_STAGGER = 0.075; // seconds between each group leaving, top-down
const SNAP_LAMBDA = 16;       // damping settling into the slot
const REJECT_SECONDS = 0.8;   // red flash + shake duration
const ADVANCE_SECONDS = 1.2;  // pause on the completed step before the next prompt.
                              // Nothing is spoken on a correct drop, so this is
                              // sized to let the snap cue (~1 s) finish first —
                              // cue, then the next prompt, never both at once.
const RING_BASE = 1.35;       // scatter ring radius, in model radii
const RING_STAGGER = 0.24;    // alternate rows so parts don't overlap

const CARRY_COLOR = 0x4ecdc4;
const REJECT_COLOR = 0xff4444;

// ---- Module state ----------------------------------------------------------
// One puzzle at a time (there is one model on screen), so a module-level slot
// keeps the call sites free of plumbing. `null` when no puzzle is running.
let state = null;

const raycaster = new THREE.Raycaster();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _slot = new THREE.Vector3();
const _best = new THREE.Vector3();
const _center = new THREE.Vector3();

export function isPuzzleActive() { return !!state; }

// ---- Geometry helpers ------------------------------------------------------

/** Centre of a part's geometry in group-local space (its rest position is 0). */
function localCenter(mesh) {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
}

/** Half-diagonal of a part's geometry — used to widen the catch radius for big parts. */
function localRadius(mesh) {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox.getSize(_v).length() * 0.5;
}

/** Live centre of a part = its rest centre plus however far it has been dragged. */
function partCenter(part, out) {
  return out.copy(part.center).add(part.mesh.position);
}

// ---- Setup -----------------------------------------------------------------

/**
 * Start the puzzle.
 *
 * opts:
 *   group   – the exploded group (parts are its children; all math is local to it)
 *   parts   – the live part list from buildExplodedView
 *   steps   – [{ indices, text, prompt, name }] from resolveAssemble
 *   radius  – model radius in local units (main.js's modelRadius)
 *   onStep     ({ index, step })            – a new step became active (incl. the first)
 *   onCorrect  ({ step, index, assisted })  – the step was solved
 *   onWrong    ({ step, attempted, expected }) – a wrong part was dropped in the slot
 *   onCarry    (partIndex | -1)             – a part was picked up / put down
 *   onComplete ({ mistakes, assists })      – every step is done
 */
export function startPuzzle(opts) {
  stopPuzzle();

  const { group, parts, steps, radius } = opts;
  if (!group || !parts.length || !steps.length) return false;

  state = {
    group, parts, steps,
    radius: radius || 1,
    stepIndex: 0,
    solved: new Set(),      // part indices already placed
    home: new Map(),        // part index → scatter position (group-local)
    anim: new Map(),        // part index → { to, lambda, flash, shake }
    held: null,
    captured: false,        // held part is inside the catch radius (hysteresis + visuals)
    advanceIn: 0,           // seconds until the next step is armed
    ghostHold: 0,           // seconds the ghost stays hidden during the opening teardown
    mistakes: 0,
    assists: 0,
    time: 0,
    ghostGroup: new THREE.Group(),
    ghostMat: new THREE.MeshBasicMaterial({
      color: CARRY_COLOR, transparent: true, opacity: 0.2,
      depthWrite: false, side: THREE.DoubleSide,
    }),
    ghostWire: new THREE.MeshBasicMaterial({
      color: CARRY_COLOR, transparent: true, opacity: 0.45,
      depthWrite: false, wireframe: true,
    }),
    cb: opts,
  };

  // Cache per-part geometry facts once — the drag loop must not recompute bboxes.
  for (const p of parts) {
    p.center = localCenter(p.mesh);
    p.radius = localRadius(p.mesh);
    p.mesh.position.copy(p.restPosition);
    p.mesh.visible = true;
  }

  state.ghostGroup.renderOrder = 998;
  group.add(state.ghostGroup);

  // Open by taking the assembled object apart in front of the user, rather than
  // cutting to a pile of parts.
  scatter({ animate: true, stagger: SCATTER_STAGGER });
  buildGhosts();
  state.ghostGroup.visible = false;
  state.cb.onStep?.({ index: 0, step: steps[0] });
  return true;
}

/** Tear down: parts back to rest, ghosts disposed, highlights cleared. */
export function stopPuzzle() {
  if (!state) return;
  const { group, parts } = state;

  if (state.held) setHighlight(parts[state.held.index], false);
  for (const i of state.anim.keys()) setHighlight(parts[i], false);

  clearGhosts();
  group.remove(state.ghostGroup);
  // Ghost meshes share the parts' geometry — only the two shared materials are ours.
  state.ghostMat.dispose();
  state.ghostWire.dispose();

  for (const p of parts) p.mesh.position.copy(p.restPosition);
  state = null;
}

/**
 * Lay the unplaced parts out in a ring on the floor around the build spot.
 *
 * Parts keep their rest *height* (only X/Z move), which matters in AR: the
 * group's vertical extent is unchanged, so the fit-to-height sizing in ar.js
 * still lands on a sensible scale even if AR is entered mid-puzzle.
 *
 * Order round the ring follows each part's natural bearing from the model
 * centre, so a piece is roughly scattered on the side it belongs to — the layout
 * stays spatially meaningful instead of random.
 *
 * opts.animate  – fly there instead of teleporting.
 * opts.stagger  – seconds between groups, released in *reverse* build order, so
 *                 the opening reads as the object being taken apart from the top
 *                 down. It also shows the learner the finished object once
 *                 before asking them to rebuild it.
 */
function scatter({ animate = false, stagger = 0 } = {}) {
  const { parts, radius } = state;

  // Which step each part belongs to — the teardown runs last-fitted-first.
  const rank = new Map();
  state.steps.forEach((s, k) => (s.indices || []).forEach((i) => rank.set(i, k)));
  const lastRank = Math.max(0, state.steps.length - 1);
  let maxDelay = 0;

  // Model centre in local space, from the union of the parts' geometry boxes.
  const box = new THREE.Box3();
  for (const p of parts) box.expandByPoint(p.center);
  box.getCenter(_center);

  const loose = parts.map((p, i) => i).filter((i) => !state.solved.has(i));
  loose.sort((a, b) => {
    const A = Math.atan2(parts[a].center.z - _center.z, parts[a].center.x - _center.x);
    const B = Math.atan2(parts[b].center.z - _center.z, parts[b].center.x - _center.x);
    return A - B;
  });

  loose.forEach((i, k) => {
    const angle = (k / loose.length) * Math.PI * 2;
    const r = radius * (RING_BASE + (k % 2) * RING_STAGGER);
    const home = new THREE.Vector3(
      _center.x + Math.cos(angle) * r - parts[i].center.x,
      0, // keep the part at its rest height
      _center.z + Math.sin(angle) * r - parts[i].center.z,
    );
    state.home.set(i, home);

    if (!animate) { parts[i].mesh.position.copy(home); return; }
    const delay = stagger ? (lastRank - (rank.get(i) ?? 0)) * stagger : 0;
    maxDelay = Math.max(maxDelay, delay);
    state.anim.set(i, { to: home.clone(), lambda: SCATTER_LAMBDA, flash: 0, shake: 0, delay });
  });

  // Hold the ghost back until the teardown clears, or the first slot's outline
  // would glow *inside* the part that is still sitting in it.
  if (stagger) state.ghostHold = maxDelay + 0.45;
}

// ---- Ghost slots -----------------------------------------------------------

function clearGhosts() {
  const g = state.ghostGroup;
  while (g.children.length) g.remove(g.children[0]); // geometry is borrowed — never dispose here
}

/** Draw a translucent shell + wireframe at every slot the current step still needs. */
function buildGhosts() {
  clearGhosts();
  const step = state.steps[state.stepIndex];
  if (!step) return;
  for (const i of step.indices) {
    if (state.solved.has(i)) continue;
    const geo = state.parts[i].mesh.geometry;
    const shell = new THREE.Mesh(geo, state.ghostMat);
    const wire = new THREE.Mesh(geo, state.ghostWire);
    shell.position.copy(state.parts[i].restPosition);
    wire.position.copy(state.parts[i].restPosition);
    shell.renderOrder = 998; wire.renderOrder = 999;
    state.ghostGroup.add(shell, wire);
  }
}

// ---- Distance to the current slot ------------------------------------------

/** Catch radius for a part: generous, and never smaller than the part deserves. */
function catchRadius(part) {
  return Math.max(state.radius * SNAP_FRACTION, part.radius * PART_FRACTION);
}

/**
 * Distance from a dragged part to the nearest slot of the current step.
 *
 * Nearest *slot*, not its own slot: a step is a semantic group (five casters,
 * five star-base arms), so dropping any caster onto any caster slot is right.
 * The learning is "which piece comes next", not "which of five identical wheels".
 */
function distanceToStep(index) {
  const step = state.steps[state.stepIndex];
  if (!step) return Infinity;
  partCenter(state.parts[index], _v);
  let best = Infinity;
  for (const j of step.indices) {
    if (state.solved.has(j)) continue;
    const d = _v.distanceTo(state.parts[j].center); // slot centre = rest centre
    if (d < best) best = d;
  }
  return best;
}

// ---- Interaction -----------------------------------------------------------

/**
 * The input-surface contract. Desktop (select.js) and AR (ar.js) both drive the
 * puzzle through this, handing over a world-space ray; nothing else is shared.
 * Rays may reuse caller-owned scratch vectors, so we read them and never retain.
 */
export const puzzleInteractor = {
  active: () => !!state,

  /** Try to pick up an unplaced part under the ray. Returns true if one was grabbed. */
  grab(ray) {
    if (!state || state.held) return false;
    const meshes = [];
    state.parts.forEach((p, i) => { if (!state.solved.has(i)) meshes.push(p.mesh); });
    if (!meshes.length) return false;

    raycaster.set(ray.origin, ray.direction);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return false;

    const index = hit.object.userData.partIndex;
    if (typeof index !== 'number' || state.solved.has(index)) return false;

    state.anim.delete(index); // cancel any fly-home in progress
    const mesh = state.parts[index].mesh;

    // Carry at the distance it was grabbed at, preserving the offset between the
    // hit point and the part's origin so it doesn't jump into the ray on pickup.
    state.held = {
      index,
      distance: hit.distance,
      // World-space, constant for the drag. Its own vector — never a shared
      // scratch, which the per-frame move() would otherwise clobber.
      offset: mesh.getWorldPosition(new THREE.Vector3()).sub(hit.point),
      raw: mesh.position.clone(),                // where the ray alone puts it (group-local)
      target: mesh.position.clone(),             // raw blended with the slot, chased with damping
      slot: mesh.position.clone(),               // the slot currently being aimed at
      assist: 0,                                 // 0…1 magnetism, ramped (see applyAssist)
      originLocal: new THREE.Vector3(),          // the carry ray in group space,
      dirLocal: new THREE.Vector3(),             // for the snap assist (zero until the first move)
    };
    state.captured = false;
    setHighlight(state.parts[index], true, CARRY_COLOR);
    state.cb.onCarry?.(index);
    return true;
  },

  /** Aim the carried part along a new ray (the part chases this, damped). */
  move(ray) {
    const h = state && state.held;
    if (!h) return;
    const g = state.group;
    g.updateWorldMatrix(true, false);

    _w.copy(ray.origin).addScaledVector(ray.direction, h.distance).add(h.offset);
    h.raw.copy(g.worldToLocal(_w)); // the assist blends this with the slot, per frame

    // Keep the ray itself in group space too — the snap assist needs to know
    // where the user is *aiming*, not just where the part currently hangs.
    h.originLocal.copy(ray.origin);
    g.worldToLocal(h.originLocal);
    h.dirLocal.copy(ray.origin).add(ray.direction);
    g.worldToLocal(h.dirLocal).sub(h.originLocal).normalize();
  },

  /** Push the carried part away from / towards the viewer (desktop wheel). */
  push(delta) {
    const h = state && state.held;
    if (!h) return;
    h.distance = Math.max(state.radius * 0.4, h.distance + delta);
  },

  /** Let go: snap, reject, or float back to the scatter ring. */
  release() {
    const h = state && state.held;
    if (!h) return;
    state.held = null;
    state.captured = false;

    const step = state.steps[state.stepIndex];
    const isTarget = !!step && step.indices.includes(h.index);
    const inSlot = distanceToStep(h.index) <= catchRadius(state.parts[h.index]);

    state.cb.onCarry?.(-1);

    if (inSlot && isTarget) { solveStep(false); return; }
    if (inSlot) { reject(h.index); return; }

    // Dropped nowhere near the slot — not an answer, just a misfire. No penalty.
    setHighlight(state.parts[h.index], false);
    sendHome(h.index);
  },
};

/**
 * Snap magnetism: once the user is *aiming* at a slot, pull the carried part
 * into it.
 *
 * Without this, a drag is helpless in the one axis it cannot express. The part
 * rides at the distance it was grabbed at, but the slot sits at the centre of
 * the scatter ring — up to a ring radius nearer or further away — so a pointer
 * that is dead-on in screen terms can still be a long way off in depth. So the
 * *reach* is measured perpendicular to the carry ray (am I pointing at the
 * hole?) while the *pull* is applied in all three axes, which slides the part
 * forward or back into place. It also does the work AR most needs: on a
 * hand-held phone, aim is much cheaper than fine depth control.
 *
 * Reach scales with the catch radius, so it stays honest — you still have to
 * pick the right part and point it at the right hole.
 */
function applyAssist(h, d) {
  const step = state.steps[state.stepIndex];
  const held = state.parts[h.index];
  const reach = catchRadius(held) * ASSIST_RADIUS;
  let bestPerp = Infinity;

  if (step && h.dirLocal.lengthSq() > 0.5) { // a ray exists (grabbed *and* moved)
    for (const j of step.indices) {
      if (state.solved.has(j)) continue;
      // Reach is measured against the slot *centre* — the ghost the user is
      // aiming at — not the mesh origin, which can sit well outside the shape.
      const slotCentre = state.parts[j].center;
      const along = _v.copy(slotCentre).sub(h.originLocal).dot(h.dirLocal);
      if (along <= 0) continue; // behind the viewer
      _w.copy(h.originLocal).addScaledVector(h.dirLocal, along);
      const perp = _w.distanceTo(slotCentre);
      // …but the pull goes to the mesh position that lands this part in that slot.
      if (perp < bestPerp) { bestPerp = perp; _best.copy(slotCentre).sub(held.center); }
    }
  }

  // Magnetism is a *persistent* blend, not a nudge: move() rewrites `raw` from
  // the live ray every frame, so anything applied straight to the target would
  // be thrown away again before it could accumulate.
  const want = bestPerp <= reach ? 1 - bestPerp / reach : 0;  // dead-on pulls hardest
  if (want > 0) h.slot.copy(_best);
  h.assist += (want - h.assist) * (1 - Math.exp(-ASSIST_LAMBDA * d)); // eases in and out

  h.target.copy(h.raw);
  if (h.assist > 0.001) h.target.lerp(h.slot, h.assist);
}

/** Fly a part back to its place in the scatter ring. */
function sendHome(index) {
  const to = state.home.get(index);
  if (to) state.anim.set(index, { to: to.clone(), lambda: RETURN_LAMBDA, flash: 0, shake: 0, delay: 0 });
}

/** Wrong part in the right hole: flash red, shake, send it home, tell the tutor. */
function reject(index) {
  const step = state.steps[state.stepIndex];
  setHighlight(state.parts[index], true, REJECT_COLOR);
  const to = state.home.get(index) || state.parts[index].restPosition;
  state.anim.set(index, {
    to: to.clone(), lambda: RETURN_LAMBDA,
    flash: REJECT_SECONDS,
    shake: state.radius * 0.05,
  });
  state.mistakes += 1;
  // Both names travel: `expected` is the canonical group name (stable across
  // languages, so telemetry stays comparable) and `expectedLabel` is what the
  // user should hear and read. main.js decides which is which.
  const fallback = step ? state.parts[step.indices[0]] : null;
  state.cb.onWrong?.({
    step,
    attempted: state.parts[index].name,
    expected: step ? (step.name || fallback?.name || '') : '',
    expectedLabel: step ? (step.label || step.name || fallback?.name || '') : '',
  });
}

/**
 * The step is solved: every part in the group settles into its own slot.
 *
 * Placing the whole group off one correct drop is deliberate. A step is a
 * semantic group and the chair has five casters and five base arms (the Markus
 * has fifteen caster pieces) — dragging each one individually is busywork that
 * teaches nothing after the first. Identify the piece once, the set follows.
 */
function solveStep(assisted) {
  const step = state.steps[state.stepIndex];
  if (!step) return;
  for (const i of step.indices) {
    setHighlight(state.parts[i], false);
    state.solved.add(i);
    state.anim.set(i, { to: state.parts[i].restPosition.clone(), lambda: SNAP_LAMBDA, flash: 0, shake: 0, delay: 0 });
  }
  clearGhosts();
  if (assisted) state.assists += 1;
  state.advanceIn = ADVANCE_SECONDS;
  state.cb.onCorrect?.({ step, index: state.stepIndex, assisted });
}

/** Solve the current step for the user — the "Place it for me" / voice fallback. */
export function puzzleAutoPlace() {
  if (!state || state.advanceIn > 0) return;
  if (state.held) { setHighlight(state.parts[state.held.index], false); state.held = null; }
  solveStep(true);
}

/** Which part indices the current step wants (for the Hint chip). */
export function puzzleHintIndices() {
  const step = state && state.steps[state.stepIndex];
  return step ? step.indices.filter((i) => !state.solved.has(i)) : [];
}

/** Snapshot for the card: step position, counts, and the active step. */
export function puzzleStatus() {
  if (!state) return null;
  return {
    stepIndex: state.stepIndex,
    total: state.steps.length,
    step: state.steps[state.stepIndex] || null,
    mistakes: state.mistakes,
    assists: state.assists,
    carrying: state.held ? state.held.index : -1,
  };
}

// ---- Per-frame -------------------------------------------------------------

/**
 * Drive the carried part, the tweens and the ghost pulse. Called every frame
 * from the render loop (desktop rAF and XRFrame alike) — a no-op when idle.
 */
export function updatePuzzle(dt) {
  if (!state) return;
  const d = Math.min(0.1, Math.max(0, dt));
  state.time += d;

  // Carried part chases its damped target. Exponential damping is frame-rate
  // independent, and it is what turns a jittery hand-held phone ray into a part
  // that feels weighty instead of twitchy.
  if (state.held) {
    const mesh = state.parts[state.held.index].mesh;
    applyAssist(state.held, d);
    mesh.position.lerp(state.held.target, 1 - Math.exp(-CARRY_LAMBDA * d));
    state.captured = distanceToStep(state.held.index) <= catchRadius(state.parts[state.held.index]);
  }

  // Tweens: scatter outward, fly home, settle into a slot, decay a shake.
  for (const [i, a] of [...state.anim]) {
    if (a.delay > 0) { a.delay -= d; continue; } // staggered teardown, not yet its turn
    const mesh = state.parts[i].mesh;
    mesh.position.lerp(a.to, 1 - Math.exp(-a.lambda * d));

    if (a.shake > 0) {
      mesh.position.x += Math.sin(state.time * 55) * a.shake;
      mesh.position.z += Math.cos(state.time * 47) * a.shake;
      a.shake *= Math.exp(-6 * d);
    }
    if (a.flash > 0) {
      a.flash -= d;
      if (a.flash <= 0) setHighlight(state.parts[i], false);
    }
    if (mesh.position.distanceTo(a.to) < state.radius * 0.002 && a.flash <= 0) {
      mesh.position.copy(a.to);
      state.anim.delete(i);
    }
  }

  if (state.ghostHold > 0) state.ghostHold -= d;
  state.ghostGroup.visible = state.ghostHold <= 0;

  // Ghost breathing, brighter once the carried part is inside the catch radius —
  // the only depth cue available in AR, where there is no real-world occlusion.
  // Opacity only, never scale: the ghost marks where the part must go, so moving
  // it — even by 2% — would move the target the user is aiming at.
  const pulse = 0.5 + 0.5 * Math.sin(state.time * 3.2);
  if (state.captured) {
    state.ghostMat.opacity = 0.42 + 0.12 * pulse;
    state.ghostWire.opacity = 0.85;
  } else {
    state.ghostMat.opacity = 0.16 + 0.08 * pulse;
    state.ghostWire.opacity = 0.35 + 0.15 * pulse;
  }

  // Arm the next step once the solved group has visibly settled.
  if (state.advanceIn > 0) {
    state.advanceIn -= d;
    if (state.advanceIn <= 0) {
      state.advanceIn = 0;
      state.stepIndex += 1;
      if (state.stepIndex >= state.steps.length) {
        state.cb.onComplete?.({ mistakes: state.mistakes, assists: state.assists });
      } else {
        // Re-ring what is left so the pile never crowds one side. Animated, and
        // without a stagger: the pieces glide to their new spots, so a learner
        // can keep track of the one they were eyeing instead of it teleporting.
        scatter({ animate: true });
        buildGhosts();
        state.cb.onStep?.({ index: state.stepIndex, step: state.steps[state.stepIndex] });
      }
    }
  }
}
