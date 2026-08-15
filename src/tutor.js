/**
 * The "brain" glue: turns spoken phrases into either an app command
 * (next / back / switch mode / explode …) or a free-form question answered by
 * DeutschlandGPT with context about what the user is currently looking at.
 */
import { aiAvailable, chat } from './ai.js';
import { startTrace } from './telemetry.js';

/**
 * Classify a spoken phrase into an app command or a free-form question.
 *
 * Returns { type:'command', ... } for anything the app can act on directly, or
 * { type:'question', text } to hand off to the AI tutor. This covers only the
 * *model-independent* commands — matching a spoken phrase to a specific model,
 * part, or symptom is data-driven and lives in main.js (which owns the live
 * part/model lists), tried after this returns a plain question.
 *
 * Ordering matters: more specific phrases are checked before generic ones so
 * "stop spinning" reaches autorotate, not the bare "stop → be quiet" catch.
 */
export function classifyCommand(raw) {
  const t = raw.toLowerCase().trim();
  const has = (...words) => words.some((w) => t.includes(w));
  // Generic "turn it off" intent shared by the display toggles below.
  const negated = has(' off', 'turn off', 'disable', 'hide', 'without');

  // --- Silence / mic (check specific "stop X" before the bare-stop fallback) ---
  if (has('stop listening', 'stop the mic', 'mic off', 'turn off the mic', 'stop mic', "don't listen"))
    return { type: 'command', action: 'stopListening' };
  if (has('be quiet', 'quiet', 'stop talking', 'stop speaking', 'stop reading', 'shush', 'shut up', 'silence', 'stop the audio', 'stop the tutor'))
    return { type: 'command', action: 'stopSpeaking' };

  // --- Help ---
  if (has('what can i say', 'what can you do', 'help me', 'list commands', 'voice commands', 'list the commands', 'how do i use'))
    return { type: 'command', action: 'help' };

  // --- AR ---
  if (has('exit ar', 'stop ar', 'leave ar', 'close ar', 'quit ar', 'end ar', 'exit augmented', 'leave augmented', 'exit a r', 'stop a r'))
    return { type: 'command', action: 'exitAR' };
  if (has('start ar', 'enter ar', 'begin ar', 'launch ar', 'open ar', 'go to ar', 'start a r', 'enter a r', 'augmented reality', 'place it on the floor', 'place it in the room'))
    return { type: 'command', action: 'startAR' };
  if (has('move it', 'reposition', 'move the chair', 'move the object', 'move the model', 'relocate', 'place it somewhere', 'put it somewhere else'))
    return { type: 'command', action: 'move' };

  // --- Display toggles ---
  if (has('wireframe', 'wire frame', 'x-ray', 'x ray', 'mesh view'))
    return { type: 'command', action: 'wireframe', value: !negated };
  if (has('tint', 'color the parts', 'colour the parts', 'colored parts', 'coloured parts', 'part colors', 'part colours', 'rainbow'))
    return { type: 'command', action: 'tint', value: !negated };
  if (has('spin', 'auto rotate', 'autorotate', 'auto-rotate', 'rotate it', 'turntable', 'keep rotating', 'stop spinning', 'stop rotating', 'stop turning')) {
    const stop = has('stop', 'no ', 'without', "don't");
    return { type: 'command', action: 'autorotate', value: !stop };
  }
  if (has('recenter', 're-center', 'reset view', 'reset the view', 'center it', 'centre it', 'frame it', 'reset camera', 'reset the camera', 'fit to screen', 'fit it', 'zoom out', 'default view'))
    return { type: 'command', action: 'recenter' };

  // --- Explode / collapse ---
  if (has('collapse', 'unexplode', 'un-explode', 'close it up', 'bring it together', 'bring it back', 'come together', 'put the pieces back', 'pieces back together', 'implode'))
    return { type: 'command', action: 'collapse' };
  if (has('explode halfway', 'half explode', 'explode a little', 'explode partially', 'partially explode', 'explode a bit'))
    return { type: 'command', action: 'explode', amount: 0.5 };
  if (has('explode', 'take apart', 'auseinander', 'break apart', 'blow it apart', 'blow apart', 'separate the parts', 'spread it out', 'spread the parts', 'pull it apart'))
    return { type: 'command', action: 'explode' };

  // --- Quiz reveal ---
  if (has('reveal', 'show the answer', 'show answer', 'give up', "i don't know", 'i dont know', 'no idea', "what's the answer", 'whats the answer', 'tell me the answer'))
    return { type: 'command', action: 'reveal' };

  // --- Step / list navigation ---
  if (has('next', 'weiter', 'continue', 'go on', 'move on', 'forward', 'skip'))
    return { type: 'command', action: 'next' };
  if (has('back', 'previous', 'zurück', 'go back', 'last step', 'step back', 'one back'))
    return { type: 'command', action: 'back' };
  if (has('repeat', 'again', 'wiederhol', 'say that', 'come again', 'one more time', 'read it again'))
    return { type: 'command', action: 'repeat' };
  if (has('reset', 'start over', 'reassemble', 'put it back', 'restart', 'begin again'))
    return { type: 'command', action: 'reset' };

  // --- Mode switches ---
  if (has('assemble', 'build it', 'zusammenbau', 'put together', 'assembly mode', 'build mode', 'how to build'))
    return { type: 'command', mode: 'assemble' };
  if (has('fix', 'repair', 'reparier', 'how to fix', 'fix it', 'fix mode', 'repair mode'))
    return { type: 'command', mode: 'fix' };
  if (has('diagnose', "what's wrong", 'whats wrong', 'diagnosis', 'diagnostic', 'troubleshoot', "what's the problem", 'whats the problem', 'not working', 'diagnose mode'))
    return { type: 'command', mode: 'diagnose' };
  if (has('quiz', 'test me', 'question me', 'quiz me', 'quiz mode'))
    return { type: 'command', mode: 'quiz' };
  if (has('explore', 'look around', 'show parts', 'explore mode', 'browse', 'free look'))
    return { type: 'command', mode: 'explore' };

  // --- Ask about the current / a specific part ---
  if (has('what is this', 'whats this', 'what is that', 'explain this', 'this part', 'tell me about this', 'what am i looking at'))
    return { type: 'command', action: 'explain' };

  // Bare "stop" with nothing else matched → silence the tutor.
  if (t === 'stop' || t === 'stopp') return { type: 'command', action: 'stopSpeaking' };

  return { type: 'question', text: raw.trim() };
}

/**
 * Heuristic: does a phrase read as a *question* rather than a part name or a
 * "show me X" navigation request? Explore mode uses this to decide between
 * selecting a part and answering about the one already selected — so that
 * "what is the seat made of?" is answered instead of merely re-selecting it.
 *
 * Deliberately excludes the navigational interrogatives "where"/"which" — those
 * ("where is the seat", "which is the backrest") should highlight the part, not
 * trigger a spoken lecture.
 */
export function looksLikeQuestion(text) {
  const t = text.toLowerCase().trim();
  if (t.endsWith('?')) return true;
  // Starts with an interrogative / auxiliary (question grammar).
  if (/^(what|why|how|when|who|whose|can|could|should|would|does|do|is|are|will|tell|explain|describe)\b/.test(t)) return true;
  // Contains a clearly informational phrase anywhere in the utterance.
  if (/\b(made of|material|used for|use for|purpose|function|difference between|is it made|how (do|does)|does it (do|work))\b/.test(t)) return true;
  return false;
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
