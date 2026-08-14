/**
 * The "brain" glue: turns spoken phrases into either an app command
 * (next / back / switch mode / explode …) or a free-form question answered by
 * DeutschlandGPT with context about what the user is currently looking at.
 */
import { aiAvailable, chat } from './ai.js';

/** Classify a spoken phrase. Returns { type:'command', ... } or { type:'question', text }. */
export function classifyCommand(raw) {
  const t = raw.toLowerCase().trim();
  const has = (...words) => words.some((w) => t.includes(w));

  // Navigation
  if (has('next', 'weiter', 'continue', 'go on')) return { type: 'command', action: 'next' };
  if (has('back', 'previous', 'zurück', 'go back')) return { type: 'command', action: 'back' };
  if (has('repeat', 'again', 'wiederhol', 'say that')) return { type: 'command', action: 'repeat' };
  if (has('reset', 'start over', 'reassemble', 'put it back')) return { type: 'command', action: 'reset' };
  if (has('explode', 'take apart', 'auseinander', 'break apart')) return { type: 'command', action: 'explode' };

  // Mode switches
  if (has('assemble', 'build', 'zusammenbau', 'put together')) return { type: 'command', mode: 'assemble' };
  if (has('fix', 'repair', 'reparier')) return { type: 'command', mode: 'fix' };
  if (has('diagnose', "what's wrong", 'whats wrong', 'problem', 'not working')) return { type: 'command', mode: 'diagnose' };
  if (has('quiz', 'test me', 'question me')) return { type: 'command', mode: 'quiz' };
  if (has('explore', 'look around', 'show parts')) return { type: 'command', mode: 'explore' };

  // Ask about the current / a specific part
  if (has('what is this', 'whats this', 'what is that', 'explain this', 'this part')) {
    return { type: 'command', action: 'explain' };
  }

  return { type: 'question', text: raw.trim() };
}

/**
 * Answer a free-form question about the current object via DeutschlandGPT.
 * context: { modelLabel, parts:[names], mode, focusedPart }
 * Returns a short spoken answer, or a graceful fallback if AI is unavailable.
 */
export async function answerQuestion(context, question) {
  if (!aiAvailable()) {
    return `I can't reach the AI tutor right now, but you're looking at the ${context.focusedPart || context.modelLabel}.`;
  }
  const parts = [...new Set(context.parts || [])].join(', ');
  const system = [
    'You are an augmented-reality repair and assembly tutor speaking out loud to a user.',
    `The user is looking at a ${context.modelLabel} through their phone camera.`,
    parts && `Its parts are: ${parts}.`,
    context.focusedPart && `They currently have the "${context.focusedPart}" highlighted.`,
    'Answer in at most two short sentences, plain spoken language, practical and friendly.',
    'If they ask how to fix or replace a part, give the key step. Do not use markdown or lists.',
  ].filter(Boolean).join(' ');

  try {
    return await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      { temperature: 0.4, maxTokens: 160 }
    );
  } catch (e) {
    console.warn('answerQuestion failed:', e.message);
    return `Sorry, I couldn't reach the tutor. That part is the ${context.focusedPart || 'one you tapped'}.`;
  }
}
