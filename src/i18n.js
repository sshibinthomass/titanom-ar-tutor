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

const STRINGS = {
  // -- Chrome / control panel ------------------------------------------------
  'app.title':          { en: 'AR Repair Tutor',            de: 'AR-Reparatur-Tutor' },
  'panel.heading':      { en: 'Exploded View',              de: 'Explosionsansicht' },
  'panel.model':        { en: 'Model',                      de: 'Modell' },
  'panel.explode':      { en: 'Explode amount',             de: 'Explosionsgrad' },
  'panel.autorotate':   { en: 'Auto-rotate',                de: 'Automatisch drehen' },
  'panel.reset':        { en: 'Reset view',                 de: 'Ansicht zurücksetzen' },
  'panel.advanced':     { en: 'Advanced',                   de: 'Erweitert' },
  'panel.splitMode':    { en: 'Split mode',                 de: 'Zerlegungsmodus' },
  'panel.splitGroup':   { en: 'By material group',          de: 'Nach Materialgruppe' },
  'panel.splitComp':    { en: 'By connected piece',         de: 'Nach zusammenhängendem Teil' },
  'panel.tint':         { en: 'Tint parts by component',    de: 'Teile nach Komponente einfärben' },
  'panel.wireframe':    { en: 'Wireframe',                  de: 'Drahtgitter' },
  'panel.partCount':    { en: 'Component parts',            de: 'Einzelteile' },
  'panel.language':     { en: 'Language',                   de: 'Sprache' },
  'btn.controls':       { en: '⚙︎ Controls',                de: '⚙︎ Steuerung' },
  'btn.dark':           { en: '🌙 Dark',                    de: '🌙 Dunkel' },
  'btn.light':          { en: '☀️ Light',                    de: '☀️ Hell' },
  'btn.themeTitle':     { en: 'Toggle light / dark theme',  de: 'Helles / dunkles Design umschalten' },
  'btn.langTitle':      { en: 'Switch language',            de: 'Sprache wechseln' },
  'btn.ar':             { en: '📱 View in AR',              de: '📱 In AR ansehen' },
  'btn.arUnsupported':  { en: '📱 AR needs Android',        de: '📱 AR braucht Android' },
  'btn.arTitle':        { en: 'WebXR AR runs on Android Chrome. The 3D view works everywhere.',
                          de: 'WebXR-AR läuft nur in Chrome unter Android. Die 3D-Ansicht funktioniert überall.' },
  'btn.exitAR':         { en: '✕ Exit AR',                  de: '✕ AR beenden' },
  'btn.mic':            { en: '🎤 Ask',                     de: '🎤 Fragen' },
  'btn.micListening':   { en: '🎤 Listening…',              de: '🎤 Ich höre zu…' },
  'btn.micTitle':       { en: 'Voice needs a microphone plus an ElevenLabs or DeutschlandGPT key (or Chrome).',
                          de: 'Für die Sprachfunktion braucht es ein Mikrofon und einen ElevenLabs- oder DeutschlandGPT-Schlüssel (oder Chrome).' },
  'btn.back':           { en: '◀ Back',                     de: '◀ Zurück' },
  'btn.next':           { en: 'Next ▶',                     de: 'Weiter ▶' },
  'btn.done':           { en: 'Done ✔',                     de: 'Fertig ✔' },
  'card.explode':       { en: 'Explode',                    de: 'Zerlegen' },
  'btn.home':           { en: '⌂ Home',                     de: '⌂ Start' },
  'btn.homeTitle':      { en: 'Back to the object chooser',  de: 'Zurück zur Objektauswahl' },

  // -- Home screen -----------------------------------------------------------
  'home.sub':           { en: 'What are we working on?',     de: 'Woran arbeiten wir?' },
  'home.scan':          { en: 'Scan an object',              de: 'Objekt scannen' },
  'home.scanSub':       { en: "Point your camera at it and I'll recognise it.",
                          de: 'Richte die Kamera darauf — ich erkenne es.' },
  'home.select':        { en: 'Select an object',            de: 'Objekt auswählen' },
  'home.selectSub':     { en: 'Choose from the objects I know.',
                          de: 'Wähle aus den Objekten, die ich kenne.' },

  // -- Object scan (camera → vision) ----------------------------------------
  'scan.capture':       { en: '📸 Capture',                  de: '📸 Aufnehmen' },
  'scan.retake':        { en: '↺ Retake',                    de: '↺ Neu aufnehmen' },
  'scan.chooseInstead': { en: '📋 Pick from the list',       de: '📋 Aus der Liste wählen' },
  'scan.starting':      { en: 'Starting the camera…',        de: 'Kamera wird gestartet…' },
  'scan.hint':          { en: 'Point at the whole object, then capture.',
                          de: 'Richte die Kamera auf das ganze Objekt und nimm auf.' },
  'scan.identifying':   { en: '…identifying',                de: '…wird erkannt' },
  'scan.found':         { en: 'Looks like a {object} — opening it.',
                          de: 'Sieht aus wie: {object} — wird geöffnet.' },
  'scan.none':          { en: "I couldn't tell what that is. Retake the photo, or pick from the list.",
                          de: 'Ich konnte es nicht erkennen. Nimm neu auf oder wähle aus der Liste.' },
  'scan.noCamera':      { en: 'No camera available here. Pick from the list instead.',
                          de: 'Hier ist keine Kamera verfügbar. Wähle stattdessen aus der Liste.' },
  'scan.blocked':       { en: 'Camera blocked — allow camera access for this site, then try again.',
                          de: 'Kamera blockiert — erlaube den Kamerazugriff für diese Seite und versuch es nochmal.' },
  'scan.noFrame':       { en: 'The camera has no picture yet — give it a moment.',
                          de: 'Die Kamera liefert noch kein Bild — kurz warten.' },

  // -- Status line -----------------------------------------------------------
  'status.init':        { en: 'Initialising…',              de: 'Wird initialisiert…' },
  'status.loading':     { en: 'Loading model…',             de: 'Modell wird geladen…' },
  'status.loadingPct':  { en: 'Loading model… {pct}%',      de: 'Modell wird geladen… {pct} %' },
  'status.splitting':   { en: 'Splitting into component parts…', de: 'Wird in Einzelteile zerlegt…' },
  'status.ready':       { en: 'Ready — drag to orbit, use the slider to explode.',
                          de: 'Bereit — ziehen zum Drehen, mit dem Regler zerlegen.' },
  'status.failed':      { en: 'Failed to load model. Check the console.',
                          de: 'Modell konnte nicht geladen werden. Konsole prüfen.' },

  // -- Modes -----------------------------------------------------------------
  'mode.explore':       { en: '🔍 Explore',                 de: '🔍 Erkunden' },
  'mode.fix':           { en: '🔧 Fix',                     de: '🔧 Reparieren' },
  'mode.assemble':      { en: '🧩 Assemble',                de: '🧩 Zusammenbauen' },

  // Card kickers: the same three names without the emoji. Kept separate from
  // `mode.*` because the card header is typographic (small caps, no icon) and
  // because main.js keys its mode logic on the id, never on this label.
  'kicker.explore':     { en: 'Explore',                    de: 'Erkunden' },
  'kicker.fix':         { en: 'Fix',                        de: 'Reparieren' },
  'kicker.assemble':    { en: 'Assemble',                   de: 'Zusammenbauen' },

  // -- Explore ---------------------------------------------------------------
  'explore.intro':      { en: 'Tap any part to isolate it, then tap 🎤 and ask about it. Drag the slider to spread the parts apart.',
                          de: 'Tippe ein Teil an, um es freizustellen, dann tippe auf 🎤 und frag danach. Mit dem Regler ziehst du die Teile auseinander.' },
  'explore.partCount':  { en: '{count} parts',              de: '{count} Teile' },
  'explore.partMeta':   { en: '{tris} triangles · ask 🎤 about this part',
                          de: '{tris} Dreiecke · frag 🎤 nach diesem Teil' },
  'explore.groupMeta':  { en: '{count} pieces · ask 🎤 about this part',
                          de: '{count} Einzelstücke · frag 🎤 nach diesem Teil' },

  // -- Fix -------------------------------------------------------------------
  'fix.ask':            { en: 'What should we fix?',        de: 'Was sollen wir reparieren?' },
  'fix.askHint':        { en: 'Tap 🎤 and describe the problem — or pick one below.',
                          de: 'Tippe auf 🎤 und beschreibe das Problem — oder wähle unten eines aus.' },
  'fix.askSpoken':      { en: 'What should we fix? Describe the problem, or pick a suggestion.',
                          de: 'Was sollen wir reparieren? Beschreibe das Problem oder wähle einen Vorschlag.' },
  'fix.planning':       { en: '…planning the repair',       de: '…die Reparatur wird geplant' },
  'fix.planningCaption':{ en: '“{request}” · …planning',    de: '„{request}“ · …wird geplant' },
  'fix.done':           { en: 'Done — that should sort it. Anything else to fix?',
                          de: 'Fertig — das sollte es beheben. Sonst noch etwas zu reparieren?' },
  'fix.sayAgain':       { en: '🔊 Say it again',            de: '🔊 Nochmal vorlesen' },
  'fix.somethingElse':  { en: '🎤 Fix something else',      de: '🎤 Etwas anderes reparieren' },
  'fix.titleFor':       { en: 'Fix: {request}',             de: 'Reparatur: {request}' },
  'fix.suggestFallback':{ en: 'Take it apart step by step', de: 'Schritt für Schritt zerlegen' },

  // -- Guided steps (Fix + Assemble share these) -----------------------------
  'step.counter':       { en: 'Step {index} of {total}',    de: 'Schritt {index} von {total}' },
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
  'assemble.hint':      { en: '💡 Hint',                    de: '💡 Tipp' },
  'assemble.placeForMe':{ en: '✋ Place it for me',          de: '✋ Für mich platzieren' },
  'assemble.hintCaption': { en: 'That one — drag it into the outline.',
                          de: 'Dieses hier — zieh es in den Umriss.' },
  'assemble.wrongTry':  { en: '{count} wrong try',          de: '{count} Fehlversuch' },
  'assemble.wrongTries':{ en: '{count} wrong tries',        de: '{count} Fehlversuche' },
  // German avoids the article here on purpose: the {part} slot is filled with a
  // bare part name whose gender we don't track, so "Als Nächstes: X." reads
  // correctly for der/die/das alike.
  'assemble.nextPart':  { en: 'The {part} goes on next.',   de: 'Als Nächstes: {part}.' },
  'assemble.complete':  { en: '🎉 {model} assembled',       de: '🎉 {model} zusammengebaut' },
  'assemble.completeMeta': { en: 'Complete',                de: 'Fertig' },
  'assemble.clean':     { en: 'Built it start to finish without a single wrong piece. That is the real assembly order.',
                          de: 'Von Anfang bis Ende zusammengebaut, ohne ein einziges falsches Teil. Das ist die echte Montagereihenfolge.' },
  'assemble.scored':    { en: 'Built. {mistakes} — run it again and see if you can go clean.',
                          de: 'Zusammengebaut. {mistakes} — bau ihn nochmal und versuch es ohne Fehler.' },
  'assemble.assists':   { en: ', {count} placed for you',   de: ', {count} für dich platziert' },
  'assemble.again':     { en: '🔁 Build it again',          de: '🔁 Nochmal bauen' },
  'assemble.explore':   { en: '🔍 Explore it',              de: '🔍 Erkunden' },
  'assemble.none':      { en: 'No procedure for this model yet.',
                          de: 'Für dieses Modell gibt es noch keine Anleitung.' },
  'assemble.fallbackPrompt': { en: 'Which part goes on next?', de: 'Welches Teil kommt als Nächstes?' },
  'assemble.fallbackFirstPrompt': { en: 'Which is the biggest piece? It goes down first.',
                          de: 'Welches ist das größte Teil? Es kommt zuerst.' },
  'assemble.fallbackFirstText': { en: 'Start with the largest part as the base.',
                          de: 'Fang mit dem größten Teil als Basis an.' },
  'assemble.fallbackText': { en: 'Attach the next part: {part}.', de: 'Bring das nächste Teil an: {part}.' },
  'assemble.genericTitle': { en: 'Assemble from parts',     de: 'Aus Einzelteilen zusammenbauen' },
  'assemble.title':     { en: 'Assemble the chair',         de: 'Den Stuhl zusammenbauen' },

  // -- Voice -----------------------------------------------------------------
  'voice.askHint':      { en: 'Ask me anything about it — I answer out loud. Start talking to interrupt an answer.',
                          de: 'Frag mich alles darüber — ich antworte laut. Sprich einfach los, um eine Antwort zu unterbrechen.' },
  'voice.muted':        { en: 'Okay — ask away.',           de: 'Alles klar — frag einfach.' },
  'voice.thinking':     { en: '“{text}” · …thinking',       de: '„{text}“ · …ich überlege' },
  'voice.transcribing': { en: '🎧 …',                       de: '🎧 …' },
  'voice.micBlocked':   { en: 'Microphone blocked — allow mic access for this site and tap 🎤 again.',
                          de: 'Mikrofon blockiert — erlaube den Mikrofonzugriff für diese Seite und tippe erneut auf 🎤.' },
  'voice.sttFailed':    { en: "Couldn't reach the transcription service — check the connection and try again.",
                          de: 'Der Transkriptionsdienst ist nicht erreichbar — prüfe die Verbindung und versuch es nochmal.' },

  // -- AR --------------------------------------------------------------------
  'ar.needsAndroid':    { en: 'AR needs an Android phone. Tap 📱 for details.',
                          de: 'AR braucht ein Android-Telefon. Tippe auf 📱 für Details.' },
  'ar.pointAtFloor':    { en: 'Point at the floor, then tap to place the chair.',
                          de: 'Richte die Kamera auf den Boden und tippe, um den Stuhl zu platzieren.' },
  'ar.failed':          { en: 'Could not start AR — tap the ▶ AR button to launch it.',
                          de: 'AR konnte nicht gestartet werden — tippe auf die ▶ AR-Schaltfläche.' },
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
  'ar.tapToMove':       { en: 'Tap the floor where you want the chair.',
                          de: 'Tippe auf die Stelle am Boden, wo der Stuhl stehen soll.' },

  // -- Tutor fallbacks (spoken when the AI is unreachable) -------------------
  'tutor.noAi':         { en: "I can't reach the AI tutor right now, but you're looking at the {subject}.",
                          de: 'Ich erreiche den KI-Tutor gerade nicht, aber du siehst gerade: {subject}.' },
  'tutor.failed':       { en: "Sorry, I couldn't reach the tutor. That part is the {part}.",
                          de: 'Entschuldige, ich konnte den Tutor nicht erreichen. Dieses Teil: {part}.' },
  'tutor.thatPart':     { en: 'one you tapped',             de: 'das angetippte Teil' },
  'tutor.nextFallback': { en: 'The {part} goes on next. {step}', de: 'Als Nächstes: {part}. {step}' },

  // -- Grounding digest (fed to the LLM, never shown) ------------------------
  // These sit in the dictionary rather than in modes.js so the digest reads as
  // one language throughout — an English header on German facts invites the
  // model to answer in English.
  'digest.procedure':   { en: 'Repair procedure',           de: 'Reparaturablauf' },
  'digest.faults':      { en: 'Known faults (symptom — cause and fix):',
                          de: 'Bekannte Fehler (Symptom — Ursache und Behebung):' },
  'teardown.title':     { en: 'Teardown',                   de: 'Demontage' },
  'teardown.step':      { en: 'Remove {part}.',             de: 'Bau {part} aus.' },
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
