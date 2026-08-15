/**
 * Language: the single source of truth for what language the app is *in*.
 *
 * The rule the whole app obeys: **one language at a time, in and out.** When
 * German is selected every surface is German — the chrome, the cards, the
 * authored content, the tutor's spoken answers, the part names — and the mic is
 * told to transcribe German. When English is selected, everything is English.
 * A user who speaks the *other* language does not flip the app: the STT is
 * pinned to the selected language and every LLM prompt is told to reply in it
 * regardless of what language the question arrived in. That is deliberate — a
 * tutor that silently changes language mid-session is worse than one that
 * answers in the language you chose.
 *
 * Three things live here:
 *  - `getLang()` / `setLang()` + `onLangChange()` — the state and its listeners.
 *  - `t(key, vars)` — the UI dictionary (chrome, cards, captions, spoken lines).
 *  - `tr(value)` — resolves an authored `{ en, de }` content value (modes.js
 *    keeps its content bilingual in place rather than duplicating the whole
 *    structure, so keyword matching, indices and shape stay in one file).
 *
 * Locale codes for the speech stack are derived here too (`sttLang`,
 * `ttsLang`, `speechLang`) so no module has to know how the current language
 * maps onto ISO-639-1 vs BCP-47.
 */

export const LANGS = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'de', label: 'Deutsch', short: 'DE' },
];

const STORAGE_KEY = 'lang';
const listeners = new Set();

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.some((l) => l.id === saved)) return saved;
  } catch { /* private mode */ }
  // No stored choice: follow the browser. This app is built for a German
  // hackathon, so a German-locale visitor should land in German.
  const nav = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

let lang = detect();

export function getLang() { return lang; }

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLang(next) {
  if (!LANGS.some((l) => l.id === next) || next === lang) return false;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
  document.documentElement.lang = next;
  for (const fn of listeners) fn(next);
  return true;
}

// ---- Locale codes for the speech stack -------------------------------------

/** ISO-639-1, what ElevenLabs Scribe and Whisper want for a language hint. */
export function sttLang() { return lang; }
/** ElevenLabs TTS `language_code` — same ISO-639-1 code. */
export function ttsLang() { return lang; }
/** BCP-47, what the Web Speech API and speechSynthesis want. */
export function speechLang() { return lang === 'de' ? 'de-DE' : 'en-US'; }
/** Locale for number formatting (triangle counts in the Explore card). */
export function locale() { return lang === 'de' ? 'de-DE' : 'en-US'; }

/**
 * Resolve an authored content value. Accepts a plain string (same in both
 * languages — keyword lists, part numbers) or a `{ en, de }` object. Falls back
 * to English so a half-translated entry degrades to readable rather than blank.
 */
export function tr(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value[lang] ?? value.en ?? '';
}

// ---- UI dictionary ---------------------------------------------------------
// Every string the app puts on screen or speaks that is NOT authored model
// content. `{name}` placeholders are filled from t()'s second argument.
// Copy follows the Otto UI system: Otto speaks in the first person, short and
// warm; technical voice (kickers, hints, pills) is JetBrains Mono and lowercase
// or letterspaced-uppercase. Never emoji — icons are stroke SVGs in the markup.

const STRINGS = {
  // -- Chrome ------------------------------------------------------------------
  'app.title':          { en: 'Otto — AR Repair Assistant',  de: 'Otto — AR-Reparatur-Assistent' },
  'btn.backTitle':      { en: 'Back',                        de: 'Zurück' },
  'btn.controlsTitle':  { en: 'Controls',                    de: 'Steuerung' },
  'btn.closeTitle':     { en: 'Close',                       de: 'Schließen' },
  'btn.sendTitle':      { en: 'Send',                        de: 'Senden' },
  'btn.arTitle':        { en: 'View in AR — WebXR runs on Android Chrome. The 3D view works everywhere.',
                          de: 'In AR ansehen — WebXR läuft in Chrome unter Android. Die 3D-Ansicht funktioniert überall.' },
  'btn.exitARTitle':    { en: 'Exit AR',                     de: 'AR beenden' },
  'btn.micTitle':       { en: 'Ask Otto — voice needs a microphone plus an ElevenLabs or DeutschlandGPT key (or Chrome).',
                          de: 'Otto fragen — für die Sprachfunktion braucht es ein Mikrofon und einen ElevenLabs- oder DeutschlandGPT-Schlüssel (oder Chrome).' },
  'btn.ask':            { en: 'ASK',                         de: 'FRAGEN' },
  'btn.askOtto':        { en: 'Ask Otto',                    de: 'Otto fragen' },
  'btn.back':           { en: 'Back',                        de: 'Zurück' },
  'btn.next':           { en: 'Next',                        de: 'Weiter' },
  'btn.done':           { en: 'Done',                        de: 'Fertig' },

  // -- Controls sheet ----------------------------------------------------------
  'controls.kicker':    { en: 'CONTROLS',                    de: 'STEUERUNG' },
  'controls.model':     { en: 'MODEL',                       de: 'MODELL' },
  'controls.language':  { en: 'LANGUAGE',                    de: 'SPRACHE' },
  'controls.theme':     { en: 'THEME',                       de: 'DESIGN' },
  'controls.reset':     { en: 'Reset view',                  de: 'Ansicht zurücksetzen' },
  'theme.dark':         { en: 'Dark',                        de: 'Dunkel' },
  'theme.light':        { en: 'Light',                       de: 'Hell' },

  // -- Home screen ---------------------------------------------------------------
  'home.title':         { en: 'What are we working on?',     de: 'Woran arbeiten wir?' },
  'home.sub':           { en: 'Point me at something broken, or pick from what I know.',
                          de: 'Zeig mir etwas Kaputtes — oder wähl aus, was ich kenne.' },
  'home.scan':          { en: 'Scan an object',              de: 'Objekt scannen' },
  'home.scanSub':       { en: "Point your camera at it and I'll recognise it.",
                          de: 'Richte die Kamera darauf — ich erkenne es.' },
  'home.select':        { en: 'Select an object',            de: 'Objekt auswählen' },
  'home.selectSub':     { en: 'Choose from the objects I know.',
                          de: 'Wähle aus den Objekten, die ich kenne.' },
  'home.kicker':        { en: 'OBJECTS I KNOW',              de: 'OBJEKTE, DIE ICH KENNE' },
  'home.dontSee':       { en: "don't see yours?",            de: 'deins ist nicht dabei?' },
  'home.scanInstead':   { en: 'Scan it instead',             de: 'Lieber scannen' },

  // -- Object scan (camera → vision) ----------------------------------------
  'scan.pickList':      { en: 'Pick from the list',          de: 'Aus der Liste wählen' },
  'scan.shutterTitle':  { en: 'Take the photo',              de: 'Foto aufnehmen' },
  'scan.retakeTitle':   { en: 'Retake',                      de: 'Neu aufnehmen' },
  'scan.starting':      { en: 'starting the camera…',        de: 'kamera startet…' },
  'scan.hint':          { en: 'point at the whole object',   de: 'das ganze Objekt anvisieren' },
  'scan.identifying':   { en: 'identifying…',                de: 'wird erkannt…' },
  'scan.found':         { en: 'looks like a {object} — opening it',
                          de: 'sieht aus wie: {object} — wird geöffnet' },
  'scan.none':          { en: "couldn't tell — retake, or pick from the list",
                          de: 'nicht erkannt — neu aufnehmen oder aus der Liste wählen' },
  'scan.noCamera':      { en: 'no camera here — pick from the list instead',
                          de: 'keine Kamera verfügbar — wähle aus der Liste' },
  'scan.blocked':       { en: 'camera blocked — allow access, then try again',
                          de: 'Kamera blockiert — Zugriff erlauben und nochmal versuchen' },
  'scan.noFrame':       { en: 'no picture yet — give it a moment',
                          de: 'noch kein Bild — kurz warten' },

  // -- Arrival (recognized on sight) -----------------------------------------
  'arrival.found':      { en: "Found it — {object}. Nothing in here we can't handle. What's it doing?",
                          de: 'Gefunden — {object}. Hier ist nichts, was wir nicht hinkriegen. Was ist damit los?' },
  'arrival.lookInside': { en: 'Look inside',                 de: 'Reinschauen' },

  // -- Status line -----------------------------------------------------------
  'status.init':        { en: 'initialising…',               de: 'wird initialisiert…' },
  'status.loading':     { en: 'loading model…',              de: 'Modell wird geladen…' },
  'status.loadingPct':  { en: 'loading model… {pct}%',       de: 'Modell wird geladen… {pct} %' },
  'status.splitting':   { en: 'splitting into parts…',       de: 'wird in Einzelteile zerlegt…' },
  'status.ready':       { en: 'ready — drag to orbit',       de: 'bereit — ziehen zum Drehen' },
  'status.failed':      { en: 'failed to load the model',    de: 'Modell konnte nicht geladen werden' },
  'pill.listening':     { en: 'listening',                   de: 'ich höre zu' },

  // -- Modes -----------------------------------------------------------------
  'mode.explore':       { en: 'Explore',                     de: 'Erkunden' },
  'mode.fix':           { en: 'Fix',                         de: 'Reparieren' },
  'mode.assemble':      { en: 'Assemble',                    de: 'Zusammenbauen' },
  'mode.quiz':          { en: 'Quiz',                        de: 'Quiz' },

  // Card kickers: the mode names for the card header. Kept separate from
  // `mode.*` because main.js keys its mode logic on the id, never on this label.
  'kicker.explore':     { en: 'Explore',                     de: 'Erkunden' },
  'kicker.fix':         { en: 'Fix',                         de: 'Reparieren' },
  'kicker.assemble':    { en: 'Assemble',                    de: 'Zusammenbauen' },
  'kicker.quiz':        { en: 'Quiz',                        de: 'Quiz' },

  // -- Explore ---------------------------------------------------------------
  'explore.intro':      { en: "Tap any part and I'll tell you what it does — or tap ASK and just ask me.",
                          de: 'Tipp ein Teil an und ich sage dir, was es macht — oder tipp auf FRAGEN und frag mich einfach.' },
  'explore.introNoAr':  { en: "No AR on this device, and that's fine. Same object, same fix, right here. Spin it with a finger; I'll point at what matters.",
                          de: 'Kein AR auf diesem Gerät — macht nichts. Gleiches Objekt, gleiche Reparatur, genau hier. Dreh es mit dem Finger; ich zeige dir, worauf es ankommt.' },
  'explore.partCount':  { en: '{count} parts',               de: '{count} Teile' },
  'explore.partMeta':   { en: '{tris} triangles',            de: '{tris} Dreiecke' },
  'explore.groupMeta':  { en: '{count} pieces',              de: '{count} Einzelstücke' },
  'explore.askAbout':   { en: 'Ask me anything about it.',   de: 'Frag mich alles darüber.' },
  'spread.label':       { en: 'EXPLODE',                     de: 'ZERLEGEN' },
  'spread.title':       { en: 'Spread the parts apart',      de: 'Teile auseinanderziehen' },

  // -- Fix -------------------------------------------------------------------
  'fix.ask':            { en: 'What should we fix?',         de: 'Was sollen wir reparieren?' },
  'fix.askHint':        { en: 'Tap ASK and describe the problem — or pick one below.',
                          de: 'Tipp auf FRAGEN und beschreibe das Problem — oder wähle unten eines aus.' },
  'fix.askSpoken':      { en: 'What should we fix? Describe the problem, or pick a suggestion.',
                          de: 'Was sollen wir reparieren? Beschreibe das Problem oder wähle einen Vorschlag.' },
  'fix.planning':       { en: '…planning the repair',        de: '…die Reparatur wird geplant' },
  'fix.planningCaption':{ en: '“{request}” · …planning',     de: '„{request}“ · …wird geplant' },
  'fix.done':           { en: 'Done — that should sort it. Anything else to fix?',
                          de: 'Fertig — das sollte es beheben. Sonst noch etwas zu reparieren?' },
  'fix.sayAgain':       { en: 'Say it again',                de: 'Nochmal vorlesen' },
  'fix.somethingElse':  { en: 'Fix something else',          de: 'Etwas anderes reparieren' },
  'fix.titleFor':       { en: 'Fix: {request}',              de: 'Reparatur: {request}' },
  'fix.suggestFallback':{ en: 'Take it apart step by step',  de: 'Schritt für Schritt zerlegen' },

  // Diagnose — the culprit blooms amber, then we ask to start.
  'diag.badge':         { en: 'culprit found',               de: 'übeltäter gefunden' },
  'diag.title':         { en: 'Found it.',                   de: 'Gefunden.' },
  'diag.fix':           { en: 'Fix it with me',              de: 'Repariere es mit mir' },
  'diag.notNow':        { en: 'not now',                     de: 'jetzt nicht' },

  // Fix walkthrough header + step chrome.
  'fixhead.step':       { en: 'FIX · STEP {index} OF {total}', de: 'REPARATUR · SCHRITT {index} VON {total}' },
  'fixhead.complete':   { en: 'FIX · COMPLETE',              de: 'REPARATUR · FERTIG' },
  'fix.stepKicker':     { en: 'STEP {index} · {title}',      de: 'SCHRITT {index} · {title}' },
  'fix.pause':          { en: 'pause',                       de: 'pause' },
  'fix.resume':         { en: 'resume',                      de: 'weiter' },
  'fix.sayNext':        { en: 'say “next” when it’s done',   de: 'sag „weiter“, wenn’s erledigt ist' },

  // Done — amber is gone, everything blue.
  'done.title':         { en: 'Holding steady.',             de: 'Hält wieder stand.' },
  'done.body':          { en: 'That’s the fix done — you just kept a whole {object} out of the landfill.',
                          de: 'Reparatur erledigt — damit hast du {object} vor der Müllkippe bewahrt.' },
  'done.stepsChip':     { en: '{count} steps',               de: '{count} Schritte' },
  'done.handsFree':     { en: 'hands-free',                  de: 'freihändig' },
  'done.btn':           { en: 'Done',                        de: 'Fertig' },
  'done.recap':         { en: 'what we did',                 de: 'was wir gemacht haben' },
  'done.recapKicker':   { en: 'WHAT WE DID',                 de: 'WAS WIR GEMACHT HABEN' },

  // -- Guided steps (Fix + Assemble share these) -----------------------------
  'step.counter':       { en: 'Step {index} of {total}',     de: 'Schritt {index} von {total}' },
  'step.none':          { en: 'No procedure for this model yet.',
                          de: 'Für dieses Modell gibt es noch keine Anleitung.' },

  // -- Assemble --------------------------------------------------------------
  'assemble.dragHint':  { en: 'Drag the right piece into the glowing outline.',
                          de: 'Zieh das richtige Teil in den leuchtenden Umriss.' },
  // Shown instead of dragHint when a mic is available. Naming the piece counts
  // as an answer, so the hint has to say so — an unadvertised voice route is one
  // nobody uses, and in AR it is the easier of the two ways to answer.
  'assemble.dragOrSayHint': { en: 'Drag the right piece into the glowing outline — or just say what it is.',
                          de: 'Zieh das richtige Teil in den leuchtenden Umriss — oder sag einfach, was es ist.' },
  'assemble.alreadyOn': { en: 'The {part} is already on.',   de: '{part} ist schon dran.' },
  'assemble.unclear':   { en: "I didn't catch which piece you meant. Say what it looks like, or drag it in.",
                          de: 'Ich habe nicht verstanden, welches Teil du meinst. Beschreib es, oder zieh es rein.' },
  'assemble.hint':      { en: 'Hint',                        de: 'Tipp' },
  'assemble.placeForMe':{ en: 'Place it for me',             de: 'Für mich platzieren' },
  'assemble.hintCaption': { en: 'That one — drag it into the outline.',
                          de: 'Dieses hier — zieh es in den Umriss.' },
  'assemble.wrongTry':  { en: '{count} wrong try',           de: '{count} Fehlversuch' },
  'assemble.wrongTries':{ en: '{count} wrong tries',         de: '{count} Fehlversuche' },
  // German avoids the article here on purpose: the {part} slot is filled with a
  // bare part name whose gender we don't track, so "Als Nächstes: X." reads
  // correctly for der/die/das alike.
  'assemble.nextPart':  { en: 'The {part} goes on next.',    de: 'Als Nächstes: {part}.' },
  'assemble.complete':  { en: '{model} assembled',           de: '{model} zusammengebaut' },
  'assemble.completeMeta': { en: 'Complete',                 de: 'Fertig' },
  'assemble.clean':     { en: 'Built it start to finish without a single wrong piece. That is the real assembly order.',
                          de: 'Von Anfang bis Ende zusammengebaut, ohne ein einziges falsches Teil. Das ist die echte Montagereihenfolge.' },
  'assemble.scored':    { en: 'Built. {mistakes} — run it again and see if you can go clean.',
                          de: 'Zusammengebaut. {mistakes} — bau ihn nochmal und versuch es ohne Fehler.' },
  'assemble.assists':   { en: ', {count} placed for you',    de: ', {count} für dich platziert' },
  'assemble.again':     { en: 'Build it again',              de: 'Nochmal bauen' },
  'assemble.explore':   { en: 'Explore it',                  de: 'Erkunden' },
  'assemble.none':      { en: 'No procedure for this model yet.',
                          de: 'Für dieses Modell gibt es noch keine Anleitung.' },
  'assemble.fallbackPrompt': { en: 'Which part goes on next?', de: 'Welches Teil kommt als Nächstes?' },
  'assemble.fallbackFirstPrompt': { en: 'Which is the biggest piece? It goes down first.',
                          de: 'Welches ist das größte Teil? Es kommt zuerst.' },
  'assemble.fallbackFirstText': { en: 'Start with the largest part as the base.',
                          de: 'Fang mit dem größten Teil als Basis an.' },
  'assemble.fallbackText': { en: 'Attach the next part: {part}.', de: 'Bring das nächste Teil an: {part}.' },
  'assemble.genericTitle': { en: 'Assemble from parts',      de: 'Aus Einzelteilen zusammenbauen' },
  'assemble.title':     { en: 'Assemble the chair',          de: 'Den Stuhl zusammenbauen' },

  // -- Quiz ------------------------------------------------------------------
  'quiz.reveal':        { en: 'Reveal answer',               de: 'Antwort zeigen' },
  'quiz.next':          { en: 'Next question',               de: 'Nächste Frage' },
  'quiz.counter':       { en: 'Question {index} of {total}', de: 'Frage {index} von {total}' },
  'quiz.answer':        { en: 'Answer: {answer}',            de: 'Antwort: {answer}' },
  'quiz.none':          { en: 'No quiz authored for this model yet.',
                          de: 'Für dieses Modell gibt es noch kein Quiz.' },

  // -- Voice -----------------------------------------------------------------
  'voice.askHint':      { en: 'Ask me anything about it — I answer out loud. Start talking to interrupt an answer.',
                          de: 'Frag mich alles darüber — ich antworte laut. Sprich einfach los, um eine Antwort zu unterbrechen.' },
  'voice.muted':        { en: 'Okay — ask away.',            de: 'Alles klar — frag einfach.' },
  'voice.thinking':     { en: '“{text}” · …thinking',        de: '„{text}“ · …ich überlege' },
  'voice.transcribing': { en: '…',                           de: '…' },
  'voice.micBlocked':   { en: 'Microphone blocked — allow mic access for this site and tap ASK again.',
                          de: 'Mikrofon blockiert — erlaube den Mikrofonzugriff für diese Seite und tippe erneut auf FRAGEN.' },
  'voice.sttFailed':    { en: "Couldn't reach the transcription service — check the connection and try again.",
                          de: 'Der Transkriptionsdienst ist nicht erreichbar — prüfe die Verbindung und versuch es nochmal.' },
  'otto.hint':          { en: 'say “pause” anytime',         de: 'sag jederzeit „Pause“' },
  'listen.kicker':      { en: 'LISTENING',                   de: 'ICH HÖRE ZU' },
  'listen.hint':        { en: 'take your time · tap anywhere to stop',
                          de: 'lass dir Zeit · tipp irgendwohin zum Stoppen' },
  'grace.type':         { en: 'Type to Otto…',               de: 'Schreib Otto…' },
  'chip.next':          { en: '“next”',                      de: '„weiter“' },
  'chip.again':         { en: '“again”',                     de: '„nochmal“' },
  'chip.move':          { en: '“move it”',                   de: '„verschieben“' },

  // -- AR --------------------------------------------------------------------
  'ar.steps':           { en: 'Steps',                       de: 'Schritte' },
  'ar.pause':           { en: 'Pause',                       de: 'Pause' },
  'ar.pillPlace':       { en: 'point at the floor · tap to place',
                          de: 'auf den Boden zielen · tippen zum Platzieren' },
  'ar.pillAnchored':    { en: "anchored — walk around, I'll keep up",
                          de: 'verankert — lauf ruhig herum, ich bleib dran' },
  'ar.needsAndroid':    { en: 'AR needs an Android phone — the 3D view here does the same job.',
                          de: 'AR braucht ein Android-Telefon — die 3D-Ansicht hier kann dasselbe.' },
  'ar.pointAtFloor':    { en: 'Point at the floor, then tap to place it.',
                          de: 'Richte die Kamera auf den Boden und tippe, um es zu platzieren.' },
  'ar.failed':          { en: 'Could not start AR — tap the AR button to launch it.',
                          de: 'AR konnte nicht gestartet werden — tippe auf die AR-Schaltfläche.' },
  'ar.placedPuzzle':    { en: 'Placed at full size. Drag each part into the glowing outline. Say “move it” to re-place the build.',
                          de: 'In Originalgröße platziert. Zieh jedes Teil in den leuchtenden Umriss. Sag „verschieben“, um neu zu platzieren.' },
  'ar.placedPuzzleSpoken': { en: 'Placed, at full size. Drag each part into the glowing outline.',
                          de: 'Platziert, in Originalgröße. Zieh jedes Teil in den leuchtenden Umriss.' },
  'ar.placed':          { en: 'Placed! Long-press to grab it, then drag to move · pinch to zoom · twist to rotate.',
                          de: 'Platziert! Lange drücken zum Greifen, dann ziehen zum Bewegen · zwei Finger zum Skalieren · drehen zum Rotieren.' },
  'ar.placedSpoken':    { en: 'Placed. Press and hold the object to grab it, then drag to move it, or pinch to resize.',
                          de: 'Platziert. Halte das Objekt gedrückt, um es zu greifen, dann zieh es zum Bewegen oder skaliere es mit zwei Fingern.' },
  'ar.grabbed':         { en: 'Grabbed — drag to move · pinch to zoom · twist to rotate · tap to release.',
                          de: 'Gegriffen — ziehen zum Bewegen · zwei Finger zum Skalieren · drehen zum Rotieren · tippen zum Loslassen.' },
  'ar.released':        { en: 'Released. Long-press the object again to move or resize it.',
                          de: 'Losgelassen. Drücke das Objekt erneut lange, um es zu bewegen oder zu skalieren.' },
  'ar.moveFirst':       { en: 'Start AR first, then say “move it”.',
                          de: 'Starte zuerst AR und sag dann „verschieben“.' },
  'ar.tapToMove':       { en: 'Tap the floor where you want it.',
                          de: 'Tippe auf die Stelle am Boden, wo es stehen soll.' },

  // -- Tutor fallbacks (spoken when the AI is unreachable) -------------------
  'tutor.noAi':         { en: "I can't reach the AI tutor right now, but you're looking at the {subject}.",
                          de: 'Ich erreiche den KI-Tutor gerade nicht, aber du siehst gerade: {subject}.' },
  'tutor.failed':       { en: "Sorry, I couldn't reach the tutor. That part is the {part}.",
                          de: 'Entschuldige, ich konnte den Tutor nicht erreichen. Dieses Teil: {part}.' },
  'tutor.thatPart':     { en: 'one you tapped',              de: 'das angetippte Teil' },
  'tutor.nextFallback': { en: 'The {part} goes on next. {step}', de: 'Als Nächstes: {part}. {step}' },

  // -- Grounding digest (fed to the LLM, never shown) ------------------------
  // These sit in the dictionary rather than in modes.js so the digest reads as
  // one language throughout — an English header on German facts invites the
  // model to answer in English.
  'digest.procedure':   { en: 'Repair procedure',            de: 'Reparaturablauf' },
  'digest.faults':      { en: 'Known faults (symptom — cause and fix):',
                          de: 'Bekannte Fehler (Symptom — Ursache und Behebung):' },
  'teardown.title':     { en: 'Teardown',                    de: 'Demontage' },
  'teardown.step':      { en: 'Remove {part}.',              de: 'Bau {part} aus.' },
};

/**
 * Look up a UI string in the current language and fill `{placeholders}`.
 * An unknown key returns the key itself — loud in the UI, so a missing string
 * shows up in testing instead of rendering as an empty box.
 */
export function t(key, vars = null) {
  const entry = STRINGS[key];
  let s = entry ? (entry[lang] ?? entry.en) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

// ---- Static DOM translation ------------------------------------------------

/**
 * Apply the dictionary to the static markup: every element carrying
 * `data-i18n` (text content), `data-i18n-title` (tooltip) or `data-i18n-html`
 * gets its string re-read. Called on boot and on every language switch, so the
 * chrome flips without a reload.
 */
export function applyStaticTranslations(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  document.title = t('app.title');
}
