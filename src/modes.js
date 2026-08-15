import { findParts } from './explode.js';
import { tr, t, getLang } from './i18n.js';

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
 * German part names, keyed by the canonical English name above.
 *
 * `p.name` stays English forever — it is the **matching key** every authored
 * `match: [...]` list, every ASSEMBLE_STEPS `group`, and every SEMANTIC_NAMES
 * index resolves against. Translating it in place would break all three at
 * once. Instead the German name is a *display* layer: `partLabel()` is what the
 * legend, the cards and the tutor's context use, so the user (and the LLM)
 * only ever sees the selected language while the plumbing stays stable.
 */
const PART_NAMES_DE = {
  // Markus
  'Backrest frame': 'Rückenlehnenrahmen',
  'Tilt mechanism frame': 'Rahmen der Wippmechanik',
  'Tilt mechanism plate': 'Platte der Wippmechanik',
  'Seat': 'Sitz',
  'Armrest frame (right)': 'Armlehnenrahmen (rechts)',
  'Armrest frame (left)': 'Armlehnenrahmen (links)',
  'Armrest pad (right)': 'Armlehnenpolster (rechts)',
  'Armrest pad (left)': 'Armlehnenpolster (links)',
  'Armrest bolt cap (right)': 'Schraubkappe der Armlehne (rechts)',
  'Armrest bolt cap (left)': 'Schraubkappe der Armlehne (links)',
  'Headrest': 'Kopfstütze',
  'Height lever': 'Höhenverstellhebel',
  'Height lever shaft': 'Welle des Höhenverstellhebels',
  'Recline lock lever': 'Arretierhebel der Rückenlehne',
  'Recline lock shaft': 'Welle des Arretierhebels',
  'Tilt tension knob': 'Wippwiderstand-Drehknopf',
  'Caster wheels': 'Doppelrollen',
  'Caster stem': 'Rollenzapfen',
  'Caster brake hood': 'Bremskappe der Rolle',
  'Mesh panel (rear)': 'Netzbespannung (hinten)',
  'Mesh panel (front)': 'Netzbespannung (vorn)',
  'Star base': 'Fußkreuz',
  'Gas cylinder': 'Gasdruckfeder',
  'Lumbar support band': 'Lendenstützband',
  // Office chair (shares several names with the Markus above)
  'Backrest': 'Rückenlehne',
  'Armrest': 'Armlehne',
  'Caster': 'Rolle',
  'Base hub': 'Nabe des Fußkreuzes',
};

const PART_NAMES = { de: PART_NAMES_DE };

/**
 * The display name of a part in the current language — what the user reads and
 * hears, and what the LLM is given so its answers name parts the same way.
 * Falls through to the canonical English name when there is no translation
 * (a raw mesh name from a model with no semantic map).
 */
export function partLabel(part) {
  if (!part) return '';
  const name = part.name || part.label || '';
  return PART_NAMES[getLang()]?.[name] || name;
}

/** partLabel() for a bare name string (the puzzle's group names go through this too). */
export function localizeName(name) {
  if (!name) return '';
  return PART_NAMES[getLang()]?.[name] || name;
}

/**
 * Resolve a display name (either language) back to the canonical English name.
 * The LLM is handed German part names in German mode and echoes them back in
 * `PART:` headers and plan steps, so the resolvers have to be able to walk that
 * back to something `findParts` understands.
 */
export function canonicalName(display) {
  const d = String(display || '').trim().toLowerCase();
  if (!d) return '';
  for (const map of Object.values(PART_NAMES)) {
    for (const [en, translated] of Object.entries(map)) {
      if (translated.toLowerCase() === d) return en;
    }
  }
  return display;
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

// Ids only — the button labels come from the i18n dictionary (`mode.<id>`), so
// the mode bar re-labels itself on a language switch without touching this list.
export const MODE_LIST = [
  { id: 'explore' }, { id: 'fix' }, { id: 'assemble' }, { id: 'quiz' },
];

// ---- Authored content, keyed by model registry id --------------------------

// Every user-facing string below is a `{ en, de }` pair, resolved by tr() at
// read time. Keeping both languages inline (rather than duplicating the whole
// CONTENT tree per language) means the `match` keyword lists, the part indices
// and the step order stay single-sourced — a translation can never drift out of
// step with the structure it describes. `match` keywords stay English: they
// resolve against the canonical part names, never against what the user sees.
const CONTENT = {
  bicycle: {
    fix: {
      title: { en: 'Fix a flat tyre', de: 'Einen Platten reparieren' },
      steps: [
        { match: ['tire', 'tyre', 'rubber', 'wheel'], action: 'remove',
          text: { en: 'Fully deflate the tyre and unseat one bead from the rim with tyre levers.',
                  de: 'Lass die Luft komplett ab und heble einen Reifenwulst mit Reifenhebern von der Felge.' } },
        { match: ['tube', 'inner'], action: 'remove',
          text: { en: 'Pull the punctured inner tube out from under the tyre.',
                  de: 'Zieh den defekten Schlauch unter dem Reifen hervor.' } },
        { match: ['tire', 'tyre', 'rubber'], action: 'inspect',
          text: { en: 'Run a finger inside the tyre to find the thorn or glass that caused it.',
                  de: 'Fahr mit dem Finger innen durch den Reifen und such den Dorn oder die Glasscherbe.' } },
        { match: ['tube', 'inner'], action: 'install',
          text: { en: 'Seat the new tube, partially inflated, evenly inside the tyre.',
                  de: 'Leg den neuen, leicht aufgepumpten Schlauch gleichmäßig in den Reifen.' } },
        { match: ['tire', 'tyre', 'rubber', 'wheel'], action: 'press_fit',
          text: { en: 'Work the bead back onto the rim, then inflate to the pressure on the sidewall.',
                  de: 'Drück den Wulst zurück auf die Felge und pump auf den Druck auf, der auf der Flanke steht.' } },
      ],
    },
    faults: [
      { symptom: { en: 'Brakes squeal', de: 'Bremsen quietschen' },
        text: { en: 'A squeal under braking is almost always worn pads or a dirty rim. Highlighted is the braking area — check pad wear.',
                de: 'Quietschen beim Bremsen kommt fast immer von abgenutzten Bremsbelägen oder einer verschmutzten Felge. Hervorgehoben ist der Bremsbereich — prüf den Belagverschleiß.' } },
      { symptom: { en: 'Chain slips', de: 'Kette rutscht durch' },
        text: { en: 'Chain slip usually means a stretched chain or worn cassette. Highlighted is the drivetrain.',
                de: 'Eine durchrutschende Kette bedeutet meist eine gelängte Kette oder eine verschlissene Kassette. Hervorgehoben ist der Antrieb.' } },
      { symptom: { en: 'Wheel wobbles', de: 'Laufrad eiert' },
        text: { en: 'A wobble is a wheel out of true — a bent rim or loose spokes. Highlighted is the wheel.',
                de: 'Ein eierndes Laufrad hat einen Höhen- oder Seitenschlag — verzogene Felge oder lose Speichen. Hervorgehoben ist das Laufrad.' } },
    ],
    quiz: [
      { match: ['frame'],
        question: { en: 'Name this central triangular structure everything bolts to.',
                    de: 'Wie heißt diese zentrale Dreiecksstruktur, an der alles verschraubt ist?' },
        answer: { en: 'frame', de: 'der Rahmen' } },
      { match: ['tire', 'tyre', 'rubber'],
        question: { en: 'What is this round part that grips the road?',
                    de: 'Wie heißt dieses runde Teil, das auf der Straße greift?' },
        answer: { en: 'tyre', de: 'der Reifen' } },
      { match: ['seat', 'saddle'],
        question: { en: 'What do you sit on — what is this called?',
                    de: 'Worauf sitzt du — wie heißt dieses Teil?' },
        answer: { en: 'saddle', de: 'der Sattel' } },
      { match: ['chain'],
        question: { en: 'What transfers your pedalling to the rear wheel?',
                    de: 'Was überträgt deine Tretbewegung auf das Hinterrad?' },
        answer: { en: 'chain', de: 'die Kette' } },
    ],
  },

  'office-chair': {
    fix: {
      title: { en: 'Fix a sinking chair — replace the gas lift',
               de: 'Absackenden Stuhl reparieren — Gasdruckfeder tauschen' },
      steps: [
        { match: ['seat', 'cushion', 'pan'], action: 'unscrew',
          text: { en: 'Detach the seat from the tilt mechanism by removing the seat-plate screws.',
                  de: 'Löse den Sitz von der Wippmechanik, indem du die Schrauben der Sitzplatte herausdrehst.' } },
        { match: ['cylinder', 'gas', 'lift', 'piston', 'strut'], action: 'remove',
          text: { en: 'Separate the old gas cylinder from the seat mechanism and the star base.',
                  de: 'Trenne die alte Gasdruckfeder von der Sitzmechanik und vom Fußkreuz.' } },
        { match: ['base', 'star', 'foot', 'spider'], action: 'inspect',
          text: { en: 'Stand the star base upright with all casters on the floor.',
                  de: 'Stell das Fußkreuz aufrecht hin, alle Rollen auf dem Boden.' } },
        { match: ['cylinder', 'gas', 'lift', 'piston', 'strut'], action: 'install',
          text: { en: 'Drop the new gas cylinder into the cone of the star base.',
                  de: 'Setz die neue Gasdruckfeder in den Konus des Fußkreuzes ein.' } },
        { match: ['seat', 'cushion', 'pan'], action: 'press_fit',
          text: { en: 'Refit the seat onto the cylinder and press down firmly to seat the taper.',
                  de: 'Setz den Sitz wieder auf die Gasfeder und drück kräftig nach unten, damit der Konus fest sitzt.' } },
      ],
    },
    // The faults this object is known to have: `symptom` is what the user would
    // say is wrong, `text` is the cause and the fix. Not a screen of its own —
    // the symptoms become Fix's suggestion chips (fixSuggestions) and the whole
    // list grounds the AI tutor (knowledgeDigest), so a spoken "why does it
    // sink?" is answered from this chair's real faults. Ordered most-common
    // first: only the first few become chips.
    faults: [
      {
        symptom: { en: 'Seat keeps sinking', de: 'Sitz sackt immer ab' },
        text: { en: 'A seat that slowly sinks under your weight is a failed gas cylinder — the pneumatic seal has lost its charge. It cannot be refilled, so swap the whole gas lift. Highlighted is the cylinder.',
                de: 'Ein Sitz, der unter deinem Gewicht langsam absackt, hat eine defekte Gasdruckfeder — die Dichtung hat ihren Druck verloren. Nachfüllen geht nicht, also tausch die ganze Gasfeder. Hervorgehoben ist die Gasdruckfeder.' },
      },
      {
        symptom: { en: 'Won\'t rise', de: 'Geht nicht mehr hoch' },
        text: { en: 'If pressing the lever no longer raises the seat, the gas cylinder has lost its pressure completely. First confirm the lever actually pushes the valve pin; if it does, replace the gas lift. Highlighted is the cylinder.',
                de: 'Wenn der Hebel den Sitz nicht mehr anhebt, hat die Gasdruckfeder ihren Druck komplett verloren. Prüf zuerst, ob der Hebel den Ventilstift überhaupt drückt; wenn ja, tausch die Gasfeder. Hervorgehoben ist die Gasdruckfeder.' },
      },
      {
        symptom: { en: 'Height lever stuck', de: 'Höhenverstellhebel klemmt' },
        text: { en: 'No height change when you lift the paddle points to a stuck or disconnected height lever — its linkage is not pressing the cylinder valve pin. Check the arm or cable down to the valve. Highlighted is the height lever.',
                de: 'Wenn sich beim Ziehen des Hebels nichts an der Höhe tut, klemmt der Höhenverstellhebel oder seine Verbindung ist ausgehängt — er drückt den Ventilstift der Gasfeder nicht mehr. Prüf das Gestänge oder den Bowdenzug bis zum Ventil. Hervorgehoben ist der Höhenverstellhebel.' },
      },
      {
        symptom: { en: 'Chair wobbles', de: 'Stuhl wackelt' },
        text: { en: 'Side-to-side wobble usually means a cracked or flexing star base, or one arm not sitting flat. Set it on hard floor and press each arm to find the give. Highlighted is the star base.',
                de: 'Seitliches Wackeln bedeutet meist ein gerissenes oder nachgebendes Fußkreuz oder einen Arm, der nicht flach aufliegt. Stell den Stuhl auf harten Boden und drück jeden Arm einzeln herunter, um das Spiel zu finden. Hervorgehoben ist das Fußkreuz.' },
      },
      {
        symptom: { en: 'Cracked base', de: 'Fußkreuz gerissen' },
        text: { en: 'A visible crack in a plastic star base is a safety risk and cannot be reliably glued — replace the base. A metal base can sometimes be re-welded. Highlighted is the star base.',
                de: 'Ein sichtbarer Riss in einem Kunststoff-Fußkreuz ist ein Sicherheitsrisiko und lässt sich nicht zuverlässig kleben — tausch das Fußkreuz. Ein Metallfußkreuz kann man manchmal nachschweißen. Hervorgehoben ist das Fußkreuz.' },
      },
      {
        symptom: { en: 'Won\'t roll', de: 'Rollt nicht mehr' },
        text: { en: 'A chair that drags or will not roll has a jammed caster — usually hair and carpet fibre wound around the axle. Pop the caster out, clear it, or swap in a new one. Highlighted is the caster set.',
                de: 'Ein Stuhl, der schleift oder nicht mehr rollt, hat eine blockierte Rolle — meist Haare und Teppichfasern um die Achse gewickelt. Zieh die Rolle heraus, reinige sie oder setz eine neue ein. Hervorgehoben sind die Rollen.' },
      },
      {
        symptom: { en: 'Rolls away', de: 'Rollt von allein weg' },
        text: { en: 'A chair that rolls on its own has worn casters or the wrong wheel for the floor — fit braked casters, or the correct hard-floor or carpet type. Highlighted is the caster set.',
                de: 'Ein Stuhl, der von allein wegrollt, hat abgenutzte Rollen oder die falschen Rollen für den Boden — montiere gebremste Rollen oder den passenden Typ für Hartboden bzw. Teppich. Hervorgehoben sind die Rollen.' },
      },
      {
        symptom: { en: 'Squeaks and creaks', de: 'Quietscht und knarzt' },
        text: { en: 'Squeaks and creaks come from the central mechanism and swivel — the tilt springs, the seat-plate bolts, or the cylinder top bearing. Tighten the under-seat bolts and grease the swivel. Highlighted is the base hub.',
                de: 'Quietschen und Knarzen kommt aus der zentralen Mechanik und dem Drehlager — den Wippfedern, den Schrauben der Sitzplatte oder dem oberen Lager der Gasfeder. Zieh die Schrauben unter dem Sitz nach und fette das Drehlager. Hervorgehoben ist die Nabe des Fußkreuzes.' },
      },
      {
        symptom: { en: 'Won\'t swivel', de: 'Dreht sich nicht mehr' },
        text: { en: 'A seat that will not rotate has a seized swivel bearing in the base hub, usually dry or rust-bound. Lift the seat off and grease the bearing race. Highlighted is the base hub.',
                de: 'Ein Sitz, der sich nicht mehr drehen lässt, hat ein festsitzendes Drehlager in der Nabe — meist trocken oder verrostet. Heb den Sitz ab und fette die Laufbahn des Lagers. Hervorgehoben ist die Nabe des Fußkreuzes.' },
      },
      {
        symptom: { en: 'Loose backrest', de: 'Rückenlehne lose' },
        text: { en: 'A loose or free-flopping backrest is loose mounting bolts or a worn recline-tension knob on the back bracket. Tighten the bracket bolts and reset the tension. Highlighted is the backrest.',
                de: 'Eine lose oder frei kippende Rückenlehne bedeutet gelockerte Befestigungsschrauben oder einen verschlissenen Spannknopf am Lehnenhalter. Zieh die Halterschrauben nach und stell die Spannung neu ein. Hervorgehoben ist die Rückenlehne.' },
      },
      {
        symptom: { en: 'Loose armrest', de: 'Armlehne lose' },
        text: { en: 'A wobbly armrest is almost always loose bolts under the seat pan where the arm mounts. Tighten them; if the arm itself is cracked, replace it. Highlighted is the armrest.',
                de: 'Eine wackelnde Armlehne kommt fast immer von losen Schrauben unter der Sitzschale, wo die Lehne befestigt ist. Zieh sie nach; ist die Lehne selbst gerissen, tausch sie aus. Hervorgehoben ist die Armlehne.' },
      },
      {
        symptom: { en: 'Seat wobbles', de: 'Sitz wackelt' },
        text: { en: 'A seat that rocks but does not sink is loose seat-plate bolts between the cushion and the tilt mechanism. Flip the chair and tighten the four mounting bolts. Highlighted is the seat.',
                de: 'Ein Sitz, der wackelt, aber nicht absackt, hat lose Schrauben der Sitzplatte zwischen Polster und Wippmechanik. Dreh den Stuhl um und zieh die vier Befestigungsschrauben nach. Hervorgehoben ist der Sitz.' },
      },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift', 'strut'],
        question: { en: 'What part lets you raise and lower the seat?', de: 'Mit welchem Teil kannst du den Sitz höher und tiefer stellen?' },
        answer: { en: 'the gas cylinder (pneumatic lift)', de: 'die Gasdruckfeder (pneumatische Höhenverstellung)' } },
      { match: ['star base', 'star', 'spider'],
        question: { en: 'What is the five-armed part on the floor called?', de: 'Wie heißt das fünfarmige Teil auf dem Boden?' },
        answer: { en: 'the star base', de: 'das Fußkreuz' } },
      { match: ['caster', 'wheel', 'roller'],
        question: { en: 'What are the rolling parts called?', de: 'Wie heißen die rollenden Teile?' },
        answer: { en: 'casters', de: 'die Rollen' } },
      { match: ['backrest'],
        question: { en: 'What part supports your back?', de: 'Welches Teil stützt deinen Rücken?' },
        answer: { en: 'the backrest', de: 'die Rückenlehne' } },
    ],
  },

  'markus-chair': {
    // Grounding digest for the AI tutor — built ONLY from checked sources so
    // answers come from the real chair, not model guesses: the official IKEA
    // assembly manual AA-251870-21 (hardware IDs, steps, safety pages), the
    // ikea.com MARKUS product page (materials, dimensions), the Instructables
    // "IKEA Markus Assembly Guide", and the manuall.co.uk MARKUS page
    // (owner FAQ: common failures and spares).
    about: {
      en: 'The IKEA Markus (designer Henrik Preutz, art. 702.611.50) is a high-back swivel office chair rated to 110 kg, certified EN 1335, with a 10-year warranty. Backrest: breathable Vissle dark-grey mesh (100% polyester, min 90% recycled) in two layers over a powder-coated steel frame, with a lumbar support band sewn in at belt height and a fixed headrest. Armrests: fixed height (no adjustable version exists), identical left/right, padded with polypropylene and synthetic rubber. Seat: 35 kg/m³ polyurethane foam on laminated wood veneer. Base: powder-coated aluminium five-star on twin-wheel safety casters that brake automatically when nobody sits in the chair, so it never rolls away when you stand up. Controls: the RIGHT paddle under the seat is the height lever (lift while seated to sink, unweight to rise, 46–57 cm); the LEFT lever is the recline lock — the backrest is sprung forward, unlock to rock, lock upright (3 positions); the knob under the seat front-centre sets tilt tension (turn + for more resistance, − for less). Assembly hardware (manual AA-251870-21): 6 countersunk screws #122134, 5 flange bolts #115994 (2 fix the tilt mechanism to the seat, 3 fix the backrest bracket), one allen key #124345, 5 press-in casters #100049021 — push casters straight in, never at an angle; pull the transport cap off the gas cylinder before fitting; start all 3 backrest bolts loosely before tightening; lowering the assembled chair onto the cylinder is a two-person lift. IKEA warns that only trained personnel may replace or repair the gas spring (energy accumulator). Known aging failures from owners: the gas lift loses pressure (replaceable, standard taper fit), the tilt-mechanism frame can crack after years of heavy use, and taper joints seize — freeing the cylinder from the seat mechanism or base needs firm taps with a rubber mallet.',
      de: 'Der IKEA MARKUS (Design Henrik Preutz, Art.-Nr. 702.611.50) ist ein Drehstuhl mit hoher Rückenlehne, zugelassen bis 110 kg, geprüft nach EN 1335, mit 10 Jahren Garantie. Rückenlehne: atmungsaktives Netzgewebe „Vissle" in Dunkelgrau (100 % Polyester, mindestens 90 % recycelt) in zwei Lagen über einem pulverbeschichteten Stahlrahmen, mit einem in Gürtelhöhe eingenähten Lendenstützband und einer fest verbauten Kopfstütze. Armlehnen: feste Höhe (eine verstellbare Variante gibt es nicht), links und rechts identisch, gepolstert mit Polypropylen und Synthesekautschuk. Sitz: Polyurethanschaum 35 kg/m³ auf Schichtholz mit Furnier. Fußkreuz: fünfarmig aus pulverbeschichtetem Aluminium auf Doppelrollen mit Sicherheitsbremse, die automatisch greift, sobald niemand sitzt — der Stuhl rollt beim Aufstehen also nicht weg. Bedienung: der RECHTE Hebel unter dem Sitz ist die Höhenverstellung (im Sitzen ziehen zum Absenken, entlastet ziehen zum Anheben, 46–57 cm); der LINKE Hebel ist die Arretierung der Rückenlehne — die Lehne ist nach vorn gefedert, entriegelt wippt sie, verriegelt hält sie eine von drei Positionen; der Drehknopf mittig vorn unter dem Sitz stellt den Wippwiderstand ein (Richtung + mehr Widerstand, Richtung − weniger). Montagematerial (Anleitung AA-251870-21): 6 Senkschrauben #122134, 5 Flanschschrauben #115994 (2 befestigen die Wippmechanik am Sitz, 3 den Halter der Rückenlehne), ein Inbusschlüssel #124345, 5 Steckrollen #100049021 — Rollen immer gerade einstecken, nie schräg; vor der Montage die Transportkappe von der Gasdruckfeder abziehen; alle 3 Lehnenschrauben zuerst locker ansetzen und erst dann festziehen; den fertigen Stuhl auf die Gasfeder zu setzen ist eine Arbeit für zwei Personen. IKEA weist darauf hin, dass die Gasdruckfeder (Energiespeicher) nur von geschultem Personal getauscht oder repariert werden darf. Bekannte Verschleißprobleme aus der Praxis: die Gasfeder verliert Druck (austauschbar, Standard-Konussitz), der Rahmen der Wippmechanik kann nach Jahren starker Nutzung reißen, und die Konusverbindungen setzen sich fest — um die Gasfeder aus Sitzmechanik oder Fußkreuz zu lösen, braucht es kräftige Schläge mit einem Gummihammer.',
    },
    // `action` picks the motion primitive (fixanim.js) each step animates with —
    // the same verbs the DGPT planner chooses from, so the no-AI fallback moves
    // exactly like a generated plan.
    fix: {
      title: { en: 'Fix a sinking Markus — replace the gas lift',
               de: 'Absackenden MARKUS reparieren — Gasdruckfeder tauschen' },
      steps: [
        { match: ['seat'], action: 'unscrew',
          text: { en: 'Tip the chair on its side and undo the tilt-mechanism fasteners under the seat: two flange bolts and two countersunk screws, using the allen key that came with the chair.',
                  de: 'Leg den Stuhl auf die Seite und löse die Befestigungen der Wippmechanik unter dem Sitz: zwei Flanschschrauben und zwei Senkschrauben, mit dem beiliegenden Inbusschlüssel.' } },
        { match: ['cylinder', 'gas', 'lift'], action: 'tap_loose',
          text: { en: 'Free the old cylinder from the mechanism plate — the taper joint seizes over time, so tap the plate around the cone with a rubber mallet, never pry against the seat.',
                  de: 'Löse die alte Gasfeder von der Mechanikplatte — die Konusverbindung setzt sich mit der Zeit fest, klopf also mit einem Gummihammer rund um den Konus auf die Platte, und heble niemals gegen den Sitz.' } },
        { match: ['star'], action: 'tap_loose',
          text: { en: 'Knock the cylinder out of the star base the same way, then stand the base upright with all five casters flat on the floor.',
                  de: 'Klopf die Gasfeder genauso aus dem Fußkreuz heraus und stell das Fußkreuz dann aufrecht hin, alle fünf Rollen flach auf dem Boden.' } },
        { match: ['cylinder', 'gas', 'lift'], action: 'install',
          text: { en: 'Drop the new gas lift into the base cone, thin end down — and if it shipped with a transport cap, pull that off first.',
                  de: 'Setz die neue Gasfeder mit dem dünnen Ende nach unten in den Konus des Fußkreuzes — und zieh vorher die Transportkappe ab, falls eine drauf ist.' } },
        { match: ['seat'], action: 'press_fit',
          text: { en: 'Refit the seat and mechanism onto the cylinder and sit down firmly — your weight locks the taper. IKEA notes gas-spring service is for trained hands, so work carefully.',
                  de: 'Setz Sitz und Mechanik wieder auf die Gasfeder und setz dich kräftig drauf — dein Gewicht verkeilt den Konus. IKEA weist darauf hin, dass Arbeiten an der Gasfeder geschultem Personal vorbehalten sind, also arbeite umsichtig.' } },
      ],
    },
    // Known faults — symptom + cause/fix. Feeds Fix's suggestion chips and the
    // tutor's grounding digest; see the office chair's list above.
    faults: [
      {
        symptom: { en: 'Seat keeps sinking', de: 'Sitz sackt immer ab' },
        text: { en: 'A Markus that slowly sinks under your weight has a failed gas cylinder — the pneumatic seal has lost its charge and cannot be refilled. Swap the whole gas lift. Highlighted is the gas cylinder.',
                de: 'Ein MARKUS, der unter deinem Gewicht langsam absackt, hat eine defekte Gasdruckfeder — die Dichtung hat ihren Druck verloren und lässt sich nicht nachfüllen. Tausch die komplette Gasfeder. Hervorgehoben ist die Gasdruckfeder.' },
      },
      {
        symptom: { en: 'Won\'t rise', de: 'Geht nicht mehr hoch' },
        text: { en: 'If the paddle no longer raises the seat, the gas cylinder has lost its pressure completely. Confirm the lever actually pushes the valve pin; if it does, replace the gas lift. Highlighted is the gas cylinder.',
                de: 'Wenn der Hebel den Sitz nicht mehr anhebt, hat die Gasdruckfeder ihren Druck komplett verloren. Prüf, ob der Hebel den Ventilstift überhaupt drückt; wenn ja, tausch die Gasfeder. Hervorgehoben ist die Gasdruckfeder.' },
      },
      {
        symptom: { en: 'Backrest won\'t lock', de: 'Rückenlehne rastet nicht ein' },
        text: { en: 'The Markus backrest is sprung forward and held by the LEFT-hand lever — the recline lock, which holds one of three positions. If the back will not stay upright, the lock is not engaging: work the left lever and check its shaft into the mechanism. Highlighted is the recline lock.',
                de: 'Die MARKUS-Rückenlehne ist nach vorn gefedert und wird vom LINKEN Hebel gehalten — der Arretierung, die eine von drei Positionen hält. Bleibt die Lehne nicht aufrecht, greift die Arretierung nicht: beweg den linken Hebel und prüf seine Welle bis in die Mechanik. Hervorgehoben ist der Arretierhebel.' },
      },
      {
        symptom: { en: 'Reclines too easily', de: 'Kippt zu leicht nach hinten' },
        text: { en: 'A back that leans too freely or snaps forward is the tilt tension set too loose for your weight. Find the knob under the front-centre of the seat and turn it toward + for more resistance, − for less. Highlighted is the tension knob.',
                de: 'Eine Lehne, die zu leicht nachgibt oder nach vorn zurückschnappt, hat einen für dein Gewicht zu gering eingestellten Wippwiderstand. Such den Drehknopf mittig vorn unter dem Sitz und dreh ihn Richtung + für mehr Widerstand, Richtung − für weniger. Hervorgehoben ist der Wippwiderstand-Drehknopf.' },
      },
      {
        symptom: { en: 'Chair wobbles', de: 'Stuhl wackelt' },
        text: { en: 'Side-to-side wobble usually means a cracked or flexing star base, or one arm not sitting flat. Set it on hard floor and press each arm to find the give. Highlighted is the star base.',
                de: 'Seitliches Wackeln bedeutet meist ein gerissenes oder nachgebendes Fußkreuz oder einen Arm, der nicht flach aufliegt. Stell den Stuhl auf harten Boden und drück jeden Arm einzeln herunter, um das Spiel zu finden. Hervorgehoben ist das Fußkreuz.' },
      },
      {
        symptom: { en: 'Cracked base', de: 'Fußkreuz gerissen' },
        text: { en: 'A visible crack in the star base is a safety risk. Markus bases are metal and can sometimes be re-welded, but replacement is safer. Highlighted is the star base.',
                de: 'Ein sichtbarer Riss im Fußkreuz ist ein Sicherheitsrisiko. MARKUS-Fußkreuze sind aus Metall und lassen sich manchmal nachschweißen, aber ein Austausch ist sicherer. Hervorgehoben ist das Fußkreuz.' },
      },
      {
        symptom: { en: 'Won\'t roll', de: 'Rollt nicht mehr' },
        text: { en: 'A chair that drags has a jammed caster — usually hair and carpet fibre wound around the axle. Pop the caster out, clear it, or swap in a new one. Highlighted is the caster set.',
                de: 'Ein Stuhl, der schleift, hat eine blockierte Rolle — meist Haare und Teppichfasern um die Achse gewickelt. Zieh die Rolle heraus, reinige sie oder setz eine neue ein. Hervorgehoben sind die Rollen.' },
      },
      {
        symptom: { en: 'Rolls away', de: 'Rollt von allein weg' },
        text: { en: 'Markus casters are safety casters — they brake automatically when nobody is sitting, so an empty chair should never drift. If it rolls away on its own, a brake hood is worn or jammed: pop that caster out and replace it (IKEA part 100049021). Highlighted is the caster set.',
                de: 'MARKUS-Rollen sind Sicherheitsrollen — sie bremsen automatisch, sobald niemand sitzt, ein leerer Stuhl sollte also nie wegrollen. Rollt er trotzdem von allein, ist eine Bremskappe verschlissen oder blockiert: zieh die Rolle heraus und tausch sie (IKEA-Teil 100049021). Hervorgehoben sind die Rollen.' },
      },
      {
        symptom: { en: 'Squeaks and creaks', de: 'Quietscht und knarzt' },
        text: { en: 'Squeaks and creaks come from the tilt mechanism and swivel — dry springs, loose fasteners on the seat plate, or the cylinder top bearing. Snug the two flange bolts and two screws under the seat with the allen key, and grease the pivot. Highlighted is the tilt mechanism.',
                de: 'Quietschen und Knarzen kommt aus der Wippmechanik und dem Drehlager — trockene Federn, lose Schrauben an der Sitzplatte oder das obere Lager der Gasfeder. Zieh die zwei Flansch- und zwei Senkschrauben unter dem Sitz mit dem Inbusschlüssel nach und fette den Drehpunkt. Hervorgehoben ist die Wippmechanik.' },
      },
      {
        symptom: { en: 'Headrest slips', de: 'Kopfstütze rutscht' },
        text: { en: 'A headrest that sinks or will not hold its angle has a worn friction joint at its stem. Tighten the headrest bracket; if the ratchet is stripped, the headrest is replaced as a unit. Highlighted is the headrest.',
                de: 'Eine Kopfstütze, die absinkt oder ihren Winkel nicht hält, hat ein ausgeschlagenes Reibgelenk am Schaft. Zieh den Halter der Kopfstütze nach; ist die Rasterung ausgeleiert, wird die Kopfstütze komplett getauscht. Hervorgehoben ist die Kopfstütze.' },
      },
      {
        symptom: { en: 'Loose armrest', de: 'Armlehne lose' },
        text: { en: 'Each Markus armrest is held by two countersunk screws into the seat side — a wobbly arm means they have worked loose, so snug them with the allen key. The arms are identical left/right and fixed height; no adjustable version exists. Highlighted is the armrest.',
                de: 'Jede MARKUS-Armlehne ist mit zwei Senkschrauben an der Sitzseite befestigt — eine wackelnde Lehne bedeutet, dass sie sich gelöst haben, zieh sie also mit dem Inbusschlüssel nach. Die Lehnen sind links und rechts identisch und in der Höhe fest; eine verstellbare Variante gibt es nicht. Hervorgehoben ist die Armlehne.' },
      },
      {
        symptom: { en: 'Mesh sagging', de: 'Netzbespannung hängt durch' },
        text: { en: 'A sagging or stretched mesh back has lost its tension and cannot be re-tightened — the two mesh layers are fixed to the frame with the lumbar band sewn between them. Replace the back assembly. Highlighted is the mesh back.',
                de: 'Eine durchhängende oder ausgeleierte Netzbespannung hat ihre Spannung verloren und lässt sich nicht nachspannen — die zwei Netzlagen sind fest am Rahmen, mit dem Lendenstützband dazwischen eingenäht. Tausch die komplette Rückenlehne. Hervorgehoben ist die Netzbespannung.' },
      },
    ],
    quiz: [
      { match: ['cylinder', 'gas', 'lift'],
        question: { en: 'What part lets you raise and lower the seat?', de: 'Mit welchem Teil kannst du den Sitz höher und tiefer stellen?' },
        answer: { en: 'the gas cylinder (pneumatic lift)', de: 'die Gasdruckfeder (pneumatische Höhenverstellung)' } },
      { match: ['star'],
        question: { en: 'What is the five-armed part on the floor called?', de: 'Wie heißt das fünfarmige Teil auf dem Boden?' },
        answer: { en: 'the star base', de: 'das Fußkreuz' } },
      { match: ['caster', 'wheel', 'roller'],
        question: { en: 'What are the rolling parts called?', de: 'Wie heißen die rollenden Teile?' },
        answer: { en: 'casters — safety casters that brake when the chair is empty',
                  de: 'die Rollen — Sicherheitsrollen, die bremsen, sobald niemand sitzt' } },
      { match: ['recline'],
        question: { en: 'Which control locks the backrest upright?', de: 'Welche Bedienung arretiert die Rückenlehne aufrecht?' },
        answer: { en: 'the left-hand recline lock lever', de: 'der linke Arretierhebel der Rückenlehne' } },
      { match: ['tension'],
        question: { en: 'What sets how hard the chair resists leaning back?', de: 'Womit stellst du ein, wie stark sich der Stuhl gegen das Zurücklehnen wehrt?' },
        answer: { en: 'the tilt tension knob under the seat front', de: 'der Wippwiderstand-Drehknopf vorn unter dem Sitz' } },
      { match: ['headrest'],
        question: { en: 'What supports your head at the very top of the chair?', de: 'Was stützt deinen Kopf ganz oben am Stuhl?' },
        answer: { en: 'the headrest', de: 'die Kopfstütze' } },
      { match: ['mesh'],
        question: { en: 'What is the breathable part your back rests against?', de: 'Wie heißt das atmungsaktive Teil, an dem dein Rücken anliegt?' },
        answer: { en: 'the Vissle mesh back', de: 'die Vissle-Netzbespannung' } },
      { match: ['lumbar'],
        question: { en: 'What is sewn between the mesh layers at belt height?', de: 'Was ist in Gürtelhöhe zwischen die Netzlagen eingenäht?' },
        answer: { en: 'the lumbar support band', de: 'das Lendenstützband' } },
    ],
  },

  // Placeholder for the radial engine — tune keywords once the GLB is in.
  engine: {
    fix: {
      title: { en: 'Replace a piston', de: 'Einen Kolben tauschen' },
      steps: [
        { match: ['cylinder', 'head'], action: 'unscrew',
          text: { en: 'Remove the cylinder head bolts to expose the piston.',
                  de: 'Dreh die Zylinderkopfschrauben heraus, um den Kolben freizulegen.' } },
        { match: ['piston'], action: 'remove',
          text: { en: 'Slide the old piston out of its bore.', de: 'Zieh den alten Kolben aus seiner Laufbuchse.' } },
        { match: ['ring'], action: 'install',
          text: { en: 'Fit new rings, gaps staggered around the piston.',
                  de: 'Setz neue Kolbenringe ein, die Stöße versetzt um den Kolben verteilt.' } },
        { match: ['piston'], action: 'install',
          text: { en: 'Insert the new piston squarely into the bore.',
                  de: 'Führ den neuen Kolben gerade in die Laufbuchse ein.' } },
        { match: ['cylinder', 'head'], action: 'screw_in',
          text: { en: 'Refit the head and torque the bolts in a cross pattern.',
                  de: 'Setz den Zylinderkopf wieder auf und zieh die Schrauben über Kreuz mit Drehmoment an.' } },
      ],
    },
    faults: [
      { symptom: { en: 'Low power', de: 'Wenig Leistung' },
        text: { en: 'Low power points to compression loss — worn rings or a scored bore. Highlighted is the piston assembly.',
                de: 'Wenig Leistung deutet auf Kompressionsverlust hin — verschlissene Kolbenringe oder eine riefige Laufbuchse. Hervorgehoben ist die Kolbengruppe.' } },
      { symptom: { en: 'Knocking noise', de: 'Klopfendes Geräusch' },
        text: { en: 'A knock under load is often a rod or main bearing. Highlighted is the rotating assembly.',
                de: 'Ein Klopfen unter Last kommt oft von einem Pleuel- oder Hauptlager. Hervorgehoben ist der Kurbeltrieb.' } },
    ],
    quiz: [
      { match: ['piston'],
        question: { en: 'What part travels up and down inside the cylinder?', de: 'Welches Teil bewegt sich im Zylinder auf und ab?' },
        answer: { en: 'piston', de: 'der Kolben' } },
      { match: ['crank'],
        question: { en: 'What converts the pistons’ motion into rotation?', de: 'Was wandelt die Kolbenbewegung in eine Drehbewegung um?' },
        answer: { en: 'crankshaft', de: 'die Kurbelwelle' } },
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
  'Star base': { en: 'Start at the floor. Which piece spreads your weight out to five points?',
                 de: 'Fang am Boden an. Welches Teil verteilt dein Gewicht auf fünf Punkte?' },
  'Caster': { en: 'What makes it roll? Five of these press into the ends of the base arms.',
              de: 'Was lässt ihn rollen? Fünf davon werden in die Enden der Fußkreuzarme gesteckt.' },
  'Base hub': { en: 'Which piece caps the centre of the base so the chair can swivel?',
                de: 'Welches Teil schließt die Mitte des Fußkreuzes ab, damit sich der Stuhl drehen kann?' },
  'Gas cylinder': { en: 'What drops into the cone in the middle to raise and lower you?',
                    de: 'Was kommt in den Konus in der Mitte, damit du hoch und runter kommst?' },
  'Tilt': { en: 'Which block bolts under the seat and lets the chair rock back?',
            de: 'Welcher Block wird unter den Sitz geschraubt und lässt den Stuhl nach hinten wippen?' },
  'Height lever': { en: 'Which paddle do you lift to change the seat height?',
                    de: 'An welchem Hebel ziehst du, um die Sitzhöhe zu ändern?' },
  'Recline lock': { en: 'Which lever holds the backrest still instead of letting it rock?',
                    de: 'Welcher Hebel hält die Rückenlehne fest, statt sie wippen zu lassen?' },
  'Seat': { en: 'What do you actually sit on?', de: 'Worauf sitzt du eigentlich?' },
  'Backrest': { en: 'Which frame carries your back?', de: 'Welcher Rahmen trägt deinen Rücken?' },
  'Mesh panel': { en: 'What stretches across the back frame to keep you cool?',
                  de: 'Was ist über den Lehnenrahmen gespannt und hält dich kühl?' },
  'Lumbar': { en: 'Which band sits at belt height, supporting the small of your back?',
              de: 'Welches Band sitzt auf Gürtelhöhe und stützt dein Kreuz?' },
  'Armrest': { en: 'Where do your forearms rest? One goes on each side.',
               de: 'Worauf liegen deine Unterarme? Eine kommt auf jede Seite.' },
  'Headrest': { en: 'What tops the backrest to support your head?',
                de: 'Was sitzt oben auf der Rückenlehne und stützt deinen Kopf?' },
};

/**
 * The Assemble step's *group* name in the current language — the label the card
 * shows on a correct placement and the name the tutor speaks when guiding to
 * the next piece. Separate from PART_NAMES_DE because a group covers a family
 * ('Caster' = wheels + stem + brake hood), so it reads as a plural.
 */
const ASSEMBLE_GROUP_DE = {
  'Star base': 'Fußkreuz',
  'Caster': 'Rollen',
  'Base hub': 'Nabe des Fußkreuzes',
  'Gas cylinder': 'Gasdruckfeder',
  'Tilt': 'Wippmechanik',
  'Height lever': 'Höhenverstellhebel',
  'Recline lock': 'Arretierhebel',
  'Seat': 'Sitz',
  'Backrest': 'Rückenlehne',
  'Mesh panel': 'Netzbespannung',
  'Lumbar': 'Lendenstützband',
  'Armrest': 'Armlehnen',
  'Headrest': 'Kopfstütze',
};

// Each step's `group` matches parts whose name equals it OR starts with it plus
// a space — so one step can reveal a whole family of distinct part names
// ('Caster' → Caster wheels / Caster stem / Caster brake hood). Every part must
// be caught by some step: in Assemble, an unmatched part stays hidden.
const ASSEMBLE_STEPS = {
  'office-chair': [
    { group: 'Star base', text: { en: 'Lay out the five-armed star base.', de: 'Leg das fünfarmige Fußkreuz aus.' } },
    { group: 'Caster', text: { en: 'Press a caster into the end of each base arm.',
                               de: 'Steck in jedes Ende der Fußkreuzarme eine Rolle.' } },
    { group: 'Base hub', text: { en: 'Fit the central hub into the base.', de: 'Setz die Nabe mittig in das Fußkreuz.' } },
    { group: 'Gas cylinder', text: { en: 'Drop the gas cylinder into the base cone.',
                                     de: 'Setz die Gasdruckfeder in den Konus des Fußkreuzes.' } },
    { group: 'Seat', text: { en: 'Lower the seat onto the cylinder and press to seat the taper.',
                             de: 'Setz den Sitz auf die Gasfeder und drück ihn fest, damit der Konus greift.' } },
    { group: 'Backrest', text: { en: 'Bolt the backrest to the seat mechanism.',
                                 de: 'Schraub die Rückenlehne an die Sitzmechanik.' } },
    { group: 'Armrest', text: { en: 'Attach the left and right armrests.',
                                de: 'Bring die linke und die rechte Armlehne an.' } },
    { group: 'Height lever', text: { en: 'Clip on the height-adjust lever. Done!',
                                     de: 'Clip den Höhenverstellhebel an. Fertig!' } },
  ],
  // Follows the official IKEA manual AA-251870-21, steps 1–11.
  'markus-chair': [
    { group: 'Star base', text: { en: 'Lay the five-arm aluminium star base upside-down on a rug (manual step 1).',
                                  de: 'Leg das fünfarmige Aluminium-Fußkreuz umgedreht auf einen Teppich (Anleitung Schritt 1).' } },
    { group: 'Caster', text: { en: 'Press all five safety casters straight into the base arms — square, never at an angle (step 1).',
                               de: 'Steck alle fünf Sicherheitsrollen gerade in die Fußkreuzarme — rechtwinklig, niemals schräg (Schritt 1).' } },
    { group: 'Gas cylinder', text: { en: 'Pull the transport cap off the gas cylinder, discard it, and drop the cylinder into the base cone, thin end down (steps 2–3).',
                                     de: 'Zieh die Transportkappe von der Gasdruckfeder ab, entsorg sie, und setz die Gasfeder mit dem dünnen Ende nach unten in den Konus des Fußkreuzes (Schritte 2–3).' } },
    { group: 'Tilt', text: { en: 'Bolt the tilt mechanism to the seat underside: two flange bolts #115994, then two countersunk screws #122134, snugged with the allen key (steps 4–6).',
                             de: 'Schraub die Wippmechanik unter den Sitz: zwei Flanschschrauben #115994, dann zwei Senkschrauben #122134, mit dem Inbusschlüssel angezogen (Schritte 4–6).' } },
    { group: 'Height lever', text: { en: 'The right-hand paddle is the height lever — it comes fitted to the mechanism. Lift it while seated to sink, unweight the seat to rise.',
                                     de: 'Der rechte Hebel ist die Höhenverstellung — er ist ab Werk an der Mechanik montiert. Im Sitzen ziehen zum Absenken, entlastet ziehen zum Anheben.' } },
    { group: 'Recline lock', text: { en: 'The left-hand lever is the recline lock. The backrest is sprung forward: unlock to rock freely, lock to hold one of three positions.',
                                     de: 'Der linke Hebel ist die Arretierung der Rückenlehne. Die Lehne ist nach vorn gefedert: entriegelt wippt sie frei, verriegelt hält sie eine von drei Positionen.' } },
    { group: 'Seat', text: { en: 'The seat — foam on laminated wood — now carries the whole mechanism on its underside.',
                             de: 'Der Sitz — Schaum auf Schichtholz — trägt jetzt die komplette Mechanik an seiner Unterseite.' } },
    { group: 'Backrest', text: { en: 'Slide the backrest\'s L-bracket into the seat slot and start all three flange bolts loosely before tightening any — the holes align one at a time (steps 8–9).',
                                 de: 'Schieb den L-Halter der Rückenlehne in den Schlitz am Sitz und setz alle drei Flanschschrauben erst locker an, bevor du eine festziehst — die Löcher fluchten nacheinander (Schritte 8–9).' } },
    { group: 'Mesh panel', text: { en: 'The Vissle mesh comes factory-tensioned over the frame in two layers, front and rear.',
                                   de: 'Das Vissle-Netz ist ab Werk in zwei Lagen über den Rahmen gespannt, vorn und hinten.' } },
    { group: 'Lumbar', text: { en: 'The lumbar support band is sewn between the mesh layers at belt height — built in, nothing to attach.',
                               de: 'Das Lendenstützband ist auf Gürtelhöhe zwischen die Netzlagen eingenäht — fest verbaut, da ist nichts zu montieren.' } },
    { group: 'Armrest', text: { en: 'Slide each armrest down over the seat edge and fix it with two countersunk screws per side — left and right arms are identical (steps 7 + 11).',
                                de: 'Schieb jede Armlehne von oben über die Sitzkante und fixier sie mit zwei Senkschrauben pro Seite — linke und rechte Lehne sind identisch (Schritte 7 und 11).' } },
    { group: 'Headrest', text: { en: 'The fixed headrest tops the backrest frame. Now the two-person lift: lower the whole chair onto the gas cylinder (step 10). Done!',
                                 de: 'Die fest verbaute Kopfstütze schließt den Lehnenrahmen oben ab. Jetzt zu zweit anheben: den ganzen Stuhl auf die Gasdruckfeder setzen (Schritt 10). Fertig!' } },
  ],
};

/**
 * Suggestion chips for Fix's ask-screen ("What should we fix?"). Derived from
 * the authored fault symptoms — the problems we already know this object
 * has — so the suggestions ride the existing authored knowledge instead of
 * becoming a second, parallel hardcode. They are just canned voice inputs:
 * tapping one feeds the same DGPT planner a spoken phrase would.
 */
export function fixSuggestions(modelKey) {
  const c = CONTENT[modelKey];
  const out = [];
  for (const d of c?.faults ?? []) {
    const label = tr(d.symptom);
    if (!out.includes(label)) out.push(label);
    if (out.length >= 4) break;
  }
  if (!out.length && c?.fix?.title) out.push(tr(c.fix.title));
  if (!out.length) out.push(t('fix.suggestFallback'));
  return out;
}

/**
 * Resolve a DGPT plan step's part names → live part indices. Exact-name match
 * first (case-insensitive), collecting EVERY part that shares the name or
 * extends it ("Caster" → Caster wheels / stem / brake hood ×5, "Armrest" →
 * both frames and pads) — the same family rule Assemble uses. A name the model
 * bent slightly ("Casters", "the gas lift") falls back to keyword matching so
 * a near-miss still lights the right part instead of nothing.
 */
export function resolvePlanParts(parts, names) {
  const out = new Set();
  for (const raw of names || []) {
    const n = String(raw).trim().toLowerCase();
    if (!n) continue;
    let hit = false;
    parts.forEach((p, i) => {
      // Both the canonical English name and the current display name count: in
      // German the LLM is given (and echoes back) the German names, but the
      // authored keyword lists and everything else still speak English.
      const canon = (p.name || p.label || '').toLowerCase();
      const shown = partLabel(p).toLowerCase();
      if (canon === n || canon.startsWith(n + ' ') || shown === n || shown.startsWith(n + ' ')) { out.add(i); hit = true; }
    });
    if (!hit) {
      // Walk a German display name back to English first, so the keyword
      // fallback below has something the authored `match` lists can hit.
      const canon = canonicalName(n).toLowerCase();
      // \p{L} not [a-z]: German names carry umlauts, and splitting on ASCII
      // alone would shred "Höhenverstellhebel" into fragments that match nothing.
      const words = canon.split(/[^\p{L}]+/u).filter((w) => w.length > 2);
      for (const i of findParts(parts, words)) out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Fix procedure → { title, steps:[{ indices, text }] }. */
export function resolveFix(modelKey, parts) {
  const authored = CONTENT[modelKey]?.fix;
  if (authored) {
    return {
      title: tr(authored.title),
      steps: authored.steps.map((s) => ({ indices: findParts(parts, s.match), action: s.action || 'inspect', text: tr(s.text) })),
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
        // `name` stays canonical (puzzle.js compares it to nothing, but the
        // tutor prompt wants a stable key); `label` is what the user reads and
        // what the spoken guidance names.
        name: group,
        label: ASSEMBLE_GROUP_DE[group] && getLang() === 'de' ? ASSEMBLE_GROUP_DE[group] : group,
        text: tr(text),
        prompt: tr(ASSEMBLE_PROMPT[group]) || t('assemble.fallbackPrompt'),
      });
    }
    return { title: t('assemble.title'), steps };
  }
  const steps = parts.map((p, i) => ({
    indices: [i],
    name: p.name,
    label: partLabel(p),
    text: i === 0 ? t('assemble.fallbackFirstText') : t('assemble.fallbackText', { part: partLabel(p) }),
    prompt: i === 0 ? t('assemble.fallbackFirstPrompt') : t('assemble.fallbackPrompt'),
  }));
  return { title: t('assemble.genericTitle'), steps };
}

/**
 * A compact, spoken-friendly digest of everything we've authored about a model:
 * the repair procedure and every symptom → cause → fix. Handed to the AI tutor
 * as grounding so free-form questions ("why does it sink?", "how do I fix the
 * wobble?", "what makes it squeak?") are answered from THIS chair's real faults
 * and repairs, not generic guesses. The "Highlighted is the X." tail is a
 * leftover of the old symptom picker and is stripped, so the AI doesn't parrot a
 * sentence about highlighting. Returns '' when a model has no authored content.
 */
export function knowledgeDigest(modelKey) {
  const c = CONTENT[modelKey];
  if (!c) return '';
  // Strip the "Highlighted is the X." tail in either language, so the AI doesn't
  // parrot a sentence about the app's own highlighting.
  const clean = (s) => tr(s).replace(/\s*(?:Highlighted is|Hervorgehoben (?:ist|sind))[^.]*\.\s*$/i, '').trim();
  const lines = [];
  if (c.about) lines.push(tr(c.about));
  if (c.fix?.title) {
    lines.push(`${t('digest.procedure')} — ${tr(c.fix.title)}: ${c.fix.steps.map((s) => clean(s.text)).join(' ')}`);
  }
  if (c.faults?.length) {
    lines.push(`${t('digest.faults')} ` +
      c.faults.map((d) => `${tr(d.symptom)}: ${clean(d.text)}`).join(' '));
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
  'Backrest frame': {
    en: 'The powder-coated steel spine of the chair. Its L-shaped bracket slides into the seat slot and bolts on with three flange bolts #115994 — start all three loosely, the holes align one at a time.',
    de: 'Das pulverbeschichtete Stahlrückgrat des Stuhls. Sein L-förmiger Halter wird in den Schlitz am Sitz geschoben und mit drei Flanschschrauben #115994 verschraubt — alle drei erst locker ansetzen, die Löcher fluchten nacheinander.' },
  'Mesh panel (front)': {
    en: 'The seating-side layer of Vissle dark-grey mesh — 100% polyester, at least 90% recycled. It flexes against your back and keeps air moving on long days.',
    de: 'Die zum Sitzenden zeigende Lage des dunkelgrauen Vissle-Netzes — 100 % Polyester, mindestens 90 % recycelt. Sie gibt am Rücken nach und lässt auch an langen Tagen Luft zirkulieren.' },
  'Mesh panel (rear)': {
    en: 'The outer mesh layer, showing the Vissle two-tone mélange weave. Together with the front layer it sandwiches the lumbar band.',
    de: 'Die äußere Netzlage mit der zweifarbigen Vissle-Mélange-Webung. Zusammen mit der vorderen Lage schließt sie das Lendenstützband ein.' },
  'Lumbar support band': {
    en: 'A tension band sewn between the two mesh layers at belt height — the Markus\'s built-in lumbar support. It is part of the back assembly and cannot be adjusted or removed.',
    de: 'Ein Spannband, auf Gürtelhöhe zwischen die beiden Netzlagen eingenäht — die eingebaute Lendenwirbelstütze des MARKUS. Es gehört zur Rückenlehne und lässt sich weder verstellen noch entfernen.' },
  'Headrest': {
    en: 'The fixed head support topping the high back. It is part of the backrest frame, not height-adjustable.',
    de: 'Die fest verbaute Kopfstütze oben an der hohen Lehne. Sie gehört zum Rückenlehnenrahmen und ist nicht höhenverstellbar.' },
  'Seat': {
    en: '35 kg/m³ polyurethane foam on laminated wood veneer, rated to 110 kg. The tilt mechanism bolts to its underside with two flange bolts and two countersunk screws.',
    de: 'Polyurethanschaum mit 35 kg/m³ auf furniertem Schichtholz, zugelassen bis 110 kg. Die Wippmechanik wird mit zwei Flansch- und zwei Senkschrauben an seiner Unterseite verschraubt.' },
  'Tilt mechanism frame': {
    en: 'The steel frame of the synchronised tilt — it reclines seat and back together for a better hip angle. On heavily used chairs this frame is the part owners report cracking; then the mechanism is replaced.',
    de: 'Der Stahlrahmen der Synchronmechanik — sie neigt Sitz und Lehne gemeinsam für einen besseren Hüftwinkel. Bei stark genutzten Stühlen reißt erfahrungsgemäß genau dieser Rahmen; dann wird die Mechanik getauscht.' },
  'Tilt mechanism plate': {
    en: 'The plate that bolts against the seat underside and takes the gas cylinder\'s taper. When swapping the gas lift, tap around this cone with a rubber mallet to free the seized joint.',
    de: 'Die Platte, die unter den Sitz geschraubt wird und den Konus der Gasdruckfeder aufnimmt. Beim Tausch der Gasfeder klopfst du mit einem Gummihammer rund um diesen Konus, um die festsitzende Verbindung zu lösen.' },
  'Height lever': {
    en: 'The RIGHT-hand paddle. Lift it while seated to sink, lift it unweighted to rise — 46 to 57 cm of seat height. IKEA warns only trained personnel should service the gas spring itself.',
    de: 'Der RECHTE Hebel. Im Sitzen ziehen zum Absenken, entlastet ziehen zum Anheben — Sitzhöhe 46 bis 57 cm. IKEA weist darauf hin, dass Arbeiten an der Gasdruckfeder selbst nur geschultem Personal vorbehalten sind.' },
  'Height lever shaft': {
    en: 'The steel rod that carries the right paddle\'s motion to the valve pin on top of the gas cylinder.',
    de: 'Die Stahlwelle, die die Bewegung des rechten Hebels auf den Ventilstift oben an der Gasdruckfeder überträgt.' },
  'Recline lock lever': {
    en: 'The LEFT-hand lever. The backrest is sprung forward: flip the lever one way to rock freely, the other to lock upright — it holds one of three positions.',
    de: 'Der LINKE Hebel. Die Rückenlehne ist nach vorn gefedert: in die eine Richtung wippt sie frei, in die andere ist sie aufrecht arretiert — sie hält eine von drei Positionen.' },
  'Recline lock shaft': {
    en: 'The rod linking the left lever to the tilt ratchet inside the mechanism.',
    de: 'Die Welle, die den linken Hebel mit der Rasterung der Wippmechanik verbindet.' },
  'Tilt tension knob': {
    en: 'The knob under the seat front-centre. Turn toward + for more recline resistance, − for less — set it to your body weight so the back follows you without pushing.',
    de: 'Der Drehknopf mittig vorn unter dem Sitz. Richtung + für mehr Widerstand beim Zurücklehnen, Richtung − für weniger — stell ihn auf dein Körpergewicht ein, damit die Lehne dir folgt, ohne zu drücken.' },
  'Gas cylinder': {
    en: 'The pneumatic lift (a gas spring). It ships with a transport cap — pull it off before fitting. When a chair keeps sinking the cylinder is swapped as a unit; it is a standard taper fit.',
    de: 'Die pneumatische Höhenverstellung (eine Gasdruckfeder). Sie wird mit Transportkappe geliefert — vor der Montage abziehen. Sackt ein Stuhl dauernd ab, wird die Gasfeder komplett getauscht; sie hat einen Standard-Konussitz.' },
  'Star base': {
    en: 'The five-arm base of powder-coated aluminium. The gas cylinder drops into its centre cone, thin end down, and locks by taper — no fasteners.',
    de: 'Das fünfarmige Fußkreuz aus pulverbeschichtetem Aluminium. Die Gasdruckfeder kommt mit dem dünnen Ende nach unten in den mittigen Konus und hält allein durch die Klemmwirkung — ganz ohne Schrauben.' },
  'Caster wheels': {
    en: 'The twin wheels of a safety caster (IKEA part 100049021). They roll when you sit and brake automatically when the chair is empty, so it never drifts away.',
    de: 'Die Doppelräder einer Sicherheitsrolle (IKEA-Teil 100049021). Sie rollen, wenn du sitzt, und bremsen automatisch, sobald der Stuhl leer ist — so rollt er nie weg.' },
  'Caster stem': {
    en: 'The press-fit pin that mounts the caster: line it up and push it straight into the base arm — never at an angle, or it will not seat.',
    de: 'Der Steckzapfen, mit dem die Rolle montiert wird: gerade ausrichten und in den Fußkreuzarm drücken — nie schräg, sonst sitzt er nicht.' },
  'Caster brake hood': {
    en: 'The hood over the twin wheels housing the auto-brake that grips when the chair is unloaded. A worn hood is why an empty chair starts to drift.',
    de: 'Die Kappe über den Doppelrädern, in der die Automatikbremse sitzt, die bei entlastetem Stuhl greift. Eine verschlissene Kappe ist der Grund, wenn ein leerer Stuhl anfängt wegzurollen.' },
  'Armrest frame (right)': {
    en: 'The right armrest loop — steel, fixed height, interchangeable with the left. It slides down over the seat edge and is held by two countersunk screws #122134.',
    de: 'Der rechte Armlehnenbügel — Stahl, feste Höhe, mit der linken Seite austauschbar. Er wird von oben über die Sitzkante geschoben und mit zwei Senkschrauben #122134 gehalten.' },
  'Armrest frame (left)': {
    en: 'The left armrest loop — steel, fixed height, interchangeable with the right. It slides down over the seat edge and is held by two countersunk screws #122134.',
    de: 'Der linke Armlehnenbügel — Stahl, feste Höhe, mit der rechten Seite austauschbar. Er wird von oben über die Sitzkante geschoben und mit zwei Senkschrauben #122134 gehalten.' },
  'Armrest pad (right)': {
    en: 'The padded top of the right armrest — polypropylene with synthetic rubber, shaped to take your forearm and ease shoulder strain.',
    de: 'Die gepolsterte Oberseite der rechten Armlehne — Polypropylen mit Synthesekautschuk, geformt für den Unterarm und zur Entlastung der Schultern.' },
  'Armrest pad (left)': {
    en: 'The padded top of the left armrest — polypropylene with synthetic rubber, shaped to take your forearm and ease shoulder strain.',
    de: 'Die gepolsterte Oberseite der linken Armlehne — Polypropylen mit Synthesekautschuk, geformt für den Unterarm und zur Entlastung der Schultern.' },
  'Armrest bolt cap (right)': {
    en: 'One of the two fixing points where countersunk screws #122134 clamp the right armrest to the seat side — the first thing to snug when an arm wobbles.',
    de: 'Einer der beiden Befestigungspunkte, an denen Senkschrauben #122134 die rechte Armlehne an der Sitzseite festklemmen — das Erste, was du nachziehst, wenn eine Lehne wackelt.' },
  'Armrest bolt cap (left)': {
    en: 'One of the two fixing points where countersunk screws #122134 clamp the left armrest to the seat side — the first thing to snug when an arm wobbles.',
    de: 'Einer der beiden Befestigungspunkte, an denen Senkschrauben #122134 die linke Armlehne an der Sitzseite festklemmen — das Erste, was du nachziehst, wenn eine Lehne wackelt.' },
};

const PART_INFO = {
  'markus-chair': MARKUS_INFO,
};

/**
 * Every authored part fact as one "Name: facts" digest — handed to the LLM so
 * it can answer about (and name) whichever part a question concerns, without
 * the app having to guess the part from keywords first.
 */
export function partInfoDigest(modelKey) {
  const info = PART_INFO[modelKey];
  if (!info) return '';
  // Key each fact by the part's DISPLAY name, so the name in the grounding
  // matches the name in the parts list the LLM is given — otherwise a German
  // session would get English keys and echo them back into `PART:` headers.
  return Object.entries(info).map(([name, desc]) => `${localizeName(name)}: ${tr(desc)}`).join(' | ');
}

/** Quiz entries → [{ indices, question, answer }] (only those that matched parts). */
export function resolveQuiz(modelKey, parts) {
  const entries = CONTENT[modelKey]?.quiz ?? [];
  return entries
    .map((e) => ({ indices: findParts(parts, e.match), question: tr(e.question), answer: tr(e.answer) }))
    .filter((e) => e.indices.length > 0);
}

function genericTeardown(parts) {
  const n = Math.min(parts.length, 6);
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ indices: [i], action: 'remove', text: t('teardown.step', { part: partLabel(parts[i]) }) });
  }
  return { title: t('teardown.title'), steps };
}
