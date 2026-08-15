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
  // sort. EVERY index below was identified visually: each part was highlighted
  // alone in a Blender render and matched against the official IKEA assembly
  // manual (AA-251870-21). Notable identifications: the right paddle (8) is the
  // height lever and the left (9) the recline lock — per the manual's use page —
  // with their shafts at 20/21; the egg-shaped knob under the seat front (10) is
  // the tilt tension knob; each caster is 3 islands (twin wheels / press-fit
  // stem / brake hood → 15 parts); the mesh back is two stacked layers (17
  // front, 16 rear); and the ten 1-triangle strips (37–46) sit hidden BETWEEN
  // the mesh layers at belt height — the built-in lumbar support band.
  // Duplicate names below = genuinely identical hardware or fragments of one
  // piece. Re-export ⇒ re-run the split (window.__parts) and re-map.
  'markus-chair': {
    0: 'Backrest frame',
    1: 'Tilt mechanism frame',
    2: 'Seat',
    3: 'Armrest frame (right)', 4: 'Armrest frame (left)',
    5: 'Headrest',
    6: 'Armrest pad (left)', 7: 'Armrest pad (right)',
    8: 'Height lever', 9: 'Recline lock lever',
    10: 'Tilt tension knob',
    11: 'Caster wheels', 12: 'Caster wheels', 13: 'Caster wheels', 14: 'Caster wheels', 15: 'Caster wheels',
    16: 'Mesh panel (rear)', 17: 'Mesh panel (front)',
    18: 'Star base',
    19: 'Gas cylinder',
    20: 'Height lever shaft', 21: 'Recline lock shaft',
    22: 'Tilt mechanism plate',
    23: 'Caster stem', 24: 'Caster stem', 25: 'Caster stem', 26: 'Caster stem', 27: 'Caster stem',
    28: 'Caster brake hood', 29: 'Caster brake hood', 30: 'Caster brake hood', 31: 'Caster brake hood', 32: 'Caster brake hood',
    33: 'Armrest bolt cap (left)', 34: 'Armrest bolt cap (left)',
    35: 'Armrest bolt cap (right)', 36: 'Armrest bolt cap (right)',
    37: 'Lumbar support band', 38: 'Lumbar support band', 39: 'Lumbar support band',
    40: 'Lumbar support band', 41: 'Lumbar support band', 42: 'Lumbar support band',
    43: 'Lumbar support band', 44: 'Lumbar support band', 45: 'Lumbar support band',
    46: 'Lumbar support band',
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
    // Grounding digest for the AI tutor — built ONLY from checked sources so
    // answers come from the real chair, not model guesses: the official IKEA
    // assembly manual AA-251870-21 (hardware IDs, steps, safety pages), the
    // ikea.com MARKUS product page (materials, dimensions), the Instructables
    // "IKEA Markus Assembly Guide", and the manuall.co.uk MARKUS page
    // (owner FAQ: common failures and spares).
    about: 'The IKEA Markus (designer Henrik Preutz, art. 702.611.50) is a high-back swivel office chair rated to 110 kg, certified EN 1335, with a 10-year warranty. Backrest: breathable Vissle dark-grey mesh (100% polyester, min 90% recycled) in two layers over a powder-coated steel frame, with a lumbar support band sewn in at belt height and a fixed headrest. Armrests: fixed height (no adjustable version exists), identical left/right, padded with polypropylene and synthetic rubber. Seat: 35 kg/m³ polyurethane foam on laminated wood veneer. Base: powder-coated aluminium five-star on twin-wheel safety casters that brake automatically when nobody sits in the chair, so it never rolls away when you stand up. Controls: the RIGHT paddle under the seat is the height lever (lift while seated to sink, unweight to rise, 46–57 cm); the LEFT lever is the recline lock — the backrest is sprung forward, unlock to rock, lock upright (3 positions); the knob under the seat front-centre sets tilt tension (turn + for more resistance, − for less). Assembly hardware (manual AA-251870-21): 6 countersunk screws #122134, 5 flange bolts #115994 (2 fix the tilt mechanism to the seat, 3 fix the backrest bracket), one allen key #124345, 5 press-in casters #100049021 — push casters straight in, never at an angle; pull the transport cap off the gas cylinder before fitting; start all 3 backrest bolts loosely before tightening; lowering the assembled chair onto the cylinder is a two-person lift. IKEA warns that only trained personnel may replace or repair the gas spring (energy accumulator). Known aging failures from owners: the gas lift loses pressure (replaceable, standard taper fit), the tilt-mechanism frame can crack after years of heavy use, and taper joints seize — freeing the cylinder from the seat mechanism or base needs firm taps with a rubber mallet.',
    fix: {
      title: 'Fix a sinking Markus — replace the gas lift',
      steps: [
        { match: ['seat'], text: 'Tip the chair on its side and undo the tilt-mechanism fasteners under the seat: two flange bolts and two countersunk screws, using the allen key that came with the chair.' },
        { match: ['cylinder', 'gas', 'lift'], text: 'Free the old cylinder from the mechanism plate — the taper joint seizes over time, so tap the plate around the cone with a rubber mallet, never pry against the seat.' },
        { match: ['star'], text: 'Knock the cylinder out of the star base the same way, then stand the base upright with all five casters flat on the floor.' },
        { match: ['cylinder', 'gas', 'lift'], text: 'Drop the new gas lift into the base cone, thin end down — and if it shipped with a transport cap, pull that off first.' },
        { match: ['seat'], text: 'Refit the seat and mechanism onto the cylinder and sit down firmly — your weight locks the taper. IKEA notes gas-spring service is for trained hands, so work carefully.' },
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
        match: ['recline'],
        text: 'The Markus backrest is sprung forward and held by the LEFT-hand lever — the recline lock, which holds one of three positions. If the back will not stay upright, the lock is not engaging: work the left lever and check its shaft into the mechanism. Highlighted is the recline lock.',
      },
      {
        symptoms: ['Reclines too easily', 'too easy', 'too loose', 'tips back', 'tension', 'springs back'],
        match: ['tension'],
        text: 'A back that leans too freely or snaps forward is the tilt tension set too loose for your weight. Find the knob under the front-centre of the seat and turn it toward + for more resistance, − for less. Highlighted is the tension knob.',
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
        text: 'Markus casters are safety casters — they brake automatically when nobody is sitting, so an empty chair should never drift. If it rolls away on its own, a brake hood is worn or jammed: pop that caster out and replace it (IKEA part 100049021). Highlighted is the caster set.',
      },
      {
        symptoms: ['Squeaks and creaks', 'squeak', 'squeaks', 'creak', 'noise', 'clicking', 'grinding'],
        match: ['tilt'],
        text: 'Squeaks and creaks come from the tilt mechanism and swivel — dry springs, loose fasteners on the seat plate, or the cylinder top bearing. Snug the two flange bolts and two screws under the seat with the allen key, and grease the pivot. Highlighted is the tilt mechanism.',
      },
      {
        symptoms: ['Headrest slips', 'headrest', 'head rest', 'wont stay up', 'slides down', 'wont adjust'],
        match: ['headrest'],
        text: 'A headrest that sinks or will not hold its angle has a worn friction joint at its stem. Tighten the headrest bracket; if the ratchet is stripped, the headrest is replaced as a unit. Highlighted is the headrest.',
      },
      {
        symptoms: ['Loose armrest', 'armrest', 'arm wobbles', 'arm loose', 'broken arm'],
        match: ['armrest', 'arm'],
        text: 'Each Markus armrest is held by two countersunk screws into the seat side — a wobbly arm means they have worked loose, so snug them with the allen key. The arms are identical left/right and fixed height; no adjustable version exists. Highlighted is the armrest.',
      },
      {
        symptoms: ['Mesh sagging', 'mesh', 'saggy', 'stretched', 'baggy back', 'worn mesh'],
        match: ['mesh'],
        text: 'A sagging or stretched mesh back has lost its tension and cannot be re-tightened — the two mesh layers are fixed to the frame with the lumbar band sewn between them. Replace the back assembly. Highlighted is the mesh back.',
      },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift'], question: 'What part lets you raise and lower the seat?', answer: 'the gas cylinder (pneumatic lift)' },
      { match: ['star'], question: 'What is the five-armed part on the floor called?', answer: 'the star base' },
      { match: ['caster', 'wheel', 'roller'], question: 'What are the rolling parts called?', answer: 'casters — safety casters that brake when the chair is empty' },
      { match: ['recline'], question: 'Which control locks the backrest upright?', answer: 'the left-hand recline lock lever' },
      { match: ['tension'], question: 'What sets how hard the chair resists leaning back?', answer: 'the tilt tension knob under the seat front' },
      { match: ['headrest'], question: 'What supports your head at the very top of the chair?', answer: 'the headrest' },
      { match: ['mesh'], question: 'What is the breathable part your back rests against?', answer: 'the Vissle mesh back' },
      { match: ['lumbar'], question: 'What is sewn between the mesh layers at belt height?', answer: 'the lumbar support band' },
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
/**
 * The *question* asked before each Assemble step, and the deliberate inverse of
 * the step's `text` below.
 *
 * Assemble is a drag-to-build puzzle: the user has to pick the right piece out
 * of the scattered parts, so the prompt describes the piece by its job or its
 * position and never names it. The step text is spoken *after* a correct
 * placement — as confirmation, not as an instruction. Recall first, label
 * second; a prompt that gives the answer away reduces the puzzle to fetching.
 *
 * Keyed by the same `group` string as ASSEMBLE_STEPS. A group with no prompt
 * falls back to a bare "Which part goes on next?", so adding a step never breaks
 * the puzzle — it just asks less well.
 */
const ASSEMBLE_PROMPT = {
  'Star base': 'Start at the floor. Which piece spreads your weight out to five points?',
  'Caster': 'What makes it roll? Five of these press into the ends of the base arms.',
  'Base hub': 'Which piece caps the centre of the base so the chair can swivel?',
  'Gas cylinder': 'What drops into the cone in the middle to raise and lower you?',
  'Tilt': 'Which block bolts under the seat and lets the chair rock back?',
  'Height lever': 'Which paddle do you lift to change the seat height?',
  'Recline lock': 'Which lever holds the backrest still instead of letting it rock?',
  'Seat': 'What do you actually sit on?',
  'Backrest': 'Which frame carries your back?',
  'Mesh panel': 'What stretches across the back frame to keep you cool?',
  'Lumbar': 'Which band sits at belt height, supporting the small of your back?',
  'Armrest': 'Where do your forearms rest? One goes on each side.',
  'Headrest': 'What tops the backrest to support your head?',
};

// Each step's `group` matches parts whose name equals it OR starts with it plus
// a space — so one step can reveal a whole family of distinct part names
// ('Caster' → Caster wheels / Caster stem / Caster brake hood). Every part must
// be caught by some step: in Assemble, an unmatched part stays hidden.
const ASSEMBLE_STEPS = {
  'office-chair': [
    { group: 'Star base', text: 'Lay out the five-armed star base.' },
    { group: 'Caster', text: 'Press a caster into the end of each base arm.' },
    { group: 'Base hub', text: 'Fit the central hub into the base.' },
    { group: 'Gas cylinder', text: 'Drop the gas cylinder into the base cone.' },
    { group: 'Seat', text: 'Lower the seat onto the cylinder and press to seat the taper.' },
    { group: 'Backrest', text: 'Bolt the backrest to the seat mechanism.' },
    { group: 'Armrest', text: 'Attach the left and right armrests.' },
    { group: 'Height lever', text: 'Clip on the height-adjust lever. Done!' },
  ],
  // Follows the official IKEA manual AA-251870-21, steps 1–11.
  'markus-chair': [
    { group: 'Star base', text: 'Lay the five-arm aluminium star base upside-down on a rug (manual step 1).' },
    { group: 'Caster', text: 'Press all five safety casters straight into the base arms — square, never at an angle (step 1).' },
    { group: 'Gas cylinder', text: 'Pull the transport cap off the gas cylinder, discard it, and drop the cylinder into the base cone, thin end down (steps 2–3).' },
    { group: 'Tilt', text: 'Bolt the tilt mechanism to the seat underside: two flange bolts #115994, then two countersunk screws #122134, snugged with the allen key (steps 4–6).' },
    { group: 'Height lever', text: 'The right-hand paddle is the height lever — it comes fitted to the mechanism. Lift it while seated to sink, unweight the seat to rise.' },
    { group: 'Recline lock', text: 'The left-hand lever is the recline lock. The backrest is sprung forward: unlock to rock freely, lock to hold one of three positions.' },
    { group: 'Seat', text: 'The seat — foam on laminated wood — now carries the whole mechanism on its underside.' },
    { group: 'Backrest', text: 'Slide the backrest\'s L-bracket into the seat slot and start all three flange bolts loosely before tightening any — the holes align one at a time (steps 8–9).' },
    { group: 'Mesh panel', text: 'The Vissle mesh comes factory-tensioned over the frame in two layers, front and rear.' },
    { group: 'Lumbar', text: 'The lumbar support band is sewn between the mesh layers at belt height — built in, nothing to attach.' },
    { group: 'Armrest', text: 'Slide each armrest down over the seat edge and fix it with two countersunk screws per side — left and right arms are identical (steps 7 + 11).' },
    { group: 'Headrest', text: 'The fixed headrest tops the backrest frame. Now the two-person lift: lower the whole chair onto the gas cylinder (step 10). Done!' },
  ],
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
 * Assemble = a drag-to-build puzzle. Each step is one semantic group, in
 * bottom-up order; `indices` are the parts placed that step, `prompt` is the
 * question asked before the attempt and `text` the line spoken after it lands.
 * Models with no authored order fall back to biggest-part-first.
 */
export function resolveAssemble(modelKey, parts) {
  const authored = ASSEMBLE_STEPS[modelKey];
  if (authored) {
    const steps = [];
    for (const { group, text } of authored) {
      const indices = parts
        .map((p, i) => (p.name === group || (p.name || '').startsWith(group + ' ') ? i : -1))
        .filter((i) => i >= 0);
      if (!indices.length) continue;
      steps.push({
        indices,
        name: group,
        text,
        prompt: ASSEMBLE_PROMPT[group] || 'Which part goes on next?',
      });
    }
    return { title: 'Assemble the chair', steps };
  }
  const steps = parts.map((p, i) => ({
    indices: [i],
    name: p.name,
    text: i === 0 ? 'Start with the largest part as the base.' : `Attach the next part: ${p.name}.`,
    prompt: i === 0 ? 'Which is the biggest piece? It goes down first.' : 'Which part goes on next?',
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

/**
 * Per-part reference facts, keyed by model id then semantic part name (the
 * names from SEMANTIC_NAMES / findParts). Optional — a model or part with no
 * entry just has no extra grounding. These are NOT shown or spoken on tap
 * (a tap announces only the part name); they are fed to the LLM as ground
 * truth when the user asks a question about the focused part, so keep them
 * factual and dense rather than conversational.
 */
// Specs grounded in the official IKEA manual (AA-251870-21), the MARKUS product
// page, and owner guides — hardware IDs and behaviours are the documented ones.
const MARKUS_INFO = {
  'Backrest frame': 'The powder-coated steel spine of the chair. Its L-shaped bracket slides into the seat slot and bolts on with three flange bolts #115994 — start all three loosely, the holes align one at a time.',
  'Mesh panel (front)': 'The seating-side layer of Vissle dark-grey mesh — 100% polyester, at least 90% recycled. It flexes against your back and keeps air moving on long days.',
  'Mesh panel (rear)': 'The outer mesh layer, showing the Vissle two-tone mélange weave. Together with the front layer it sandwiches the lumbar band.',
  'Lumbar support band': 'A tension band sewn between the two mesh layers at belt height — the Markus\'s built-in lumbar support. It is part of the back assembly and cannot be adjusted or removed.',
  'Headrest': 'The fixed head support topping the high back. It is part of the backrest frame, not height-adjustable.',
  'Seat': '35 kg/m³ polyurethane foam on laminated wood veneer, rated to 110 kg. The tilt mechanism bolts to its underside with two flange bolts and two countersunk screws.',
  'Tilt mechanism frame': 'The steel frame of the synchronised tilt — it reclines seat and back together for a better hip angle. On heavily used chairs this frame is the part owners report cracking; then the mechanism is replaced.',
  'Tilt mechanism plate': 'The plate that bolts against the seat underside and takes the gas cylinder\'s taper. When swapping the gas lift, tap around this cone with a rubber mallet to free the seized joint.',
  'Height lever': 'The RIGHT-hand paddle. Lift it while seated to sink, lift it unweighted to rise — 46 to 57 cm of seat height. IKEA warns only trained personnel should service the gas spring itself.',
  'Height lever shaft': 'The steel rod that carries the right paddle\'s motion to the valve pin on top of the gas cylinder.',
  'Recline lock lever': 'The LEFT-hand lever. The backrest is sprung forward: flip the lever one way to rock freely, the other to lock upright — it holds one of three positions.',
  'Recline lock shaft': 'The rod linking the left lever to the tilt ratchet inside the mechanism.',
  'Tilt tension knob': 'The knob under the seat front-centre. Turn toward + for more recline resistance, − for less — set it to your body weight so the back follows you without pushing.',
  'Gas cylinder': 'The pneumatic lift (a gas spring). It ships with a transport cap — pull it off before fitting. When a chair keeps sinking the cylinder is swapped as a unit; it is a standard taper fit.',
  'Star base': 'The five-arm base of powder-coated aluminium. The gas cylinder drops into its centre cone, thin end down, and locks by taper — no fasteners.',
  'Caster wheels': 'The twin wheels of a safety caster (IKEA part 100049021). They roll when you sit and brake automatically when the chair is empty, so it never drifts away.',
  'Caster stem': 'The press-fit pin that mounts the caster: line it up and push it straight into the base arm — never at an angle, or it will not seat.',
  'Caster brake hood': 'The hood over the twin wheels housing the auto-brake that grips when the chair is unloaded. A worn hood is why an empty chair starts to drift.',
  'Armrest frame (right)': 'The right armrest loop — steel, fixed height, interchangeable with the left. It slides down over the seat edge and is held by two countersunk screws #122134.',
  'Armrest frame (left)': 'The left armrest loop — steel, fixed height, interchangeable with the right. It slides down over the seat edge and is held by two countersunk screws #122134.',
  'Armrest pad (right)': 'The padded top of the right armrest — polypropylene with synthetic rubber, shaped to take your forearm and ease shoulder strain.',
  'Armrest pad (left)': 'The padded top of the left armrest — polypropylene with synthetic rubber, shaped to take your forearm and ease shoulder strain.',
  'Armrest bolt cap (right)': 'One of the two fixing points where countersunk screws #122134 clamp the right armrest to the seat side — the first thing to snug when an arm wobbles.',
  'Armrest bolt cap (left)': 'One of the two fixing points where countersunk screws #122134 clamp the left armrest to the seat side — the first thing to snug when an arm wobbles.',
};

const PART_INFO = {
  'markus-chair': MARKUS_INFO,
};

/** One-line description for a part in Explore mode, or '' if none authored. */
export function describePart(modelKey, name) {
  return PART_INFO[modelKey]?.[name] || '';
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
