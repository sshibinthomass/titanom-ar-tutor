/**
 * The "brain" glue: answers spoken questions via DeutschlandGPT with context
 * about what the user is currently looking at. The mic is a pure question
 * channel — spoken phrases are never parsed into app commands (that used to
 * live here as classifyCommand and made the app act on misheard noise).
 */
import { aiAvailable, chat } from './ai.js';
import { startTrace } from './telemetry.js';

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
 * Returns { title, intro, steps:[{ parts:[names], text }] } — steps may be []
 * when the model judges the request unfixable on this object (intro then says
 * why, spoken). Returns null on any AI/parse failure so the caller can fall
 * back to the authored procedure; the demo never dead-ends.
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
    'You are an augmented-reality repair tutor. Produce a step-by-step repair plan that an app will animate on a 3D exploded model, highlighting the named parts and speaking each step out loud.',
    `The object is a ${ctx.modelLabel}. Its parts, with the EXACT names the app knows them by: ${partNames.join('; ')}.`,
    ctx.diagnostics && `Ground truth about this exact object — prefer it and never contradict it: ${ctx.diagnostics}`,
    'Reply with ONLY a JSON object — no markdown fences, no prose before or after — in exactly this shape:',
    '{"title":"short plan title","intro":"one spoken sentence saying what we will do and why","steps":[{"parts":["exact part name"],"text":"one or two short spoken sentences of instruction"}]}',
    'Rules: 3 to 7 steps, in the real repair order. Every entry in "parts" MUST be copied verbatim from the part list above — the part(s) the user physically works on in that step; use [] only if genuinely none apply.',
    'Keep instructions practical and grounded in the ground truth; do NOT invent tools, torque values, measurements, or part numbers it does not support. Plain spoken language, no markdown.',
    'If the request cannot be repaired on this object (wrong object, not a repair, nonsense), return {"title":"","intro":"<one spoken sentence explaining why and what they could ask instead>","steps":[]}.',
  ].filter(Boolean).join(' ');

  try {
    const raw = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: `Fix request: ${request}` }],
      { temperature: 0.2, maxTokens: 900, trace, name: 'fix-plan' }
    );
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
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      parts: Array.isArray(s.parts) ? s.parts.filter((p) => typeof p === 'string' && p.trim()) : [],
      text: s.text.trim(),
    }));
  return {
    title: typeof obj.title === 'string' ? obj.title.trim() : '',
    intro: typeof obj.intro === 'string' ? obj.intro.trim() : '',
    steps,
  };
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
  const fallback = `The ${expected} goes on next. ${stepText}`;

  const trace = startTrace('ai-assemble-next-part', {
    input: `${attempted} → ${expected}`,
    metadata: { model: ctx.modelLabel, attempted, expected },
  });

  if (!aiAvailable()) {
    trace.end({ output: fallback, metadata: { aiAvailable: false } });
    return fallback;
  }

  const system = [
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
 * context: { modelLabel, parts:[names], mode, focusedPart }
 * opts.focusOnly: constrain the answer to `context.focusedPart` alone — used by
 *   Explore mode, where the user selects one part and asks about *that part only*.
 * Returns a short spoken answer, or a graceful fallback if AI is unavailable.
 */
export async function answerQuestion(context, question, { focusOnly = false } = {}) {
  const focusPart = context.focusedPart;
  // Scope the answer to a single part only when we actually have one selected.
  const scoped = focusOnly && !!focusPart;

  // One trace per answer — carries the question, the context the tutor saw, and
  // (when AI is reached) a child generation with the model call + token usage.
  const trace = startTrace('ai-answer', {
    input: question,
    metadata: { model: context.modelLabel, mode: context.mode, focusedPart: focusPart, partCount: (context.parts || []).length, scoped },
  });

  if (!aiAvailable()) {
    const fallback = scoped
      ? `I can't reach the AI tutor right now, but you have the ${focusPart} selected.`
      : `I can't reach the AI tutor right now, but you're looking at the ${focusPart || context.modelLabel}.`;
    trace.end({ output: fallback, metadata: { aiAvailable: false } });
    return fallback;
  }
  let system;
  if (scoped) {
    // Explore: pin the tutor to the one selected part. It must not wander onto
    // other parts, and must decline (briefly) anything that isn't about it.
    system = [
      'You are an augmented-reality repair and assembly tutor speaking out loud to a user.',
      `The user is looking at a ${context.modelLabel} and has selected exactly one part: the "${focusPart}".`,
      `Answer ONLY about the "${focusPart}". Do not describe, compare, or mention any other part of the ${context.modelLabel}.`,
      // The authored per-part facts (materials, part numbers, behaviours) are
      // the ground truth for this part — prefer them over general knowledge.
      context.focusedPartInfo && `Authored facts about the "${focusPart}" — ground your answer in them and do not contradict them: ${context.focusedPartInfo}`,
      `If the question is not about the "${focusPart}", reply in one sentence that you can only talk about the selected ${focusPart} right now, and suggest they select the part they mean.`,
      'Answer in at most two short sentences, plain spoken language, practical and friendly. No markdown, no lists.',
    ].filter(Boolean).join(' ');
  } else {
    const parts = [...new Set(context.parts || [])].join(', ');
    system = [
      'You are an augmented-reality repair and assembly tutor speaking out loud to a user.',
      `The user is looking at a ${context.modelLabel} through their phone camera.`,
      parts && `Its parts are: ${parts}.`,
      focusPart && `They currently have the "${focusPart}" highlighted.`,
      focusPart && context.focusedPartInfo && `Authored facts about the "${focusPart}" — prefer them when the question touches this part: ${context.focusedPartInfo}`,
      context.mode === 'diagnose' && 'They are in Diagnose mode, troubleshooting a fault: name the most likely faulty part and the key fix.',
      // Ground answers in the authored fix/fault knowledge when it applies; fall
      // back to general repair sense otherwise. This is what lets Diagnose answer
      // any spoken question, not just the pre-authored symptom chips.
      context.diagnostics && `Reference knowledge for THIS model — prefer it when relevant, and answer in your own words: ${context.diagnostics}`,
      'Answer in at most two short sentences, plain spoken language, practical and friendly.',
      'If they ask how to fix or replace a part, give the key step. Do not use markdown or lists.',
    ].filter(Boolean).join(' ');
  }

  try {
    const answer = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      { temperature: 0.4, maxTokens: 160, trace, name: 'tutor-answer' }
    );
    trace.end({ output: answer });
    return answer;
  } catch (e) {
    console.warn('answerQuestion failed:', e.message);
    const fallback = `Sorry, I couldn't reach the tutor. That part is the ${context.focusedPart || 'one you tapped'}.`;
    trace.end({ output: fallback, metadata: { error: e.message } });
    return fallback;
  }
}
