/**
 * Icons: one stroke set, drawn inline.
 *
 * The UI used to carry its iconography *inside* the translated strings
 * ('🎤 Hold to ask'). That reads fine at a glance and is wrong in three ways: an
 * emoji renders as a different picture on every platform, it can't be recoloured
 * or resized with the label it sits beside, and — worst — it has to be repeated
 * in every language of a string that is otherwise pure text. The dictionary now
 * holds words only; the picture lives here.
 *
 * Two consumers, one rule between them:
 *
 *  - **Static markup** carries `data-icon="mic"` on an empty span, hydrated once
 *    at boot by `hydrateIcons()`.
 *  - **Dynamic buttons** (the mode bar, the card's chips, the home list) are
 *    built with `setLabel(el, text, name)`.
 *
 * The rule: the icon and the label are *siblings*, never nested. i18n.js's
 * `applyStaticTranslations()` repaints `[data-i18n]` with `textContent`, which
 * would wipe an icon sharing that element — so the label always sits in its own
 * `<span class="lbl">` and the icon beside it. That is also why `setLabel`
 * writes to `.lbl` rather than to the button.
 *
 * Paths are 24×24, stroke-only (`currentColor`), so a button's `color` drives
 * the icon and the theme swap needs no icon-specific rule.
 */

// `c:` marks a path that should be filled rather than stroked (none currently);
// everything else is stroked at the weight set in CSS.
const ICONS = {
  // -- Modes ------------------------------------------------------------------
  explore:  '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16 16"/>',
  fix:      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  assemble: '<path d="M21 8.5 12 3.5 3 8.5v7L12 20.5l9-5v-7z"/><path d="m3.3 8.2 8.7 5 8.7-5"/><path d="M12 20.5v-7.3"/>',

  // -- Chrome -----------------------------------------------------------------
  mic:      '<path d="M12 2.5a3 3 0 0 0-3 3v6.5a3 3 0 0 0 6 0V5.5a3 3 0 0 0-3-3z"/><path d="M19 11v1a7 7 0 0 1-14 0v-1"/><path d="M12 19v2.5"/>',
  camera:   '<path d="M14.6 4H9.4L7.2 6.8H4.2A2.2 2.2 0 0 0 2 9v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2.2 2.2 0 0 0-2.2-2.2h-3L14.6 4z"/><circle cx="12" cy="13" r="3.4"/>',
  list:     '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><path d="M3.8 6.5h.01M3.8 12h.01M3.8 17.5h.01"/>',
  home:     '<path d="M3.5 10.2 12 3.4l8.5 6.8V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8.8z"/><path d="M9.4 21v-6.6h5.2V21"/>',
  controls: '<path d="M4.5 21v-6.5M4.5 10.2V3M12 21v-8.6M12 8.2V3M19.5 21v-4.6M19.5 12.2V3"/><path d="M1.8 14.5h5.4M9.3 8.2h5.4M16.8 16.4h5.4"/>',
  ar:       '<path d="M3 8.5V5.6A2.6 2.6 0 0 1 5.6 3H8.5"/><path d="M15.5 3h2.9A2.6 2.6 0 0 1 21 5.6V8.5"/><path d="M21 15.5v2.9a2.6 2.6 0 0 1-2.6 2.6H15.5"/><path d="M8.5 21H5.6A2.6 2.6 0 0 1 3 18.4V15.5"/><path d="M12 8.4 8.4 10.4v3.9L12 16.3l3.6-2v-3.9L12 8.4z"/>',
  moon:     '<path d="M20.8 13.1A8.6 8.6 0 1 1 11.2 3.3a6.8 6.8 0 0 0 9.6 9.8z"/>',
  sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2.2v2.1M12 19.7v2.1M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2.2 12h2.1M19.7 12h2.1M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/>',
  globe:    '<circle cx="12" cy="12" r="9"/><path d="M3.2 12h17.6"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  lock:     '<rect x="4.2" y="10.4" width="15.6" height="10.4" rx="2.2"/><path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/><path d="M12 14.6v2.2"/>',

  // -- Actions ----------------------------------------------------------------
  back:     '<path d="m14.5 18.5-6.5-6.5 6.5-6.5"/>',
  next:     '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  down:     '<path d="m6 9.5 6 6 6-6"/>',
  check:    '<path d="M20 6.5 9.4 17.1l-5.4-5.4"/>',
  close:    '<path d="M18 6 6 18M6 6l12 12"/>',
  again:    '<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5L3 8.2"/><path d="M3 3.2v5h5"/>',
  speak:    '<path d="M11 5 6.2 9H2.6v6h3.6L11 19V5z"/><path d="M15.3 8.6a4.8 4.8 0 0 1 0 6.8"/><path d="M18.2 5.8a8.8 8.8 0 0 1 0 12.4"/>',
  hint:     '<path d="M9.5 18.2h5M10.4 21.5h3.2"/><path d="M12 2.5a6.8 6.8 0 0 0-3.9 12.4v1.5h7.8v-1.5A6.8 6.8 0 0 0 12 2.5z"/>',
  place:    '<path d="M15 3.5V2M15 15.5V14M8.6 8.7h-2M23.4 8.7h-2M19.1 12.6l1.1 1.1M19.1 4.8l1.1-1.1"/><path d="M2.5 21.5 13 11"/>',
  sparkle:  '<path d="m12 3 1.9 5.4L19.3 10l-5.4 1.6L12 17l-1.9-5.4L4.7 10l5.4-1.6L12 3z"/>',
};

/** The SVG markup for one icon. Unknown names render nothing rather than throw —
 *  a missing icon should cost a picture, never a button. */
export function iconSvg(name) {
  const d = ICONS[name];
  if (!d) return '';
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

/** Fill every `[data-icon]` placeholder in `root`. Idempotent — an already-drawn
 *  placeholder is skipped, so it is safe to re-run after markup changes. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstElementChild?.tagName === 'svg') continue;
    el.innerHTML = iconSvg(el.dataset.icon);
  }
}

/**
 * Label a button without disturbing its icon.
 *
 * The label lives in `.lbl`; the icon is its sibling. Passing `name` swaps the
 * icon too (the theme toggle and the mic both change picture with their state).
 * Called on every language switch, so it must not accumulate nodes.
 */
export function setLabel(el, text, name = null) {
  if (!el) return;
  let lbl = el.querySelector(':scope > .lbl');
  if (!lbl) {
    // First call on a button built without markup (the mode bar, chips): give it
    // the icon+label pair it will keep for the rest of the session.
    el.textContent = '';
    if (name) el.insertAdjacentHTML('beforeend', iconSvg(name));
    lbl = document.createElement('span');
    lbl.className = 'lbl';
    el.appendChild(lbl);
  } else if (name) {
    // Not `:scope > svg` — in static markup the icon sits inside its `data-icon`
    // placeholder, so a direct-child search finds nothing and every state change
    // (theme, mic, step) would insert *another* icon beside the one already
    // there. Replacing whatever icon is in the button, at whatever depth, is the
    // only version of this that stays idempotent.
    const svg = el.querySelector('svg.ico');
    if (svg) svg.outerHTML = iconSvg(name);
    else el.insertAdjacentHTML('afterbegin', iconSvg(name));
  }
  lbl.textContent = text;
}
