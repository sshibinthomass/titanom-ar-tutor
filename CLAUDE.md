# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What this is

**AR Repair Tutor** — a Titanom × DeutschlandGPT hackathon app (Aug 2026, theme
Education × AI, ElevenLabs award). Point a phone at the floor (WebXR hit-test),
place an **exploded 3D object**, and an AI voice tutor teaches, repairs, and
diagnoses it hands-free. The desktop 3D view works everywhere; markerless AR is
**Android Chrome only** (iOS/desktop fall back to the orbit viewer).

Stack: **Vite + Three.js**, no other runtime deps. Plain ES modules, no
framework, no TypeScript, no bundled UI lib. Keep it that way unless there's a
strong reason.

## Commands

```bash
npm install
npm run dev      # Vite dev server, exposed on the LAN (host:true) so a phone can reach it
npm run build    # production build → dist/
npm run preview  # serve the built dist/
```

To test AR you need HTTPS + a real Android device. In dev, reach the LAN URL
Vite prints from an Android Chrome phone (WebXR needs a secure context — use a
tunnel like the dev server over https or a service such as ngrok if plain LAN
http is rejected).

## Architecture

Everything is wired in [src/main.js](src/main.js) — the single entry point that
owns the renderer, scene, UI refs, mode state, and the render loop. The other
modules are focused, mostly-pure helpers it calls.

| File | Responsibility |
|------|----------------|
| [src/main.js](src/main.js) | App shell: renderer/scene/camera/lights, model registry, UI wiring, mode state machine, voice + AR glue, render loop. |
| [src/explode.js](src/explode.js) | The **core**. Splits a glTF into parts and drives the exploded view + per-part highlight/dim/isolate. |
| [src/modes.js](src/modes.js) | The 5 modes + **authored per-model content** (fix steps, diagnoses, quizzes) and semantic part names. |
| [src/select.js](src/select.js) | Raycast tap/click part-picking (drag threshold so orbiting ≠ tapping). |
| [src/ar.js](src/ar.js) | WebXR `immersive-ar` session: hit-test reticle, tap-to-place, long-press to grab then one-finger drag-to-move / pinch scale + twist rotate; voice "move it" re-places on a fresh anchor. |
| [src/tts.js](src/tts.js) | Text-to-speech. ElevenLabs primary, browser `speechSynthesis` fallback. |
| [src/voice.js](src/voice.js) | Speech-to-text via Web Speech API (`SpeechRecognition`), auto-restarting recognizer. |
| [src/ai.js](src/ai.js) | DeutschlandGPT chat client (OpenAI-compatible `/chat/completions`). |
| [src/tutor.js](src/tutor.js) | "Brain" glue: classify a spoken phrase into an app command vs. a free-form question, then answer via AI with context. |
| [src/telemetry.js](src/telemetry.js) | Langfuse tracing. Batches ingestion events to a credential-free proxy (Vite in dev, Worker in prod). No-op when unconfigured. |

### The part-splitting core (`explode.js`)

Sketchfab exports come in two flavours, so there are two split strategies chosen
per model via `defaultMode` in the `MODELS` registry:

- **`group`** — one part per source mesh. Good when the model is already split
  by material (e.g. the bicycle). Clean, semantic parts.
- **`component`** — split each mesh's geometry into **connected components**
  (union-find over welded vertex positions). Needed when the model is one fused
  mesh (the office chair, the bed). Vertices are welded by quantized position
  (precision relative to model scale) so split normals/UVs at seams don't
  fracture a single physical piece into many.

Each part gets its **material cloned** so highlight/dim (emissive + opacity)
affect only that part — critical in `component` mode where many parts share one
source material. Geometry is baked to world space, so the exploded group has an
identity transform and drops in exactly where the original sat.

Key exports used across the app: `buildExplodedView`, `setExplode`,
`isolateParts` (spotlight some, dim the rest), `setHighlight`, `clearPartStates`,
`findParts`/`findPart` (match parts by name keyword).

### Modes (`modes.js` + state in `main.js`)

All 5 modes ride the **same core** (explode + isolate/highlight + visibility);
only the card content and which parts are lit change:

1. **Explore** — tap a part → isolate + name it.
2. **Fix** — ordered repair steps; Next/Back spotlights each step's part(s).
3. **Assemble** — progressive build-up; each step *reveals* the group added.
4. **Diagnose** — pick a symptom chip → highlight the likely part.
5. **Quiz** — highlight a part, ask the user to name it.

Authored content in `CONTENT` (keyed by model id) references parts by **keyword**
(`match: ['cylinder','gas','lift']`), resolved against the live part list at
runtime via `findParts()` — so it survives however the splitter cut the model.
Resolvers fall back to a generic teardown when a model has no authored content.

**Hero model:** the office chair is one fused mesh → 20 connected components. The
raw indices are mapped to real names (Backrest, Gas cylinder, Armrest, Seat,
Star base, Caster×5, Base hub, Height lever) in `SEMANTIC_NAMES['office-chair']`.
Several islands share a name (5 casters), so highlighting a name lights the whole
group.

> ⚠️ Those semantic indices come from the **deterministic** component split of
> this exact GLB (verified via bounding-box positions). **If a model is
> re-exported, the indices can change** — re-run the split and re-map. To
> re-author them, `window.__parts` is exposed in `rebuild()` with each part's
> triangle count and world-space bbox.

### Voice + AI flow

Mic → `voice.js` transcript → `tutor.classifyCommand()`:
- **command** (next/back/repeat/reset/explode, or a mode switch, or "explain
  this") → runs against the current mode in `main.js`.
- **question** → `tutor.answerQuestion()` builds a system prompt with the current
  model, its part names, active mode, and focused part, calls DeutschlandGPT, and
  speaks the ≤2-sentence answer via `tts.speak()`.

`say()` in main.js remembers the last spoken line for the "repeat" command. TTS
and AI both **degrade gracefully**: no ElevenLabs key → browser speech; no
DeutschlandGPT → a canned local answer.

### Telemetry (`telemetry.js`)

Everything is traced to **Langfuse**: a session per page load, a trace per voice
utterance, AI answers as *generations* (model + token usage + latency), plus
mode/model switches, AR place/exit, TTS provider/fallback, and errors. It speaks
the Langfuse **ingestion API directly** (batched `{id,type,timestamp,body}`
events → `POST /api/public/ingestion`) — no SDK, no extra runtime dep.

The interesting constraint: Langfuse ingestion authenticates with a **secret**
key via Basic auth, which must never enter a static bundle. So the browser sends
**credential-free** batches and a proxy injects the auth server-side:

- **dev:** the app POSTs to `/lf-api/*`; the Vite proxy ([vite.config.js](vite.config.js))
  adds `Authorization: Basic <public:secret>` from the non-`VITE_`-prefixed
  `LANGFUSE_*` vars (so they're never bundled) and forwards to Langfuse Cloud.
- **prod:** set `VITE_LANGFUSE_BASE_URL` to the Worker's `/langfuse` route — the
  same Worker as DGPT ([worker/](worker/dgpt-proxy.js)), which holds the keys as
  secrets. If it's unset, telemetry is a **silent no-op** (like AI/TTS degrade).

Instrumentation points: `answerQuestion` (tutor.js) opens the trace and `chat`
(ai.js) records the generation; `main.js` calls `track()`/`initTelemetry()` for
voice commands, modes, model loads and AR; `tts.js` tracks the spoken provider.

### AR (`ar.js`)

Scene graph once placed: `anchor` (world pose, on the floor) → `pivot` (user
rotate/scale about the floor contact) → `group` (the model, fit to ~0.7 m). HTML
UI is kept as a `dom-overlay` so the mode bar/cards/mic render over the camera
feed. `renderer.setAnimationLoop` handles both normal rAF and the XRFrame (Three
passes the frame as the 2nd arg during a session). `onSessionEnd` fully restores
the desktop scene (parent, transform, background, controls).

**Stability** (why the placed object stays put) rests on three things — don't
regress them:

1. **Real WebXR anchors.** On placement we call `frame.createAnchor()` at the
   floor pose and then re-read that anchor's pose (`frame.getPose(anchorSpace,
   refSpace)`) into `anchor.matrix` **every frame**. The runtime keeps refining
   anchor poses as it maps the room, so the model tracks the real world instead
   of drifting. Requires the `anchors` optional feature; if the device lacks it
   we fall back to a one-shot frozen matrix (the old, less-stable behaviour).
2. **PoseStabilizer** on the reticle — exponential-damped smoothing + an
   N-consecutive-still-frames gate + a big-jump reject. The reticle only appears
   (and only then is a tap accepted) once the surface estimate has converged, so
   we never anchor to a garbage first-frame pose.
3. **One reference space.** Hit-test poses, anchor poses and rendering all use
   `renderer.xr.getReferenceSpace()`, so nothing disagrees about the world
   origin. (Reading poses in a separately-requested `local` space, as before,
   could silently offset placement.)

User yaw/scale live on `pivot`, never baked into the anchor, so per-frame anchor
refinement never fights the user's manipulation — only **Move** creates a new
anchor (a new floor spot). Ported from the reference
[Web-AR](https://github.com/sshibinthomass/Web-AR) project's
`AnchorManager` / `PoseStabilizer` / `HitTestManager`.

## Configuration & secrets

Config is via env vars (see [.env.example](.env.example)) — copy to `.env`
(gitignored). ElevenLabs voice/model, DeutschlandGPT key/base/model, Langfuse
keys.

> 🔐 **Every `VITE_`-prefixed value is baked into the public JS bundle** (static
> site) and visible to anyone who opens the deployed site. Use **restricted /
> throwaway keys** and revoke them after the hackathon.
>
> The **Langfuse** keys are deliberately **not** `VITE_`-prefixed
> (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`), so Vite
> never bundles them — they're consumed only server-side (the Vite dev proxy and
> the Worker). The only Langfuse value the client sees is `VITE_LANGFUSE_BASE_URL`
> (a proxy URL, not a key). This is the pattern the other keys *should* use; a
> real backend would proxy those too.

### DeutschlandGPT + Langfuse both need a proxy

Neither can be called from the browser directly (DGPT has no CORS; Langfuse
needs a secret key). Same two-path pattern for both:
- **dev:** the app calls `/dgpt-api/*` and `/lf-api/*`; the Vite proxy forwards
  them server-side (and injects Langfuse Basic auth). See [vite.config.js](vite.config.js).
- **prod:** deploy the single Cloudflare Worker in [worker/](worker/dgpt-proxy.js)
  (holds the keys as secrets, adds CORS, routes `/langfuse/*` to Langfuse and
  everything else to DGPT). Set `VITE_DGPT_BASE_URL` to its root and
  `VITE_LANGFUSE_BASE_URL` to its `/langfuse` route — and **don't** set
  `VITE_DGPT_API_KEY` or any `LANGFUSE_*` key in the app.

## Deploy

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds and deploys
to GitHub Pages on push to `main` (Vite `base: './'` so it works under the Pages
sub-path). The build reads the `VITE_*` values from repo **Actions secrets**
(the ElevenLabs/DGPT keys plus `VITE_LANGFUSE_BASE_URL` — note the Langfuse keys
themselves are **not** here; they live as Worker secrets).

**Status / gotcha:** the build job passes but deploy fails until a repo **admin**
does two one-time manual steps:
1. Settings → Pages → Source: **GitHub Actions**.
2. Add the `VITE_*` Actions secrets (and deploy the Worker with its secrets for
   AI + telemetry to work — see [worker/README.md](worker/README.md)).

Then the site is at `https://<owner>.github.io/titanom_hack_2026/`.

## Conventions

- Plain ES modules; helpers are small and mostly pure. `main.js` holds mutable
  app state and does the wiring.
- Refer to parts by **keyword match**, never by hard-coded index in content —
  indices are only pinned in `SEMANTIC_NAMES` for the fused hero model.
- Always clone materials before mutating per-part visual state.
- Model paths must use `import.meta.env.BASE_URL` (never a leading `/`) so they
  resolve under the Pages sub-path.
- Comments explain the *why* (export quirks, CORS, weld precision) — keep that
  style; match the existing density.
