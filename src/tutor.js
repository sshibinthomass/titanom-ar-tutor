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
 * context: { modelLabel, parts:[names], mode, focusedPart, partInfo, diagnostics }
 *
 * Returns { part, answer }: `part` is the part the question turned out to be
 * about (a name from context.parts, or null) so the app can highlight it, and
 * `answer` is the short spoken reply. The LLM decides the part — a question
 * about ANY part is answered (and that part spotlighted), even while another
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
    const answer = `I can't reach the AI tutor right now, but you're looking at the ${focusPart || context.modelLabel}.`;
    trace.end({ output: answer, metadata: { aiAvailable: false } });
    return { part: null, answer };
  }

  const partNames = [...new Set(context.parts || [])];
  const system = [
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
    'Reply in EXACTLY this format: a first line reading PART: <that part\'s name copied exactly from the parts list, or NONE>, then the spoken answer on the next line.',
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

    // Parse the PART: header; tolerate a missing or malformed one by treating
    // the whole reply as the answer (the highlight is a bonus, never a blocker).
    let part = null;
    let answer = raw.trim();
    const m = raw.match(/^\s*PART:\s*([^\n]+)\n+([\s\S]+)$/i);
    if (m) {
      const named = m[1].trim();
      if (!/^none$/i.test(named)) part = named;
      answer = m[2].trim();
    } else {
      answer = raw.replace(/^\s*PART:\s*[^\n]*\n?/i, '').trim() || raw.trim();
    }
    trace.end({ output: answer, metadata: { part } });
    return { part, answer };
  } catch (e) {
    console.warn('answerQuestion failed:', e.message);
    const answer = `Sorry, I couldn't reach the tutor. That part is the ${context.focusedPart || 'one you tapped'}.`;
    trace.end({ output: answer, metadata: { error: e.message } });
    return { part: null, answer };
  }
}
