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

  // IKEA Markus — a 'group'-mode model: 47 separate meshes, so the part index is
  // the mesh's rank by triangle count (largest first), per buildExplodedView's
  // sort. Mapping verified from each part's world-space bbox: the signature high
  // mesh back (its own material) + headrest sit at the top; seat/tilt in the
  // middle; gas lift, star base and 5 casters (each caster = wheel + housing +
  // stem, so 3 islands apiece → 15 caster parts) at the bottom. Several tiny
  // 1-triangle slivers at the recline pivot (37–46) are folded into 'Tilt
  // mechanism' so no group is left hidden in Assemble. Every group here was
  // confirmed visually by highlighting it in Blender. Re-export ⇒ re-run the
  // split (window.__parts) and re-map.
  'markus-chair': {
    0: 'Backrest',
    1: 'Tilt mechanism',
    2: 'Seat',
    3: 'Armrest', 4: 'Armrest',
    5: 'Headrest',
    6: 'Armrest', 7: 'Armrest', 8: 'Armrest', 9: 'Armrest',
    10: 'Height lever',
    11: 'Caster', 12: 'Caster', 13: 'Caster', 14: 'Caster', 15: 'Caster',
    16: 'Mesh back', 17: 'Mesh back',
    18: 'Star base',
    19: 'Gas cylinder',
    20: 'Armrest', 21: 'Armrest',
    22: 'Tilt mechanism',
    23: 'Caster', 24: 'Caster', 25: 'Caster', 26: 'Caster', 27: 'Caster',
    28: 'Caster', 29: 'Caster', 30: 'Caster', 31: 'Caster', 32: 'Caster',
    33: 'Armrest', 34: 'Armrest', 35: 'Armrest', 36: 'Armrest',
    37: 'Tilt mechanism', 38: 'Tilt mechanism', 39: 'Tilt mechanism',
    40: 'Tilt mechanism', 41: 'Tilt mechanism', 42: 'Tilt mechanism',
    43: 'Tilt mechanism', 44: 'Tilt mechanism', 45: 'Tilt mechanism',
    46: 'Tilt mechanism',
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
    // Diagnose = symptom → likely part. symptoms[0] is the chip label; every
    // string in the array is also a voice-match keyword (spoken transcript is
    // substring-matched against them, so include short single words, not just
    // the display phrase). `match` targets a part by name.includes() — note
    // 'base' would hit BOTH "Star base" and "Base hub", so we use 'star' and
    // 'hub' to keep them distinct. Ordered most-common first; keep single-word
    // keywords unique across entries so voice picks the intended symptom.
    diagnose: [
      {
        symptoms: ['Seat keeps sinking', 'sinking', 'sinks', 'drops', 'lowering', 'goes down', 'losing height', 'wont stay up'],
        match: ['cylinder', 'gas', 'lift', 'piston', 'strut'],
        text: 'A seat that slowly sinks under your weight is a failed gas cylinder — the pneumatic seal has lost its charge. It cannot be refilled, so swap the whole gas lift. Highlighted is the cylinder.',
      },
      {
        symptoms: ['Won\'t rise', 'wont rise', 'wont go up', 'wont raise', 'wont lift', 'stays down', 'stuck low'],
        match: ['cylinder', 'gas', 'lift', 'piston', 'strut'],
        text: 'If pressing the lever no longer raises the seat, the gas cylinder has lost its pressure completely. First confirm the lever actually pushes the valve pin; if it does, replace the gas lift. Highlighted is the cylinder.',
      },
      {
        symptoms: ['Height lever stuck', 'lever', 'paddle', 'wont adjust', 'height stuck', 'cant change height'],
        match: ['lever', 'height'],
        text: 'No height change when you lift the paddle points to a stuck or disconnected height lever — its linkage is not pressing the cylinder valve pin. Check the arm or cable down to the valve. Highlighted is the height lever.',
      },
      {
        symptoms: ['Chair wobbles', 'wobble', 'wobbles', 'unstable', 'rocking', 'leaning', 'tilts', 'shaky'],
        match: ['star'],
        text: 'Side-to-side wobble usually means a cracked or flexing star base, or one arm not sitting flat. Set it on hard floor and press each arm to find the give. Highlighted is the star base.',
      },
      {
        symptoms: ['Cracked base', 'crack', 'cracked', 'split base', 'broken base', 'snapped'],
        match: ['star'],
        text: 'A visible crack in a plastic star base is a safety risk and cannot be reliably glued — replace the base. A metal base can sometimes be re-welded. Highlighted is the star base.',
      },
      {
        symptoms: ['Won\'t roll', 'jammed', 'stuck wheel', 'dragging', 'hard to move', 'wont roll', 'caught'],
        match: ['caster', 'wheel', 'roller'],
        text: 'A chair that drags or will not roll has a jammed caster — usually hair and carpet fibre wound around the axle. Pop the caster out, clear it, or swap in a new one. Highlighted is the caster set.',
      },
      {
        symptoms: ['Rolls away', 'rolls away', 'drifts', 'slides', 'wont stay put', 'rolls on its own'],
        match: ['caster', 'wheel', 'roller'],
        text: 'A chair that rolls on its own has worn casters or the wrong wheel for the floor — fit braked casters, or the correct hard-floor or carpet type. Highlighted is the caster set.',
      },
      {
        symptoms: ['Squeaks and creaks', 'squeak', 'squeaks', 'creak', 'noise', 'clicking', 'grinding'],
        match: ['hub'],
        text: 'Squeaks and creaks come from the central mechanism and swivel — the tilt springs, the seat-plate bolts, or the cylinder top bearing. Tighten the under-seat bolts and grease the swivel. Highlighted is the base hub.',
      },
      {
        symptoms: ['Won\'t swivel', 'wont swivel', 'wont turn', 'stiff swivel', 'hard to turn', 'seized'],
        match: ['hub'],
        text: 'A seat that will not rotate has a seized swivel bearing in the base hub, usually dry or rust-bound. Lift the seat off and grease the bearing race. Highlighted is the base hub.',
      },
      {
        symptoms: ['Loose backrest', 'backrest', 'back wobbles', 'wont recline', 'reclines too far', 'floppy back'],
        match: ['backrest'],
        text: 'A loose or free-flopping backrest is loose mounting bolts or a worn recline-tension knob on the back bracket. Tighten the bracket bolts and reset the tension. Highlighted is the backrest.',
      },
      {
        symptoms: ['Loose armrest', 'armrest', 'arm wobbles', 'arm loose', 'broken arm'],
        match: ['armrest', 'arm'],
        text: 'A wobbly armrest is almost always loose bolts under the seat pan where the arm mounts. Tighten them; if the arm itself is cracked, replace it. Highlighted is the armrest.',
      },
      {
        symptoms: ['Seat wobbles', 'seat loose', 'seat rocks', 'loose seat', 'seat moves'],
        match: ['seat'],
        text: 'A seat that rocks but does not sink is loose seat-plate bolts between the cushion and the tilt mechanism. Flip the chair and tighten the four mounting bolts. Highlighted is the seat.',
      },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift', 'strut'], question: 'What part lets you raise and lower the seat?', answer: 'the gas cylinder (pneumatic lift)' },
      { match: ['star base', 'star', 'spider'], question: 'What is the five-armed part on the floor called?', answer: 'the star base' },
      { match: ['caster', 'wheel', 'roller'], question: 'What are the rolling parts called?', answer: 'casters' },
      { match: ['backrest'], question: 'What part supports your back?', answer: 'the backrest' },
    ],
  },

  'markus-chair': {
    // Verified product facts (IKEA Markus, Vissle dark grey, art. 702.611.50).
    // Grounds the AI tutor so free-form questions about materials, capacity and
    // adjustments are answered from the real chair, not generic guesses.
    about: 'The IKEA Markus (designer Henrik Preutz) is a high-back swivel office chair. Its backrest is a breathable Vissle dark-grey mesh of recycled polyester over a powder-coated steel frame, with built-in lumbar support and a fixed headrest at the top. The armrests are fixed, padded in polypropylene and synthetic rubber. The seat is polyurethane foam over a laminated wood base, raised and lowered by a pneumatic gas lift. The five-star foot is powder-coated aluminium on self-braking casters that lock when you stand up. It has a synchronised tilt that locks in three positions with a manual tension knob under the seat, a seat-height range of 46–57 cm, and a rated capacity of 110 kg.',
    fix: {
      title: 'Fix a sinking Markus — replace the gas lift',
      steps: [
        { match: ['seat'], text: 'Tip the chair on its side and take out the four screws holding the seat plate to the tilt mechanism.' },
        { match: ['cylinder', 'gas', 'lift'], text: 'Twist the seat off the gas cylinder, then knock the cylinder out of the star base with a rubber mallet.' },
        { match: ['star'], text: 'Stand the five-star base upright with all five casters flat on the floor.' },
        { match: ['cylinder', 'gas', 'lift'], text: 'Drop the new gas lift into the cone of the star base, wide collar down.' },
        { match: ['seat'], text: 'Refit the seat and tilt mechanism onto the cylinder, then sit on it to lock the taper.' },
      ],
    },
    // symptoms[0] is the chip label; every string is also a voice-match keyword
    // (spoken transcript is substring-matched), so keep single words unique across
    // entries. `match` hits a part by name.includes() — 'back' would light BOTH
    // "Backrest" and "Mesh back", so use 'backrest' vs 'mesh' to keep them apart.
    diagnose: [
      {
        symptoms: ['Seat keeps sinking', 'sinking', 'sinks', 'drops', 'lowering', 'goes down', 'losing height'],
        match: ['cylinder', 'gas', 'lift'],
        text: 'A Markus that slowly sinks under your weight has a failed gas cylinder — the pneumatic seal has lost its charge and cannot be refilled. Swap the whole gas lift. Highlighted is the gas cylinder.',
      },
      {
        symptoms: ['Won\'t rise', 'wont rise', 'wont go up', 'wont raise', 'stays down', 'stuck low'],
        match: ['cylinder', 'gas', 'lift'],
        text: 'If the paddle no longer raises the seat, the gas cylinder has lost its pressure completely. Confirm the lever actually pushes the valve pin; if it does, replace the gas lift. Highlighted is the gas cylinder.',
      },
      {
        symptoms: ['Backrest won\'t lock', 'wont lock', 'recline', 'wont hold', 'flops back', 'no lock'],
        match: ['tilt'],
        text: 'A back that will not stay upright is the tilt lock not engaging — the side lever is not catching the ratchet. Free the lever and check its linkage into the tilt mechanism. Highlighted is the tilt mechanism.',
      },
      {
        symptoms: ['Reclines too easily', 'too easy', 'too loose', 'tips back', 'tension', 'springs back'],
        match: ['tilt'],
        text: 'A back that snaps forward or leans too freely is the tilt tension wound too loose. Turn the knob under the front of the seat clockwise to add resistance. Highlighted is the tilt mechanism.',
      },
      {
        symptoms: ['Chair wobbles', 'wobble', 'wobbles', 'unstable', 'rocking', 'shaky'],
        match: ['star'],
        text: 'Side-to-side wobble usually means a cracked or flexing star base, or one arm not sitting flat. Set it on hard floor and press each arm to find the give. Highlighted is the star base.',
      },
      {
        symptoms: ['Cracked base', 'crack', 'cracked', 'split base', 'broken base', 'snapped'],
        match: ['star'],
        text: 'A visible crack in the star base is a safety risk. Markus bases are metal and can sometimes be re-welded, but replacement is safer. Highlighted is the star base.',
      },
      {
        symptoms: ['Won\'t roll', 'jammed', 'stuck wheel', 'dragging', 'hard to move', 'wont roll'],
        match: ['caster', 'wheel', 'roller'],
        text: 'A chair that drags has a jammed caster — usually hair and carpet fibre wound around the axle. Pop the caster out, clear it, or swap in a new one. Highlighted is the caster set.',
      },
      {
        symptoms: ['Rolls away', 'rolls away', 'drifts', 'slides', 'wont stay put'],
        match: ['caster', 'wheel', 'roller'],
        text: 'A chair that rolls on its own has worn casters or the wrong wheel for the floor — fit braked casters, or the correct hard-floor or carpet type. Highlighted is the caster set.',
      },
      {
        symptoms: ['Squeaks and creaks', 'squeak', 'squeaks', 'creak', 'noise', 'clicking', 'grinding'],
        match: ['tilt'],
        text: 'Squeaks and creaks come from the tilt mechanism and swivel — dry springs, loose seat-plate bolts, or the cylinder top bearing. Tighten the under-seat bolts and grease the pivot. Highlighted is the tilt mechanism.',
      },
      {
        symptoms: ['Headrest slips', 'headrest', 'head rest', 'wont stay up', 'slides down', 'wont adjust'],
        match: ['headrest'],
        text: 'A headrest that sinks or will not hold its angle has a worn friction joint at its stem. Tighten the headrest bracket; if the ratchet is stripped, the headrest is replaced as a unit. Highlighted is the headrest.',
      },
      {
        symptoms: ['Loose armrest', 'armrest', 'arm wobbles', 'arm loose', 'broken arm'],
        match: ['armrest', 'arm'],
        text: 'A wobbly armrest is almost always loose bolts under the seat pan where the arm mounts. Tighten them; if the arm itself is cracked, replace it. Highlighted is the armrest.',
      },
      {
        symptoms: ['Mesh sagging', 'mesh', 'saggy', 'stretched', 'baggy back', 'worn mesh'],
        match: ['mesh'],
        text: 'A sagging or stretched mesh back has lost its tension and cannot be re-tightened — the mesh is bonded to the frame. Replace the back assembly. Highlighted is the mesh back.',
      },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift'], question: 'What part lets you raise and lower the seat?', answer: 'the gas cylinder (pneumatic lift)' },
      { match: ['star'], question: 'What is the five-armed part on the floor called?', answer: 'the star base' },
      { match: ['caster', 'wheel', 'roller'], question: 'What are the rolling parts called?', answer: 'casters' },
      { match: ['headrest'], question: 'What supports your head at the very top of the chair?', answer: 'the headrest' },
      { match: ['mesh'], question: 'What is the breathable part your back rests against?', answer: 'the mesh back' },
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
  // Every semantic group must appear here — in Assemble, a part in no step stays
  // hidden. Bottom-up build order.
  'markus-chair': ['Star base', 'Caster', 'Gas cylinder', 'Tilt mechanism', 'Height lever', 'Seat', 'Armrest', 'Backrest', 'Mesh back', 'Headrest'],
};
const ASSEMBLE_TEXT = {
  'Star base': 'Lay out the five-armed star base.',
  'Caster': 'Press a caster into the end of each base arm.',
  'Base hub': 'Fit the central hub into the base.',
  'Gas cylinder': 'Drop the gas cylinder into the base cone.',
  'Tilt mechanism': 'Bolt the tilt mechanism onto the top of the gas cylinder.',
  'Seat': 'Lower the seat onto the cylinder and press to seat the taper.',
  'Backrest': 'Bolt the tall backrest frame to the tilt mechanism.',
  'Mesh back': 'Stretch the breathable mesh onto the backrest frame.',
  'Armrest': 'Attach the left and right armrests.',
  'Headrest': 'Clip the headrest onto the top of the backrest.',
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

/**
 * A compact, spoken-friendly digest of everything we've authored about a model:
 * the repair procedure and every symptom → cause → fix. Handed to the AI tutor
 * as grounding so free-form questions ("why does it sink?", "how do I fix the
 * wobble?", "what makes it squeak?") are answered from THIS chair's real faults
 * and repairs, not generic guesses — while the canned chips stay for a reliable
 * tap/voice demo. The UI-only "Highlighted is the X." tail is stripped so the AI
 * doesn't parrot it. Returns '' when a model has no authored content.
 */
export function knowledgeDigest(modelKey) {
  const c = CONTENT[modelKey];
  if (!c) return '';
  const clean = (s) => s.replace(/\s*Highlighted is[^.]*\.\s*$/i, '').trim();
  const lines = [];
  if (c.about) lines.push(c.about);
  if (c.fix?.title) {
    lines.push(`Repair procedure — ${c.fix.title}: ${c.fix.steps.map((s) => clean(s.text)).join(' ')}`);
  }
  if (c.diagnose?.length) {
    lines.push('Known faults (symptom — cause and fix): ' +
      c.diagnose.map((d) => `${d.symptoms[0]}: ${clean(d.text)}`).join(' '));
  }
  return lines.join(' ');
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
