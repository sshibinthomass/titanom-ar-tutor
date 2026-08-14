import { findParts } from './explode.js';

/**
 * Semantic part naming for single-material models that split into generic,
 * numbered pieces (the office chair is one fused mesh → 20 unnamed islands).
 * Mapping the raw component index to a real part name makes the legend, Explore
 * labels, and keyword matching all work. Multiple islands can share a name
 * (5 casters, 5 base legs), so highlighting a name lights up the whole group.
 *
 * Indices come from the deterministic connected-component split of this exact
 * GLB (verified via bounding-box positions). If the model is re-exported, re-run
 * the split and re-check.
 */
export const SEMANTIC_NAMES = {
  'office-chair': {
    0: 'Backrest', 1: 'Backrest', 2: 'Backrest',
    3: 'Gas cylinder',
    4: 'Armrest', 5: 'Armrest',
    6: 'Height lever',
    7: 'Caster', 8: 'Caster', 9: 'Caster', 10: 'Caster', 11: 'Caster',
    12: 'Seat', 19: 'Seat',
    13: 'Star base', 14: 'Star base', 15: 'Star base', 16: 'Star base', 17: 'Star base',
    18: 'Base hub',
  },
};

/** Rename raw parts to semantic names for a model, if we have a mapping. */
export function applyNames(modelKey, parts) {
  const map = SEMANTIC_NAMES[modelKey];
  if (!map) return;
  parts.forEach((p, i) => {
    if (map[i]) { p.name = map[i]; p.label = map[i]; }
  });
}

/**
 * Mode definitions + per-model content.
 *
 * All modes ride the same core (explode + highlight/isolate + — later — voice).
 * Content references parts by *keyword*, resolved against the live part list at
 * runtime via findPart(), so it survives however the splitter cut the model.
 * When nothing matches (e.g. a model with no authored content yet), resolvers
 * fall back to a generic teardown so there is always something to demo.
 */

export const MODE_LIST = [
  { id: 'explore', label: '🔍 Explore', hint: 'Tap any part to isolate and read it.' },
  { id: 'fix', label: '🔧 Fix', hint: 'Step-by-step repair — Next / Back.' },
  { id: 'assemble', label: '🧩 Assemble', hint: 'Build it up one part at a time.' },
  { id: 'diagnose', label: '🩺 Diagnose', hint: 'Pick a symptom — find the likely part.' },
  { id: 'quiz', label: '❓ Quiz', hint: 'Name the highlighted part.' },
];

// ---- Authored content, keyed by model registry id --------------------------

const CONTENT = {
  bicycle: {
    fix: {
      title: 'Fix a flat tyre',
      steps: [
        { match: ['tire', 'tyre', 'rubber', 'wheel'], text: 'Fully deflate the tyre and unseat one bead from the rim with tyre levers.' },
        { match: ['tube', 'inner'], text: 'Pull the punctured inner tube out from under the tyre.' },
        { match: ['tire', 'tyre', 'rubber'], text: 'Run a finger inside the tyre to find the thorn or glass that caused it.' },
        { match: ['tube', 'inner'], text: 'Seat the new tube, partially inflated, evenly inside the tyre.' },
        { match: ['tire', 'tyre', 'rubber', 'wheel'], text: 'Work the bead back onto the rim, then inflate to the pressure on the sidewall.' },
      ],
    },
    diagnose: [
      { symptoms: ['squeal', 'squeak', 'noise', 'braking'], match: ['brake', 'chrome', 'pad', 'caliper'], text: 'A squeal under braking is almost always worn pads or a dirty rim. Highlighted is the braking area — check pad wear.' },
      { symptoms: ['slipping', 'chain', 'skipping', 'gears'], match: ['chain', 'gear', 'cog', 'sprocket', 'derailleur'], text: 'Chain slip usually means a stretched chain or worn cassette. Highlighted is the drivetrain.' },
      { symptoms: ['wobble', 'wheel', 'buckle', 'true'], match: ['wheel', 'rim', 'spoke'], text: 'A wobble is a wheel out of true — a bent rim or loose spokes. Highlighted is the wheel.' },
    ],
    quiz: [
      { match: ['frame'], question: 'Name this central triangular structure everything bolts to.', answer: 'frame' },
      { match: ['tire', 'tyre', 'rubber'], question: 'What is this round part that grips the road?', answer: 'tyre' },
      { match: ['seat', 'saddle'], question: 'What do you sit on — what is this called?', answer: 'saddle' },
      { match: ['chain'], question: 'What transfers your pedalling to the rear wheel?', answer: 'chain' },
    ],
  },

  'office-chair': {
    fix: {
      title: 'Fix a sinking chair — replace the gas lift',
      steps: [
        { match: ['seat', 'cushion', 'pan'], text: 'Detach the seat from the tilt mechanism by removing the seat-plate screws.' },
        { match: ['cylinder', 'gas', 'lift', 'piston', 'strut'], text: 'Separate the old gas cylinder from the seat mechanism and the star base.' },
        { match: ['base', 'star', 'foot', 'spider'], text: 'Stand the star base upright with all casters on the floor.' },
        { match: ['cylinder', 'gas', 'lift', 'piston', 'strut'], text: 'Drop the new gas cylinder into the cone of the star base.' },
        { match: ['seat', 'cushion', 'pan'], text: 'Refit the seat onto the cylinder and press down firmly to seat the taper.' },
      ],
    },
    diagnose: [
      { symptoms: ['sinking', 'sinks', 'drops', 'lowering'], match: ['cylinder', 'gas', 'lift', 'piston', 'strut'], text: 'A chair that slowly sinks has a failed gas cylinder — its internal seal leaks. Highlighted is the gas lift; it needs replacing.' },
      { symptoms: ['wobble', 'tilts', 'leaning', 'unstable'], match: ['base', 'star', 'foot', 'spider'], text: 'Wobble usually means a cracked star base or a loose caster. Highlighted is the base.' },
      { symptoms: ['rolling', 'stuck', 'caster', 'wheel'], match: ['wheel', 'caster', 'roller'], text: 'Rolling trouble is a jammed or broken caster. Highlighted is the wheel set — pop it out and swap it.' },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift', 'strut'], question: 'What part lets you raise and lower the seat?', answer: 'the gas cylinder (pneumatic lift)' },
      { match: ['star base', 'star', 'spider'], question: 'What is the five-armed part on the floor called?', answer: 'the star base' },
      { match: ['caster', 'wheel', 'roller'], question: 'What are the rolling parts called?', answer: 'casters' },
      { match: ['backrest'], question: 'What part supports your back?', answer: 'the backrest' },
    ],
  },

  // Placeholder for the radial engine — tune keywords once the GLB is in.
  engine: {
    fix: {
      title: 'Replace a piston',
      steps: [
        { match: ['cylinder', 'head'], text: 'Remove the cylinder head bolts to expose the piston.' },
        { match: ['piston'], text: 'Slide the old piston out of its bore.' },
        { match: ['ring'], text: 'Fit new rings, gaps staggered around the piston.' },
        { match: ['piston'], text: 'Insert the new piston squarely into the bore.' },
        { match: ['cylinder', 'head'], text: 'Refit the head and torque the bolts in a cross pattern.' },
      ],
    },
    diagnose: [
      { symptoms: ['power', 'weak', 'compression'], match: ['piston', 'ring', 'cylinder'], text: 'Low power points to compression loss — worn rings or a scored bore. Highlighted is the piston assembly.' },
      { symptoms: ['knock', 'noise', 'rattle'], match: ['crank', 'bearing', 'rod'], text: 'A knock under load is often a rod or main bearing. Highlighted is the rotating assembly.' },
    ],
    quiz: [
      { match: ['piston'], question: 'What part travels up and down inside the cylinder?', answer: 'piston' },
      { match: ['crank'], question: 'What converts the pistons’ motion into rotation?', answer: 'crankshaft' },
    ],
  },
};

// ---- Resolvers: turn keyword content into concrete part indices ------------

// Assemble order by semantic group, bottom-up, for models we have names for.
const ASSEMBLE_ORDER = {
  'office-chair': ['Star base', 'Caster', 'Base hub', 'Gas cylinder', 'Seat', 'Backrest', 'Armrest', 'Height lever'],
};
const ASSEMBLE_TEXT = {
  'Star base': 'Lay out the five-armed star base.',
  'Caster': 'Press a caster into the end of each base arm.',
  'Base hub': 'Fit the central hub into the base.',
  'Gas cylinder': 'Drop the gas cylinder into the base cone.',
  'Seat': 'Lower the seat onto the cylinder and press to seat the taper.',
  'Backrest': 'Bolt the backrest to the seat mechanism.',
  'Armrest': 'Attach the left and right armrests.',
  'Height lever': 'Clip on the height-adjust lever. Done!',
};

/** Fix procedure → { title, steps:[{ indices, text }] }. */
export function resolveFix(modelKey, parts) {
  const authored = CONTENT[modelKey]?.fix;
  if (authored) {
    return {
      title: authored.title,
      steps: authored.steps.map((s) => ({ indices: findParts(parts, s.match), text: s.text })),
    };
  }
  return genericTeardown(parts);
}

/**
 * Assemble = build-up. For models with a semantic order, reveal one group per
 * step (each step's `indices` are the parts ADDED that step). Otherwise reveal
 * the biggest parts one at a time.
 */
export function resolveAssemble(modelKey, parts) {
  const order = ASSEMBLE_ORDER[modelKey];
  if (order) {
    const steps = [];
    for (const groupName of order) {
      const indices = parts.map((p, i) => (p.name === groupName ? i : -1)).filter((i) => i >= 0);
      if (indices.length) steps.push({ indices, text: ASSEMBLE_TEXT[groupName] || `Attach the ${groupName.toLowerCase()}.` });
    }
    return { title: 'Assemble the chair', steps };
  }
  const steps = parts.map((p, i) => ({
    indices: [i],
    text: i === 0 ? 'Start with the largest part as the base.' : `Attach the next part: ${p.name}.`,
  }));
  return { title: 'Assemble from parts', steps };
}

/** Diagnose entries → [{ symptoms, indices, text }]. */
export function resolveDiagnose(modelKey, parts) {
  const entries = CONTENT[modelKey]?.diagnose ?? [];
  return entries.map((e) => ({ symptoms: e.symptoms, indices: findParts(parts, e.match), text: e.text }));
}

/** Quiz entries → [{ indices, question, answer }] (only those that matched parts). */
export function resolveQuiz(modelKey, parts) {
  const entries = CONTENT[modelKey]?.quiz ?? [];
  return entries
    .map((e) => ({ indices: findParts(parts, e.match), question: e.question, answer: e.answer }))
    .filter((e) => e.indices.length > 0);
}

function genericTeardown(parts) {
  const n = Math.min(parts.length, 6);
  const steps = [];
  for (let i = 0; i < n; i++) steps.push({ indices: [i], text: `Remove ${parts[i].name}.` });
  return { title: 'Teardown', steps };
}
