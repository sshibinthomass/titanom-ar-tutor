/**
 * URL routing — one link per screen.
 *
 * Every screen the app can be on now has its own address, so a mode can be
 * bookmarked, shared, opened on the phone from the laptop, and reached with the
 * browser's Back button. The grammar is deliberately tiny and reads as what it
 * shows:
 *
 *   /                     the home screen — "what are we working on?"
 *   /scan                 …its camera view
 *   /objects              …its object list
 *   /<model>              an object, at the default mode
 *   /<model>/<mode>       an object in one of the five modes
 *
 * e.g. `#/markus-chair/fix`, `#/bicycle/quiz`.
 *
 * **Why the hash.** There is no server here — a static Vite build served from a
 * GitHub Pages *project sub-path* (`base: './'`). A real path like
 * `/markus-chair/fix` would be a 404 on a cold load unless someone maintains a
 * rewrite rule, and it would also have to know the sub-path to build links.
 * Everything after `#` is one document request the host already understands,
 * and it is sub-path-agnostic for free.
 *
 * The module owns the grammar and the browser plumbing. It owns no app state
 * and knows no model or mode ids: the caller passes the vocabulary in (so an id
 * that no longer exists degrades to the front door rather than to a blank
 * screen) and does the actual work in its route handler.
 */

// Home is one screen with three views, and each is a page in its own right —
// "scan an object" is the app's most linkable entry point. The paths are worded
// for a human reading the address bar; the view ids are home.js's own.
const VIEW_PATH = { choose: '/', scan: '/scan', pick: '/objects' };
const PATH_VIEW = { scan: 'scan', objects: 'pick' };

/**
 * Read a hash into a route. Always returns a usable route: an id the app no
 * longer has (a stale bookmark, a typo, a re-shuffled registry) lands on the
 * home screen, which is the one screen that can always be rendered.
 *
 * `models` is the *selectable* list, not the whole registry — a link may only
 * name an object the pickers offer, or the model dropdown could be pointed at
 * an option it doesn't have.
 */
export function parseRoute(hash, { models, modes, defaultMode }) {
  const segments = String(hash || '')
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

  if (!segments.length) return { kind: 'home', view: 'choose' };

  const view = PATH_VIEW[segments[0].toLowerCase()];
  if (view) return { kind: 'home', view };

  const model = segments[0];
  if (!models.includes(model)) return { kind: 'home', view: 'choose' };
  // An unknown mode keeps the object rather than throwing the whole link away —
  // the model is the expensive half of the route, and boot re-writes the URL to
  // the normalised form anyway.
  const mode = segments[1] && modes.includes(segments[1]) ? segments[1] : defaultMode;
  return { kind: 'object', model, mode };
}

/** The canonical path for a route — the inverse of parseRoute. */
export function routePath(route) {
  if (!route || route.kind === 'home') return VIEW_PATH[route?.view] || VIEW_PATH.choose;
  return `/${encodeURIComponent(route.model)}/${encodeURIComponent(route.mode)}`;
}

/** The route the address bar is currently on. */
export function currentRoute(vocab) {
  return parseRoute(location.hash, vocab);
}

/**
 * Point the address bar at `path`.
 *
 * Returns false when we were already there — which is the common case, since
 * the app re-derives its own route after every state change and only the ones
 * that actually moved should reach the history.
 *
 * `replace` rewrites the current entry **without firing `hashchange`**, so it
 * is only for normalising a URL whose state the caller has already applied
 * (boot, an unknown mode falling back to Explore). Everything a user did gets a
 * history entry, so Back walks their steps.
 */
export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return false;
  if (replace) {
    // replaceState is unavailable in a few sandboxed contexts (a null-origin
    // iframe); location.replace is the same intent, and the hashchange it does
    // fire is harmless — applying a route the app is already on is a no-op.
    try { history.replaceState(null, '', target); } catch { location.replace(target); }
  } else {
    location.hash = target;
  }
  return true;
}

/** Run `fn` whenever the address bar moves — Back/Forward, or a pasted link. */
export function onRouteChange(fn) {
  window.addEventListener('hashchange', () => fn());
}
