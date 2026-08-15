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
      `If the question is not about the "${focusPart}", reply in one sentence that you can only talk about the selected ${focusPart} right now, and suggest they select the part they mean.`,
      'Answer in at most two short sentences, plain spoken language, practical and friendly. No markdown, no lists.',
    ].join(' ');
  } else {
    const parts = [...new Set(context.parts || [])].join(', ');
    system = [
      'You are an augmented-reality repair and assembly tutor speaking out loud to a user.',
      `The user is looking at a ${context.modelLabel} through their phone camera.`,
      parts && `Its parts are: ${parts}.`,
      focusPart && `They currently have the "${focusPart}" highlighted.`,
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
