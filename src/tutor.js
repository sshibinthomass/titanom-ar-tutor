/**
 * The "brain" glue: answers spoken questions via DeutschlandGPT with context
 * about what the user is currently looking at. The mic is a pure question
 * channel — spoken phrases are never parsed into app commands (that used to
 * live here as classifyCommand and made the app act on misheard noise).
 */
import { aiAvailable, chat, PLAN_MODEL } from './ai.js';
import { startTrace } from './telemetry.js';
import { FIX_ACTIONS, FIX_ACTION_GUIDE, OBJECT_ACTIONS, isObjectAction } from './fixanim.js';
import { getLang, t } from './i18n.js';

/**
 * The language rule, prepended to EVERY system prompt.
 *
 * Two jobs, and the second is the one that needed spelling out: the app is
 * strictly monolingual per selection, so the answer must be in the selected
 * language *even when the question arrives in a different one*. STT is pinned
 * to the selected language, but a bilingual speaker still slips through
 * (Scribe will happily transcribe English words in a German session), and
 * without this line the model mirrors the user's language and the app ends up
 * half German, half English mid-sentence. Model-facing instructions stay in
 * English — that is what these models follow most reliably — while the *output*
 * language is named explicitly.
 */
const LANG_NAME = { en: 'English', de: 'German (Deutsch)' };

function languageRule() {
  const name = LANG_NAME[getLang()] || LANG_NAME.en;
  return `CRITICAL LANGUAGE RULE: You MUST write every word the user will read or hear in ${name}. This applies even if the user's question, or any text quoted to you, is in a different language — never mirror the user's language, never translate your answer into it, never mix languages, and never apologise for the language. Reference material below may be in ${name} already; keep it that way. Use natural, idiomatic, spoken ${name}.`;
}

/**
 * Extra guidance the German voice needs. Spoken German has choices English
 * doesn't, and left unspecified the models drift into stiff written
 * "Sie"-form technical prose that a text-to-speech voice reads badly.
 */
function germanStyle() {
  if (getLang() !== 'de') return null;
  return 'Address the user informally with "du". Use plain spoken German, no bureaucratic Amtsdeutsch. Write out symbols and units as words where a person would say them (for example "46 bis 57 Zentimeter"), and keep any part designation exactly as it appears in the reference material.';
}

/**
 * Diagnose-mode answer. The user picked (or spoke) a symptom that maps to one
 * specific part; ask DeutschlandGPT to explain THAT fault on THAT part, strictly
 * grounded in the authored diagnosis so it can't drift to other parts or invent
 * specifics (torque values, model numbers, steps). Low temperature + an explicit
 * "don't guess" instruction keep it honest; if the AI is unreachable we fall
 * back to the authored line, so the demo never goes silent.
 *
 * ctx: getContext() result (uses modelLabel + diagnostics digest).
 * opts: { symptom, part, reference, question? } — reference is the authored
 * ground-truth diagnosis line; question is an optional user follow-up.
 */
export async function answerDiagnosis(ctx, { symptom, part, reference, question }) {
  const trace = startTrace('ai-diagnose', {
    input: question || symptom,
    metadata: { model: ctx.modelLabel, part, symptom },
  });

  if (!aiAvailable()) {
    trace.end({ output: reference, metadata: { aiAvailable: false } });
    return reference; // graceful fallback: the canned diagnosis line
  }

  const system = [
    languageRule(),
    germanStyle(),
    'You are an augmented-reality repair tutor speaking out loud to a user.',
    `The user is looking at a ${ctx.modelLabel} through their phone camera.`,
    `They report this symptom: "${symptom}". The relevant part is the ${part}.`,
    'Explain the cause and the key fix for THIS symptom on THIS part only — nothing else.',
    'Ground your answer strictly in the reference facts below plus well-established, general repair knowledge for this exact part.',
    'Do NOT invent part names, model numbers, measurements, torque values, prices, or steps that the reference does not support. Do not mention other parts or unrelated faults.',
    "If a detail is not covered by the reference, stay general and say what to check rather than guessing. Never state something you are not sure about.",
    `Reference facts (the ground truth): ${reference}`,
    ctx.diagnostics && `Broader authored knowledge for this model, for context only: ${ctx.diagnostics}`,
    'Answer the specific question if one is given, otherwise explain the cause and fix. At most two short spoken sentences. No markdown, no lists.',
  ].filter(Boolean).join(' ');

  const user = question || `Why does "${symptom}" happen on the ${part}, and how do I fix it?`;

  try {
    const answer = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.2, maxTokens: 160, trace, name: 'diagnose-answer' }
    );
    trace.end({ output: answer });
    return answer;
  } catch (e) {
    console.warn('answerDiagnosis failed:', e.message);
    trace.end({ output: reference, metadata: { error: e.message } });
    return reference; // fall back to the authored line on any AI error
  }
}

/**
 * Fix mode's planner: turn a spoken problem ("it keeps sinking", "the armrest
 * wobbles") into a step-by-step repair plan the app can *animate* — each step
 * names the exact parts to spotlight, so isolate + camera flight + TTS all ride
 * the same guided-step pipeline as before. The plan is grounded in the authored
 * knowledge digest (the real IKEA manual for the Markus) and constrained to the
 * live part list, so DGPT can only reference parts that actually exist in the
 * split model.
 *
 * Each step is split into **beats** — one spoken sentence plus the gesture that
 * illustrates it — so the model on screen does what the voice is describing,
 * sentence by sentence, instead of holding one pose for a whole paragraph.
 *
 * Returns { title, intro, steps:[{ beats:[{ parts:[names], action, text }] }] }
 * — steps may be [] when the model judges the request unfixable on this object
 * (intro then says why, spoken). Returns null on any AI/parse failure so the
 * caller can fall back to the authored procedure; the demo never dead-ends.
 */
export async function generateFixPlan(ctx, request) {
  const trace = startTrace('ai-fix-plan', {
    input: request,
    metadata: { model: ctx.modelLabel, partCount: (ctx.parts || []).length },
  });

  if (!aiAvailable()) {
    trace.end({ output: null, metadata: { aiAvailable: false } });
    return null;
  }

  const partNames = [...new Set(ctx.parts || [])].filter(Boolean);
  const system = [
    languageRule(),
    germanStyle(),
    // The JSON keys and the `action` verbs are machine-read and stay English —
    // only "title", "intro" and each beat's "text" are spoken to the user.
    'Note on the JSON below: the field names and the "action" values are fixed English identifiers and must be copied exactly. The language rule applies to the "title", "intro" and "text" values, which are the only parts the user ever hears.',
    'You are an augmented-reality repair tutor. Produce a step-by-step repair plan that an app will animate on a 3D exploded model, highlighting the named parts and speaking each step out loud.',
    `The object is a ${ctx.modelLabel}. Its parts, with the EXACT names the app knows them by: ${partNames.join('; ')}.`,
    ctx.diagnostics && `Ground truth about this exact object — prefer it and never contradict it: ${ctx.diagnostics}`,
    'Reply with ONLY a JSON object — no markdown fences, no prose before or after — in exactly this shape:',
    '{"title":"short plan title","intro":"one spoken sentence saying what we will do and why","steps":[{"beats":[{"text":"ONE spoken sentence","parts":["exact part name"],"action":"unscrew"}]}]}',
    'Rules: 3 to 6 steps, in the real repair order.',
    // Beats are the whole point of the format: the app speaks one beat at a
    // time and plays that beat's gesture on that beat's parts while it talks.
    'Split every step into 2 to 4 "beats". A beat is ONE short spoken sentence describing ONE physical action, plus the parts it happens to and the gesture that shows it. The app speaks the beats in order and animates each one as it is spoken, so the sentence and the motion MUST describe the same thing. Never put two different actions in one beat.',
    `"action" MUST be one of: ${FIX_ACTIONS.join(', ')}. Meanings: ${FIX_ACTION_GUIDE}`,
    'Every entry in "parts" MUST be copied verbatim from the part list above — the part(s) that beat physically moves.',
    `These actions move the WHOLE chair and take "parts": [] — ${OBJECT_ACTIONS.join(', ')}. Use tip_over for a beat that says to tip or lay the chair down, stand_up when it is set back on its feet, and sit_test for a beat about sitting on it or loading it. Every other action needs at least one part.`,
    'Prefer the most physically specific action: lift_off/drop_in for something that comes straight off or drops straight in, unscrew/screw_in for threaded fasteners, tap_loose for a seized taper, press_fit for something pressed home, spin for wheels, turn for knobs, lever for paddles, wiggle for checking play, swap when a part is replaced by a new one, inspect only when nothing actually moves.',
    'Keep instructions practical and grounded in the ground truth; do NOT invent tools, torque values, measurements, or part numbers it does not support. Plain spoken language, no markdown, and keep each beat under about 25 words so it is quick to say.',
    'If the request cannot be repaired on this object (wrong object, not a repair, nonsense), return {"title":"","intro":"<one spoken sentence explaining why and what they could ask instead>","steps":[]}.',
  ].filter(Boolean).join(' ');

  const messages = [{ role: 'system', content: system }, { role: 'user', content: `Fix request: ${request}` }];
  try {
    let raw;
    try {
      // Planning gets the strongest model (PLAN_MODEL, Opus by default) — a
      // one-shot structured task where quality beats latency.
      raw = await chat(messages, { temperature: 0.2, maxTokens: 2200, trace, name: 'fix-plan', model: PLAN_MODEL });
    } catch (e) {
      // The premium tier can be rate-limited or momentarily down; one retry on
      // the everyday model before giving up to the authored fallback.
      console.warn(`fix-plan on ${PLAN_MODEL} failed (${e.message}), retrying on the default model`);
      raw = await chat(messages, { temperature: 0.2, maxTokens: 2200, trace, name: 'fix-plan-retry' });
    }
    const plan = extractFixPlan(raw);
    trace.end({ output: plan, metadata: { steps: plan?.steps?.length ?? 0, parsed: !!plan } });
    return plan;
  } catch (e) {
    console.warn('generateFixPlan failed:', e.message);
    trace.end({ output: null, metadata: { error: e.message } });
    return null;
  }
}

// Tolerant JSON extraction: models sometimes wrap the object in fences or a
// stray sentence, so slice from the first '{' to the last '}' before parsing.
function extractFixPlan(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || !Array.isArray(obj.steps)) return null;
  const steps = obj.steps
    // A step is a list of beats; a step that came back in the older flat shape
    // ({parts, action, text}) is read as a single beat.
    .map((s) => (s && Array.isArray(s.beats) ? s.beats : [s]))
    .map((beats) => beats.filter((b) => b && typeof b.text === 'string' && b.text.trim()).map(normalizeBeat))
    .filter((beats) => beats.length)
    .map((beats) => ({ beats }));
  if (!steps.length && !(typeof obj.intro === 'string' && obj.intro.trim())) return null;
  return {
    title: typeof obj.title === 'string' ? obj.title.trim() : '',
    intro: typeof obj.intro === 'string' ? obj.intro.trim() : '',
    steps,
  };
}

function normalizeBeat(b) {
  // Whitelisted verb → gesture; anything invented degrades to 'inspect'.
  let action = FIX_ACTIONS.includes(b.action) ? b.action : 'inspect';
  const parts = Array.isArray(b.parts) ? b.parts.filter((p) => typeof p === 'string' && p.trim()) : [];
  // A part-level gesture with no parts has nothing to move; keep the sentence
  // but let it play as the whole-object "look it over" rather than silently
  // animating nothing.
  if (!parts.length && !isObjectAction(action)) action = 'inspect';
  return { parts, action, text: b.text.trim() };
}

/**
 * Assemble-puzzle guidance, spoken when a piece doesn't go in.
 *
 * Phrased as an **instruction, not a correction**: name the part that goes on
 * next and why it has to come first. The learner already knows the drop failed —
 * the shake and the flash said so — and being told "not yet, that's the seat"
 * adds a scold on top without adding information. What they need is the part to
 * reach for. So the wrong attempt is context for the model, never something it
 * repeats back.
 *
 * Kept to one spoken sentence because it fires mid-build, and grounded in the
 * authored order so it explains this chair's real sequence rather than one it
 * invented.
 *
 * ctx: getContext() result. opts: { attempted, expected, stepText }.
 */
export async function explainNextPart(ctx, { attempted, expected, stepText }) {
  const fallback = t('tutor.nextFallback', { part: expected, step: stepText });

  const trace = startTrace('ai-assemble-next-part', {
    input: `${attempted} → ${expected}`,
    metadata: { model: ctx.modelLabel, attempted, expected },
  });

  if (!aiAvailable()) {
    trace.end({ output: fallback, metadata: { aiAvailable: false } });
    return fallback;
  }

  const system = [
    languageRule(),
    germanStyle(),
    'You are an augmented-reality assembly tutor speaking out loud to a learner.',
    `They are building a ${ctx.modelLabel}. The part that goes on next is the "${expected}".`,
    `The step is: ${stepText}`,
    `Say in ONE short spoken sentence which part to fit next and why it has to go on before the rest — a physical reason (what it bolts to, what has to support it, what it would block). Start with the "${expected}".`,
    // They just tried the wrong piece; that is context for you, not something to
    // repeat. Telling them they were wrong adds nothing they don't already know.
    `Do NOT mention that they made a mistake, and do not refer to the "${attempted}" as a wrong choice. No "not yet", no "instead", no correction language — just say what to fit and why.`,
    'Be direct and practical. Do not invent measurements, tools or part names. No markdown, no lists.',
    ctx.diagnostics && `Reference knowledge for this model: ${ctx.diagnostics}`,
  ].filter(Boolean).join(' ');

  try {
    const answer = await chat(
      [{ role: 'system', content: system },
       { role: 'user', content: `What goes on next, and why does the ${expected} have to go on first?` }],
      { temperature: 0.3, maxTokens: 90, trace, name: 'assemble-next-part' }
    );
    trace.end({ output: answer });
    return answer;
  } catch (e) {
    console.warn('explainNextPart failed:', e.message);
    trace.end({ output: fallback, metadata: { error: e.message } });
    return fallback;
  }
}

/**
 * Answer a free-form question about the current object via DeutschlandGPT.
 * context: { modelLabel, parts:[names], mode, focusedPart, partInfo, diagnostics }
 *
 * Returns { part, action, answer }: `part` is the part the question turned out
 * to be about (a name from context.parts, or null) so the app can highlight it,
 * `action` is the FIX_ACTIONS verb for the physical motion the answer describes
 * (or null when it's informational) so the app can *animate* it, and `answer`
 * is the short spoken reply. The LLM decides both — a question about ANY part
 * is answered (and that part spotlighted, and shown moving), even while another
 * is selected; `focusedPart` only resolves "this"/"it". The tutor declines
 * only when the question has nothing to do with the object at all.
 */
export async function answerQuestion(context, question) {
  const focusPart = context.focusedPart;

  // One trace per answer — carries the question, the context the tutor saw, and
  // (when AI is reached) a child generation with the model call + token usage.
  const trace = startTrace('ai-answer', {
    input: question,
    metadata: { model: context.modelLabel, mode: context.mode, focusedPart: focusPart, partCount: (context.parts || []).length },
  });

  if (!aiAvailable()) {
    const answer = t('tutor.noAi', { subject: focusPart || context.modelLabel });
    trace.end({ output: answer, metadata: { aiAvailable: false } });
    return { part: null, action: null, answer };
  }

  const partNames = [...new Set(context.parts || [])];
  const system = [
    languageRule(),
    germanStyle(),
    // PART:/ACTION: are parsed by the app, so they are exempt from the language
    // rule — without saying so, a German session returns "TEIL:" and the
    // highlight silently stops working.
    'Two exceptions to the language rule: the literal header words "PART:" and "ACTION:" below stay in English exactly as written, and the ACTION verb is one of the fixed English identifiers listed. Everything else — the spoken answer — follows the language rule. The part name after PART: is copied verbatim from the parts list, whatever language that list is in.',
    'You are an augmented-reality repair and assembly tutor speaking out loud to a user.',
    `The user is looking at a ${context.modelLabel} through their phone camera.`,
    partNames.length && `Its parts are: ${partNames.join(', ')}.`,
    focusPart && `The "${focusPart}" is currently highlighted — words like "this", "it" or "that part" refer to it unless the question names a different part.`,
    // The authored per-part facts (materials, part numbers, behaviours) are the
    // ground truth. Giving the LLM ALL of them lets it answer about whichever
    // part the question concerns without the app guessing from keywords first.
    context.partInfo && `Reference facts per part — treat these as ground truth and never contradict them: ${context.partInfo}`,
    context.mode === 'diagnose' && 'They are in Diagnose mode, troubleshooting a fault: name the most likely faulty part and the key fix.',
    context.diagnostics && `Repair and fault knowledge for THIS model — prefer it when relevant, and answer in your own words: ${context.diagnostics}`,
    'First work out which single part from the parts list the question is mainly about, if any.',
    'Reply in EXACTLY this format: a first line reading PART: <that part\'s name copied exactly from the parts list, or NONE>, a second line reading ACTION: <verb or NONE>, then the spoken answer on the next line.',
    `ACTION is the single physical motion your answer tells the user to perform on that part — the app animates it on the 3D model. It MUST be one of: ${FIX_ACTIONS.join(', ')}. Meanings: ${FIX_ACTION_GUIDE} Use NONE when the answer is purely informational or PART is NONE.`,
    'The spoken answer is at most two short sentences, plain spoken language, practical and friendly. No markdown, no lists.',
    `Answer questions about the ${context.modelLabel} as a whole with PART: NONE and a normal answer.`,
    `Only if the question is unrelated to the ${context.modelLabel} and its parts entirely (small talk, other objects, other topics), reply PART: NONE and one sentence saying you can only answer questions about this ${context.modelLabel}.`,
  ].filter(Boolean).join(' ');

  try {
    const raw = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      { temperature: 0.4, maxTokens: 200, trace, name: 'tutor-answer' }
    );

    // Parse the PART:/ACTION: headers; tolerate missing or malformed ones by
    // treating the rest as the answer (highlight + motion are bonuses, never
    // blockers). ACTION is whitelisted — an invented verb is dropped.
    let part = null;
    let action = null;
    let answer = raw.trim();
    // TEIL:/AKTION: are accepted as well: the headers are told to stay English,
    // but a model deep in a German answer occasionally translates them anyway,
    // and losing the highlight over that would be a silly way to fail.
    const m = raw.match(/^\s*(?:PART|TEIL):\s*([^\n]+)\n+(?:(?:ACTION|AKTION):\s*([^\n]+)\n+)?([\s\S]+)$/i);
    if (m) {
      const named = m[1].trim();
      if (!/^(?:none|keine[sr]?|kein)$/i.test(named)) part = named;
      const verb = (m[2] || '').trim().toLowerCase();
      if (FIX_ACTIONS.includes(verb)) action = verb;
      answer = m[3].trim();
    } else {
      answer = raw.replace(/^\s*(?:PART|TEIL|ACTION|AKTION):\s*[^\n]*\n?/gim, '').trim() || raw.trim();
    }
    trace.end({ output: answer, metadata: { part, action } });
    return { part, action, answer };
  } catch (e) {
    console.warn('answerQuestion failed:', e.message);
    const answer = t('tutor.failed', { part: context.focusedPart || t('tutor.thatPart') });
    trace.end({ output: answer, metadata: { error: e.message } });
    return { part: null, action: null, answer };
  }
}
