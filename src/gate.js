/**
 * The passcode gate: one shared 4-digit code in front of the whole app.
 *
 * Everyone who uses the tutor uses the same code (`PASSCODE`) — there are no
 * accounts, no per-user secrets and nothing to sign up for. It exists so a link
 * to the deployed demo isn't simply open to the web during the hackathon.
 *
 * Three properties, and they are the whole design:
 *
 * 1. **Every way in lands here.** A cold load, a pasted deep link
 *    (`#/markus-chair/fix`), a bookmark, a scan link — main.js routes *nothing*
 *    until this resolves, so a link can never open the object it names before
 *    the code is entered. The overlay is painted by the **markup**, not by JS,
 *    so there is no frame in which the app behind it is visible either.
 * 2. **One session, one entry.** The unlock is remembered in `sessionStorage`,
 *    so a reload or an in-tab navigation doesn't ask again, while a fresh tab
 *    (i.e. somebody opening the link) does. The stored value is the code itself
 *    rather than a flag: changing `PASSCODE` should retire every session that
 *    was let in by the old one, and the code is in the bundle regardless (see
 *    below), so storing it leaks nothing new.
 * 3. **It is a door, not a vault.** This is a static site: the code travels in
 *    the JS bundle and anyone who opens devtools can read it, exactly like the
 *    `VITE_`-prefixed keys documented in CLAUDE.md. Treat it as "not publicly
 *    walk-in-able", never as access control over anything that matters.
 */

const PASSCODE = '0204';

const STORAGE_KEY = 'unlock';
const DIGITS = PASSCODE.length;
const SHAKE_MS = 400;

let unlocked = false;

/** True until the passcode has been accepted. Callers that repaint the whole UI
 *  (the language switch) use this to skip work that needs a loaded model. */
export function isLocked() { return !unlocked; }

function remembered() {
  try { return sessionStorage.getItem(STORAGE_KEY) === PASSCODE; } catch { return false; } // private mode
}

/**
 * Run `onUnlock` once the user is in — immediately if this tab has already been
 * unlocked, otherwise when the right code is entered. Everything the app does on
 * boot hangs off this callback.
 */
export function requireUnlock(onUnlock) {
  const el = {
    lock: document.getElementById('lock'),
    form: document.getElementById('lockForm'),
    input: document.getElementById('lockInput'),
    error: document.getElementById('lockError'),
  };

  // No overlay in the document (or storage already says yes): go straight in.
  // A missing #lock must not lock the app out of itself.
  if (!el.lock || !el.form || !el.input || remembered()) {
    open(el, onUnlock);
    return;
  }

  document.body.classList.add('lock-open');
  // Not autofocus in the markup: on a phone that pops the keyboard over the
  // prompt explaining what the code even is.
  if (matchMedia('(min-width: 721px)').matches) el.input.focus();

  el.input.addEventListener('input', () => {
    // The field is the code and nothing else, so anything that isn't a digit is
    // dropped as it arrives (a pasted "02 04", an autofilled password).
    const digits = el.input.value.replace(/\D/g, '').slice(0, DIGITS);
    if (digits !== el.input.value) el.input.value = digits;
    el.error.classList.remove('show');
    // Auto-submit on the last digit: a 4-digit code needs no confirmation, and
    // the Unlock button stays for the keyboard and for a retry.
    if (digits.length === DIGITS) el.form.requestSubmit();
  });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (el.input.value !== PASSCODE) {
      reject(el);
      return;
    }
    try { sessionStorage.setItem(STORAGE_KEY, PASSCODE); } catch { /* private mode: ask again next reload */ }
    open(el, onUnlock);
  });
}

/** Wrong code: say so, shake, and hand the empty field back with focus. */
function reject(el) {
  el.input.value = '';
  el.error.classList.add('show');
  el.lock.classList.remove('shake');
  // Re-flow between the two so a second wrong code restarts the animation
  // instead of finding the class already set and doing nothing.
  void el.lock.offsetWidth;
  el.lock.classList.add('shake');
  setTimeout(() => el.lock?.classList.remove('shake'), SHAKE_MS);
  el.input.focus();
}

function open(el, onUnlock) {
  unlocked = true;
  document.body.classList.remove('lock-open');
  if (el.lock) el.lock.hidden = true;
  // The keyboard has no business staying up over the object.
  el.input?.blur();
  onUnlock();
}
