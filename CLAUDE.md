# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What this is

**AR Repair Tutor** — a Titanom × DeutschlandGPT hackathon app (Aug 2026, theme
Education × AI, ElevenLabs award). Point a phone at the floor (WebXR hit-test),
place an **exploded 3D object**, and an AI voice tutor teaches, repairs, and
diagnoses it hands-free. The desktop 3D view works everywhere; markerless AR is
**Android Chrome only** (iOS/desktop fall back to the orbit viewer).

**The object is the IKEA Markus chair.** It is the default selection, the only
model fetched on boot, and the one every mode's content is authored for. The
office chair, bicycle and bed are secondary demos that prove the splitter is
model-agnostic — they load lazily, only if the user picks them from the
dropdown. **Build every new feature for the Markus first**: author its content in
`CONTENT['markus-chair']` / `MARKUS_INFO`, name its parts in
`SEMANTIC_NAMES['markus-chair']`, and demo it on the Markus. A feature that only
works on another model is not done. Porting to the other models afterwards is
optional; where a feature can't be authored for them, the generic fallback
resolvers must still keep them functional (never crashing, never blank).

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
| [src/animate.js](src/animate.js) | Tween engine (keyed channels, driven from the render loop) + the camera flight that frames a part. |
| [src/modes.js](src/modes.js) | The 5 modes + **authored per-model content** (fix steps, assemble prompts, diagnoses, quizzes) and semantic part names. |
| [src/puzzle.js](src/puzzle.js) | Assemble's drag-to-build engine: scatter, ghost slots, snap magnetism, reject. Surface-agnostic — driven by a world-space ray. |
| [src/select.js](src/select.js) | Raycast tap/click part-picking (drag threshold so orbiting ≠ tapping) + the desktop part-dragger. |
| [src/ar.js](src/ar.js) | WebXR `immersive-ar` session: hit-test reticle, tap-to-place, long-press to grab then one-finger drag-to-move / pinch scale + twist rotate; voice "move it" re-places on a fresh anchor. Also hands the finger's target ray to an **interactor** (the puzzle). |
| [src/tts.js](src/tts.js) | Text-to-speech. ElevenLabs primary, browser `speechSynthesis` fallback; race-proof (one voice at a time) and interruptible. |
| [src/sfx.js](src/sfx.js) | The puzzle's sound cues (snap / reject / dismantle). ElevenLabs **sound generation**, pre-generated + cached; WebAudio synth fallback. |
| [src/voice.js](src/voice.js) | Speech-to-text: WebAudio VAD + MediaRecorder → DGPT Whisper (noise-robust, works on iOS); Web Speech API fallback. Fires barge-in the moment the user speaks. |
| [src/ai.js](src/ai.js) | DeutschlandGPT chat client (OpenAI-compatible `/chat/completions`). |
| [src/tutor.js](src/tutor.js) | "Brain" glue: classify a spoken phrase into an app command vs. a free-form question, then answer via AI with context. |
| [src/telemetry.js](src/telemetry.js) | Langfuse tracing. Batches ingestion events to a credential-free proxy (Vite in dev, Worker in prod). No-op when unconfigured. |

### The part-splitting core (`explode.js`)

Sketchfab exports come in two flavours, so there are two split strategies chosen
per model via `defaultMode` in the `MODELS` registry:

- **`group`** — one part per source mesh. Good when the model is already split
  by mesh/material — **the hero Markus uses this** (47 meshes → 47 parts), as
  does the bicycle. Clean, semantic parts.
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

### Motion (`animate.js`)

Nothing snaps. Two tween **channels** — `'explode'` and `'camera'` — are advanced
by the single `updateTweens(dt)` call in the render loop; starting a tween on a
channel replaces the one already there, so mashing **Next** never stacks
half-finished flights. `prefers-reduced-motion` completes every tween on
creation, which is exactly the app's old snap behaviour.

- **Explode** is *staggered*: `setExplodeAmount()` gives each part its own slice
  of the timeline (`EXPLODE_STAGGER`), so the model unpeels outward instead of
  inflating as one rigid shell. That's why the tween calls `setPartExplode()`
  per part rather than `setExplode()` — a uniform amount would flatten the
  cascade. Dragging the slider stays instant and cancels any tween.
- **Camera** — `flyToParts()` frames whatever a guided step just spotlighted.
  It **keeps the user's viewing angle** and only orbits (smallest turn that
  clears the view) when something *solid* blocks the part. Ghosted parts
  (`isolateParts` dims the rest to ~7%) explicitly don't count as occluders,
  or every Fix step would swing the camera for nothing.

Three things keep it from fighting other systems — don't regress them:

1. **The destination is re-derived every frame**, not frozen at t=0. An explode
   tween usually runs alongside, so parts are still moving and `groundExploded()`
   is still shifting the group vertically. Freezing the target makes the camera
   drift toward a stale point; freezing the *distance* frames the same step
   differently depending on whether it was reached mid-explode or after.
2. **`controls`' `start` event cancels the camera tween** — the moment the user
   grabs the scene, the flight lets go instead of fighting the drag.
3. **`autoRotate` yields while a flight runs**, and flights are **skipped
   entirely during AR** (`renderer.xr.isPresenting`), where `camera` is the
   device pose and writing to it would fight WebXR. The explode animation *does*
   run in AR — it's the best thing in the demo there.

### Modes (`modes.js` + state in `main.js`)

All 5 modes ride the **same core** (explode + isolate/highlight + visibility);
only the card content and which parts are lit change:

1. **Explore** — tap a part → isolate + name it.
2. **Fix** — ordered repair steps; Next/Back spotlights each step's part(s).
3. **Assemble** — a **drag-to-build puzzle** (see below); the user places each group.
4. **Diagnose** — pick a symptom chip → highlight the likely part.
5. **Quiz** — highlight a part, ask the user to name it.

Authored content in `CONTENT` (keyed by model id) references parts by **keyword**
(`match: ['cylinder','gas','lift']`), resolved against the live part list at
runtime via `findParts()` — so it survives however the splitter cut the model.
Resolvers fall back to a generic teardown when a model has no authored content.

**Hero model — IKEA Markus (`markus-chair`).** It splits in `group` mode into
**47 meshes**, every one named individually in `SEMANTIC_NAMES['markus-chair']`
(Backrest frame, Gas cylinder, Height lever + its shaft, Recline lock lever,
Tilt tension knob, Caster wheels/stem/brake hood ×5, Mesh panel front/rear,
Lumbar support band ×10, …). The names were identified visually part-by-part in
Blender and checked against the official IKEA assembly manual (AA-251870-21);
its fix/assemble/diagnose/quiz content and the per-part `MARKUS_INFO`
descriptions are grounded in that manual and real IKEA part numbers — so keep
new Markus content factual, not invented.

### The Assemble puzzle (`puzzle.js`)

Assemble is the one mode that is *interactive* rather than narrated: parts
scatter in a ring on the floor, the current step's slot is drawn as a
translucent ghost, and the user drags the piece they think comes next into it.
Right piece → it snaps and the group settles; wrong piece → red flash, shake,
and the tutor says **why** that part comes later.

Three design rules hold the learning value; don't quietly undo them:

- **Prompt before label.** `ASSEMBLE_PROMPT` asks by function or position and
  never names the part; `ASSEMBLE_TEXT` (the naming line) is spoken only *after*
  a correct placement. Naming it up front turns recall into fetching.
- **A failed drop points forward, not back.** The shake and the red flash
  already say the drop failed, so the words don't repeat it: they name the part
  to reach for. `explainNextPart()` (tutor.js) leads with the expected part and
  adds why it comes first, and is explicitly told never to mention the wrong
  attempt or use correction language ("not yet", "instead"). It degrades to the
  step's own instruction line, so the guidance is never silent. Don't reintroduce
  "that's the X" phrasing — it scolds without adding information the learner
  doesn't already have.
- **One correct drop places the whole semantic group.** A step is a group (5
  casters; the Markus has *15* caster pieces) — dragging each one is busywork
  after the first. Dropping any member into any of that step's slots counts.

Entering the mode (and "Build it again") opens by **taking the assembled object
apart** rather than cutting to a pile: `scatter({ animate, stagger })` releases
one group per `SCATTER_STAGGER` in *reverse* build order, so it reads as a
teardown from the top down — and the learner sees the finished object once
before being asked to rebuild it. The ghost is held hidden (`state.ghostHold`)
until the teardown clears, or the first slot's outline would glow inside the
part still sitting in it. Between steps the remaining parts *glide* to their new
ring positions (animated, no stagger) so a piece you were eyeing doesn't
teleport.

**Everything is measured in the exploded group's local space**, which is what
makes one implementation correct on both surfaces: geometry is baked at build
time so a part's slot is simply "where its geometry already is"
(`restPosition` is 0), and converting the pointer ray with `worldToLocal` cancels
out the AR pivot's user scale (verified 0.35×–3.1×), its yaw, and the per-frame
anchor refinement. A carried part is a child of the group, so anchor refinement
carries it along instead of fighting it.

Input is abstracted to a **world-space ray**, so both surfaces share the engine:
- **desktop** — `attachDragger` (select.js) builds it from camera + cursor.
- **AR** — ar.js reads the XR input source's target ray (`targetRayMode:
  'screen'` — the finger) from `selectstart` to `selectend`. Do *not* try to
  rebuild NDC against the XR `ArrayCamera`; the target ray is exact and is read
  in the same reference space as the anchor.

### Sound cues (`sfx.js`)

Three cues — `snap`, `reject`, `dismantle` — generated by **ElevenLabs sound
generation** (`POST /v1/sound-generation`, same `VITE_ELEVENLABS_API_KEY` as the
voice), prompted in words like everything else here.

The constraint that shapes the module: generation takes *seconds*, so nothing is
ever fetched on demand — a cue requested when the part lands would arrive long
after the moment it punctuates. `primeSfx()` runs once at startup, the mp3 is
cached in **localStorage** (base64) so it is one request per browser ever, and
it is decoded to an AudioBuffer so playback is a zero-latency WebAudio call
rather than an `<audio>` element (which stutters when re-triggered). Anything
asked for before its clip is ready falls straight through to a small WebAudio
**synth** — as does everything when no key is set. Feedback is never delayed
waiting on the network.

Bump `CACHE_VERSION` when you edit a prompt, or browsers keep the old sound.
Keep the prompts short, physical and explicitly non-musical: the tutor starts
speaking a beat after each cue, and a cue that turns into a jingle fights it.

**Snap magnetism** (`applyAssist`) is not polish, it is load-bearing. A drag
rides at the distance the part was grabbed at, but the slot sits at the centre of
the scatter ring — up to a ring radius nearer or further — so a pointer that is
dead-on in screen terms is still far off in depth. Reach is therefore measured
*perpendicular to the carry ray* against the **slot centre** (the ghost you aim
at, not the mesh origin), while the pull applies in all three axes. It is a
**persistent blend** (`held.assist`, eased 0→1), because `move()` rewrites the
raw target from the live ray every frame and any one-shot nudge would be
discarded before it accumulated. Both of those were real bugs; the symptom is a
part that hovers in front of the slot and never snaps.

Stability in AR rests on: the local-space maths above, damped carry (the same
exponential smoothing the reticle uses — a hand-held phone ray is noisy), and
`setManipulationEnabled(false)` while a puzzle runs, which retires the
whole-model gestures so a drag can never slide the board out from under the
build. Voice "move it" still repositions. The puzzle also asks AR for
**life-size** (`MODELS[*].realHeight` ÷ the 0.7 m fit) rather than tabletop
scale, so reaching for a part rehearses the real reach.

The secondary office chair is one fused mesh → 20 connected components, mapped
to names (Backrest, Gas cylinder, Armrest, Seat, Star base, Caster×5, Base hub,
Height lever) in `SEMANTIC_NAMES['office-chair']`. Several islands share a name
(5 casters), so highlighting a name lights the whole group — true for the Markus
casters too.

> ⚠️ Semantic indices in both maps come from the **deterministic** split of that
> exact GLB (Markus: mesh rank by triangle count; office chair: component order,
> verified via bounding-box positions). **If a model is re-exported, the indices
> can change** — re-run the split and re-map. To re-author them, `window.__parts`
> is exposed in `rebuild()` with each part's triangle count and world-space bbox.

### Voice + AI flow

The mic (🎤 Ask) is a **pure question channel** — a spoken phrase is never
parsed into an app command, so misheard noise can't switch modes or "act on
its own". Don't reintroduce voice commands; the two strictly-matched
exceptions in `handleSpeech` (a bare mute phrase, and "move it" inside an AR
session, which has no button) are deliberate and complete.

Capture (`voice.js`) is an always-on pipeline, not the Web Speech API: a
WebAudio **VAD** (band-limited 300–3400 Hz energy over an adaptive noise
floor, with hysteresis + a minimum-duration gate) finds utterances,
`MediaRecorder` captures them, and DGPT's Whisper endpoint
(`ai.transcribe()`, `/v2/audio/transcriptions`, model `whisper-1` via
`VITE_DGPT_STT_MODEL`) transcribes them. Transcripts that are only a Whisper
filler-hallucination ("you", "thank you") are dropped. Web Speech survives
only as the fallback when DGPT is unconfigured; with DGPT the pipeline works
on any browser with a mic, iOS Safari included.

Answering: `tutor.answerQuestion()` builds a system prompt with the current
model, its part names, active mode, focused part (resolves "this"/"it"), and
ALL authored per-part facts (`partInfoDigest` — never shown in the UI, LLM
grounding only), calls DeutschlandGPT, and speaks the ≤2-sentence answer via
`tts.speak()`. The LLM also names which part the question was about
(`PART: <name>` header) and main.js spotlights it — so asking about the gas
lift while the seat is selected highlights the gas lift and answers. It
declines only questions unrelated to the whole object, never "wrong part"
questions.

**Nothing ever overlaps.** Three interlocking guards — don't regress them:
1. **Barge-in**: the VAD's `onSpeechStart` fires the instant the user talks
   and main.js stops TTS, so the user can always interrupt an answer. While
   TTS is audible the VAD demands more sustained energy (`isTtsSpeaking`), so
   speaker bleed the echo canceller misses can't self-trigger; getUserMedia
   requests `echoCancellation` + `noiseSuppression` + `autoGainControl`.
2. **`speak()` is race-proof**: a generation token discards any utterance
   superseded while its ElevenLabs audio was still being generated.
3. **Newest question wins**: `handleSpeech` drops an answer if a newer
   question arrived (`askSeq`) or the user is mid-utterance (`isCapturing`).

TTS, STT and AI all **degrade gracefully**: no ElevenLabs key → browser
speech; no DeutschlandGPT → Web Speech recognition + a canned local answer.

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
rotate/scale about the floor contact) → `group` (the model, fit to ~0.7 m).
That fit is measured against the **assembled** model — `main.js` passes
`fitBox: restBounds()`, since the live bounds grow with the explode amount and
starting AR from a spread-out mode (Fix/Diagnose/Quiz) would otherwise scale the
object down to fit its exploded silhouette: entering from Fix placed a chair that
stood 0.39 m once reassembled, and from a full explode, 0.21 m. HTML
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
- The boot model is `DEFAULT_MODEL` in [src/main.js](src/main.js) (`markus-chair`),
  and the Markus is listed **first** in `MODELS` so it heads the dropdown. Don't
  preload the other models — one glTF fetch on boot. Voice model-switching
  (`MODEL_KEYWORDS`) gives a bare "chair" to the Markus; the office chair only
  answers to its multi-word phrases.
- Refer to parts by **keyword match**, never by hard-coded index in content —
  indices are only pinned in `SEMANTIC_NAMES` for the fused hero model.
- Always clone materials before mutating per-part visual state.
- Model paths must use `import.meta.env.BASE_URL` (never a leading `/`) so they
  resolve under the Pages sub-path.
- Comments explain the *why* (export quirks, CORS, weld precision) — keep that
  style; match the existing density.
