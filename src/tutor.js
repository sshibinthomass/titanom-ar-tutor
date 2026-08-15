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

/**
 * What kind of answer a fix request deserves. The planner used to have only two
 * endings — a repair, or an empty plan for nonsense — so a question about a part
 * that genuinely cannot be serviced ("the mesh sags", "the headrest slips") got
 * an invented repair, complete with invented hardware. Naming the honest endings
 * is what lets it say "this is replaced as a unit" instead.
 */
export const PLAN_KINDS = ['adjustment', 'repair', 'replace', 'not_applicable'];

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
 * Returns { kind, title, intro, steps:[{ beats:[{ parts:[names], action, text }] }] }
 * — steps may be [] when the model judges the request unfixable on this object
 * (intro then says why, spoken). Returns null on any AI/parse failure so the
 * caller can fall back to the authored procedure; the demo never dead-ends.
 *
 * `opts.fault` is the authored fault the request matched (modes.matchFault), if
 * any — the established cause to build the plan around rather than reinvent.
 */
export async function generateFixPlan(ctx, request, { fault } = {}) {
  const trace = startTrace('ai-fix-plan', {
    input: request,
    metadata: { model: ctx.modelLabel, partCount: (ctx.parts || []).length, matchedFault: fault?.symptom || null },
  });

  if (!aiAvailable()) {
    trace.end({ output: null, metadata: { aiAvailable: false } });
    return null;
  }

  const system = planSystemPrompt(ctx, fault);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: `Fix request: ${request}` }];
  try {
    let raw;
    try {
      // Planning gets the strongest model (PLAN_MODEL, Opus by default) — a
      // one-shot structured task where quality beats latency.
      // Beats make a plan verbose: 6 steps x 4 beats of JSON runs well past
      // 2000 tokens, and a cut-off reply used to fail to parse and drop us into
      // the authored procedure — i.e. silently answering a different question.
      raw = await chat(messages, { temperature: 0.2, maxTokens: 4000, trace, name: 'fix-plan', model: PLAN_MODEL });
    } catch (e) {
      // The premium tier can be rate-limited or momentarily down; one retry on
      // the everyday model before giving up to the authored fallback.
      console.warn(`fix-plan on ${PLAN_MODEL} failed (${e.message}), retrying on the default model`);
      raw = await chat(messages, { temperature: 0.2, maxTokens: 4000, trace, name: 'fix-plan-retry' });
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

/**
 * The planner's system prompt, shared with the repair round-trip below.
 *
 * The ORDER is load-bearing, and it is what the first version got wrong. The
 * grounding used to be one 5k-character block of reference prose in the middle
 * of the prompt, and the facts that got violated most (which lever is on which
 * side, that the taper joints have no fasteners, that the headrest does not
 * adjust) were all subordinate clauses buried in it. So: the reference material
 * goes in the middle where it can be consulted, and `ctx.rules` — the same facts
 * restated as six short imperatives — goes LAST, immediately before the model
 * starts writing. Recency is most of what makes a rule stick.
 */
function planSystemPrompt(ctx, fault) {
  const partNames = [...new Set(ctx.parts || [])].filter(Boolean);
  return [
    languageRule(),
    germanStyle(),
    // The JSON keys and the `action` verbs are machine-read and stay English —
    // only "title", "intro" and each beat's "text" are spoken to the user.
    'Note on the JSON below: the field names and the "action" and "kind" values are fixed English identifiers and must be copied exactly. The language rule applies to the "title", "intro" and "text" values, which are the only parts the user ever hears.',
    'You are an augmented-reality repair tutor. Produce a step-by-step repair plan that an app will animate on a 3D exploded model, highlighting the named parts and speaking each step out loud.',
    `The object is a ${ctx.modelLabel}. Its parts, with the EXACT names the app knows them by: ${partNames.join('; ')}.`,
    // MARKUS_INFO. The planner used to be the one caller that never saw this,
    // while the free-form tutor did — and several facts live ONLY here (that the
    // star base takes the cylinder by taper "with no fasteners" is the one that
    // cost the most, because without it the model invents bolts to undo).
    ctx.partInfo && `Reference facts per part — treat these as ground truth and never contradict them: ${ctx.partInfo}`,
    ctx.faults && `Ground truth about this exact object — prefer it and never contradict it: ${ctx.faults}`,
    // Retrieval: when the request matches a documented fault, the cause is not
    // the model's to work out. Expanding a known remedy into beats is a far
    // safer job than inventing a repair, and it is what keeps the flagship
    // demos identical run to run.
    fault && `This request matches a DOCUMENTED fault of this exact object — "${fault.symptom}": ${fault.text} That is the established cause and remedy. Build the plan around it, do not propose a different cause, and do not contradict it.`,
    'Reply with ONLY a JSON object — no markdown fences, no prose before or after — in exactly this shape:',
    '{"kind":"repair","title":"short plan title","intro":"one spoken sentence saying what we will do and why","steps":[{"beats":[{"text":"ONE spoken sentence","parts":["exact part name"],"action":"unscrew"}]}]}',
    // Four honest endings. With only "a plan" or "no plan" on offer, a request
    // about a part that cannot be serviced was answered with an invented repair
    // — the model read the empty-plan escape hatch as being about nonsense
    // questions, which this one was not.
    '"kind" says what kind of answer this is, and it decides the shape of the plan:',
    '"adjustment" — nothing is broken and nothing comes apart; the user just needs to work a control or change a setting. Give 1 to 3 short steps and never disassemble anything.',
    '"repair" — a genuine repair. Give 3 to 6 steps in the real repair order.',
    '"replace" — the faulty part cannot be serviced, adjusted or tightened on this object and its assembly is replaced as a unit. Give 2 to 3 steps that confirm the fault and say plainly what gets replaced. NEVER invent an adjustment or a fastener to make such a part serviceable — saying it is not repairable is the correct answer.',
    '"not_applicable" — wrong object, not a repair, or nonsense. Return "steps":[] with an intro saying why and what they could ask instead.',
    // Beats are the whole point of the format: the app speaks one beat at a
    // time and plays that beat's gesture on that beat's parts while it talks.
    'Split every step into 2 to 4 "beats". A beat is ONE short spoken sentence describing ONE physical action, plus the parts it happens to and the gesture that shows it. The app speaks the beats in order and animates each one as it is spoken, so the sentence and the motion MUST describe the same thing. Never put two different actions in one beat.',
    `"action" MUST be one of: ${FIX_ACTIONS.join(', ')}. Meanings: ${FIX_ACTION_GUIDE}`,
    'Every entry in "parts" MUST be copied verbatim from the part list above — the part(s) that beat physically moves.',
    `These actions move the WHOLE chair and take "parts": [] — ${OBJECT_ACTIONS.join(', ')}. Every other action needs at least one part.`,
    'Pick the most physically specific action for what the sentence actually says — that is the whole point, because the user watches it happen. Use inspect ONLY when nothing moves at all; if the sentence says to clean it use wipe, to grease it use grease, to line it up use align, to check it is tight use tug, to check it for play use wiggle, to pop a cap off use unclip.',
    'Keep instructions practical and grounded in the ground truth; do NOT invent tools, torque values, measurements, or part numbers it does not support. Plain spoken language, no markdown, and keep each beat under about 25 words so it is quick to say.',
    'Before you answer, check the request against the hard constraints below. If they say the part cannot be serviced, the answer is "replace" — not a repair you had to invent hardware for.',
    // Last, and deliberately so.
    ctx.rules && `HARD CONSTRAINTS about this exact object. These override anything you believe about office chairs in general, and a plan that breaks one of them is wrong: ${ctx.rules}`,
  ].filter(Boolean).join(' ');
}

/**
 * Second chance for a plan that broke a hard constraint.
 *
 * lintPlan() catches the specific, checkable violations deterministically, and
 * this is what the app does about them: quote the broken rules back with the
 * offending sentences and ask for the whole plan again. One round-trip only —
 * the caller drops the still-offending beats rather than arguing further, since
 * a model that has ignored the same rule twice will not honour a third ask.
 */
export async function repairFixPlan(ctx, request, plan, violations, { fault } = {}) {
  const trace = startTrace('ai-fix-plan-repair', {
    input: request,
    metadata: { model: ctx.modelLabel, violations: violations.length },
  });

  if (!aiAvailable() || !violations.length) {
    trace.end({ output: null, metadata: { skipped: true } });
    return null;
  }

  const complaints = violations
    .map((v, i) => `${i + 1}. Step ${v.step + 1}, the sentence "${v.text}" breaks this rule: ${v.rule}`)
    .join(' ');

  const messages = [
    { role: 'system', content: planSystemPrompt(ctx, fault) },
    { role: 'user', content: `Fix request: ${request}` },
    { role: 'assistant', content: JSON.stringify(plan) },
    { role: 'user', content: `That plan breaks hard constraints about this object: ${complaints} Rewrite the WHOLE plan as one JSON object in the same shape, correcting exactly those problems and keeping everything else. If a part turns out not to be serviceable, return "kind":"replace" and say plainly that the assembly is replaced rather than inventing a way to service it.` },
  ];

  try {
    const raw = await chat(messages, { temperature: 0.1, maxTokens: 4000, trace, name: 'fix-plan-repair', model: PLAN_MODEL });
    const repaired = extractFixPlan(raw);
    trace.end({ output: repaired, metadata: { steps: repaired?.steps?.length ?? 0 } });
    return repaired;
  } catch (e) {
    console.warn('repairFixPlan failed:', e.message);
    trace.end({ output: null, metadata: { error: e.message } });
    return null;
  }
}

// Tolerant JSON extraction: models sometimes wrap the object in fences or a
// stray sentence, so slice from the first '{' to the last '}' before parsing.
function extractFixPlan(raw) {
  const text = String(raw || '');
  const m = text.match(/\{[\s\S]*\}/);
  // A reply cut off by the token limit has no closing brace at all, so the
  // greedy match above finds nothing — fall back to the truncation repair.
  const candidate = m ? m[0] : text.slice(text.indexOf('{'));
  if (!candidate || candidate[0] !== '{') return null;
  let obj = null;
  try { obj = JSON.parse(candidate); } catch { obj = parseTruncated(candidate); }
  if (!obj || !Array.isArray(obj.steps)) return null;
  const steps = obj.steps
    // A step is a list of beats; a step that came back in the older flat shape
    // ({parts, action, text}) is read as a single beat.
    .map((s) => (s && Array.isArray(s.beats) ? s.beats : [s]))
    .map((beats) => beats.filter((b) => b && typeof b.text === 'string' && b.text.trim()).map(normalizeBeat))
    .filter((beats) => beats.length)
    .map((beats) => ({ beats }));
  if (!steps.length && !(typeof obj.intro === 'string' && obj.intro.trim())) return null;
  // An unrecognised or missing kind degrades to 'repair' — the shape the app
  // played before kinds existed, so a model that ignores the field costs nothing.
  const kind = PLAN_KINDS.includes(obj.kind) ? obj.kind : 'repair';
  return {
    kind,
    title: typeof obj.title === 'string' ? obj.title.trim() : '',
    intro: typeof obj.intro === 'string' ? obj.intro.trim() : '',
    steps,
  };
}

/**
 * Salvage a plan whose JSON was cut off mid-flight (the model hit its token
 * limit). Walks the text tracking string state and bracket depth, finds the
 * last point where a complete step object closed, and shuts the structure
 * there — so the user gets the steps that did arrive instead of being dropped
 * into an unrelated authored procedure. Returns null if not even one step
 * finished.
 */
function parseTruncated(s) {
  let inStr = false, esc = false, lastStepEnd = -1;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      // Depth 2 left on the stack = the root object and the "steps" array, so
      // the brace just closed was one whole step.
      if (c === '}' && stack.length === 2) lastStepEnd = i;
    }
  }
  if (lastStepEnd < 0) return null;
  try {
    const plan = JSON.parse(s.slice(0, lastStepEnd + 1) + ']}');
    console.warn(`fix-plan reply was truncated; recovered ${plan.steps?.length ?? 0} complete steps`);
    return plan;
  } catch { return null; }
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
    ctx.faults && `Reference knowledge for this model: ${ctx.faults}`,
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
 * Read a spoken utterance in the Assemble puzzle as the learner's **answer** to
 * "which part goes on next?".
 *
 * Why this needs an LLM rather than a keyword table: the puzzle reveals a part's
 * name only *after* it has been placed correctly, so on the intended path the
 * learner cannot yet know what the piece is called. Describing it by shape,
 * position or function ("the star thing at the bottom", "the pole in the
 * middle") is a legitimate answer to a prompt that asked about function, and
 * resolving that to one part is exactly the semantic job DGPT is for. main.js
 * tries an exact local match first, so this only runs for the descriptive case.
 *
 * The model is deliberately **not told which part is correct**. Given the answer
 * it would helpfully map any vague noise onto it and the puzzle would become
 * unloseable; its only job is to report what the learner said.
 *
 * `candidates` are display-language names of the unplaced parts. Returns
 * { part, question }: `part` is the candidate the utterance named (null if
 * none), and `question` is true when it wasn't an attempt at a part at all — in
 * which case main.js falls through to the normal question channel.
 */
export async function resolveSpokenPart(ctx, phrase, candidates) {
  if (!aiAvailable() || !candidates.length) return { part: null, question: false };

  const trace = startTrace('ai-assemble-answer', {
    input: phrase,
    metadata: { model: ctx.modelLabel, candidates: candidates.length },
  });

  const system = [
    languageRule(),
    // Nothing here is spoken or shown: the whole reply is one machine-read
    // header, and the part name in it is a lookup key, not prose.
    'Exception to the language rule: this reply is machine-read and never shown to anyone. Output ONLY the single header line described below. The part name in it is copied verbatim from the candidate list, in whatever language that list uses — never translate it, never rephrase it.',
    'You are the input parser for an assembly-training app.',
    `A learner is rebuilding a ${ctx.modelLabel}. They were asked which part goes on next and answered out loud; this is the transcript of what they said.`,
    `The parts still waiting to be fitted are: ${candidates.join('; ')}.`,
    'If the utterance names or describes exactly one of those parts, output that part. Learners usually have not been told the name yet, so they describe the piece by its shape, its position or what it does — map such a description to the one part it can be.',
    'If the utterance is a question, a request for a hint, or thinking out loud rather than an attempt to identify a part, output QUESTION.',
    'If it is an attempt to identify a part but you cannot tell which one, or it fits several equally well, output NONE.',
    // Without this the model reasons about what the app *wants* to hear.
    'You are NOT told which part is the correct answer, and you must not try to work it out or guess at it. Report only what the learner actually said, even when that is plainly the wrong part.',
    'Reply with exactly one line and nothing else: ANSWER: <a part name copied from the list, or QUESTION, or NONE>',
  ].filter(Boolean).join(' ');

  try {
    const raw = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: phrase }],
      { temperature: 0, maxTokens: 30, trace, name: 'assemble-answer' }
    );
    // Tolerate a missing header — a bare part name is still usable.
    const line = (raw.match(/ANSWER:\s*([^\n]+)/i)?.[1] || raw).trim().replace(/[.!?"']+$/, '');
    const question = /^(?:question|frage)$/i.test(line);
    const none = /^(?:none|keine[sr]?|kein|unklar)$/i.test(line);
    const part = question || none || !line ? null : line;
    trace.end({ output: line, metadata: { part, question } });
    return { part, question };
  } catch (e) {
    console.warn('resolveSpokenPart failed:', e.message);
    trace.end({ output: null, metadata: { error: e.message } });
    // Unreachable AI must not swallow the utterance: report it as a question so
    // the caller hands it to the question channel instead of failing the step.
    return { part: null, question: true };
  }
}

/**
 * Answer a free-form question about the current object via DeutschlandGPT.
 * context: { modelLabel, parts:[names], mode, focusedPart, partInfo, faults }
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
    context.faults && `Repair and fault knowledge for THIS model — prefer it when relevant, and answer in your own words: ${context.faults}`,
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
