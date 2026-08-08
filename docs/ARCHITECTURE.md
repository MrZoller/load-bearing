# Load Bearing — Architecture

> The terminal is real; the computer is lying.
> **Guiding rule: the computer may lie. It must lie consistently.**

## System overview

Load Bearing is a static site. A reusable browser **runtime** loads one dated
**incident cartridge** and supplies all mechanics. There are no runtime model
calls and no server-side state: deterministic simulation is authoritative.

```
┌────────────────────────── browser ──────────────────────────┐
│  Agent TUI view          Simulated Bash view                │
│  (❯ prompt, /commands,   (visitor@production:~$)            │
│   tool-call animations)                                     │
│           └──────────────┬──────────────┘                   │
│                          ▼                                  │
│               Simulation engine (headless TS)               │
│   VFS · git · processes · services · tests · env · man      │
│   intents · escalation · metrics · event log · seeded PRNG  │
│                          ▲                                  │
│                          │ loads + validates                │
│               Incident cartridge (JSON, dated)              │
└─────────────────────────────────────────────────────────────┘
        ▲
        │ authored by (Phase 5)
  Nightly multi-agent pipeline → validated cartridge → static deploy
```

**The sacred boundary:** the runtime owns mechanics; cartridges own worlds.
The nightly pipeline may only ever produce content under approved content
paths. It never modifies runtime code. This separation is what allows an
autonomous agent to create new worlds nightly without touching load-bearing
application code — enforce it with path allowlists in CI, not convention.

---

## The simulation engine

### Headless by requirement

The engine is a pure TypeScript module with zero DOM dependencies, runnable
in Node and the browser. This is not a style preference: the Phase 5
playtester agents drive the *same engine* in CI to simulate visitor sessions.
If the engine only runs behind a UI, automated playtesting dies.

### Event sourcing and determinism

```
state = reduce(cartridge, seed, eventLog)
```

- Every visitor action (TUI input, shell command, model switch, Ctrl+D)
  appends an event. All state mutation flows through the reducer.
- **All randomness** goes through one seeded PRNG (e.g., mulberry32) seeded
  from `(incidentDate, dailySeed, model)`. No `Math.random()`.
- **All time** is simulated and advances by event, not wall clock. No
  `Date.now()` inside the engine.
- Rare events roll against the PRNG so they are rare per-session but exactly
  reproducible per-replay.

This buys, for free: shareable replay permalinks
(`incident + model + seed + compressed event log` in the URL), transcript
regression tests in CI, deterministic playtesting, and debuggability.

**Randomness is a tree of named streams, not one sequence** (`engine/random/`).
`rng.fork("spinner.verbs")` derives a child from the root seed and the child's
path — never from the parent's current position — so consuming from one stream
cannot shift another. With a single sequence every draw is positional, and
adding one rare-event roll during startup would renumber every subsequent draw
in every subsystem and break every golden fixture at once, for a reason none of
them would explain. The trade is that stream *names* become contract surface:
renaming one re-rolls everything drawn under it. Renaming is deliberate;
adding a draw is routine.

**Time is two numbers** (`engine/clock/`): the cartridge-declared session start
and the milliseconds advanced since. Which events advance it, and by how much,
belongs to the subsystems that raise them. Calendar arithmetic and timestamp
formatting are written out by hand in UTC, because `Date` reads the host
timezone and `Intl` reads the host locale — either would make the same session
render differently on a laptop than in CI.

### Simulated machine state

- **VFS:** tree with contents, permissions, owners/groups, mtimes, cwd —
  ownership metadata is a comedy surface (`ls -la` shows owner `greg`,
  group `departed`); mutations persist
  for the session ("a deleted file stays deleted")
- **Git:** commit DAG with authors/timestamps/messages, branches, index,
  working tree, blame per line, diff. Coherence is a hard requirement — the
  moment `git log` contradicts `git blame`, reaction #3 ("the state is
  consistent") dies
- **Processes and services:** cartridge-defined units with states, health,
  ports, and reactions to visitor actions (the health-check → load-balancer
  routing gag is a service reaction)
- **Test runner:** simulated `npm test`-style output defined per cartridge,
  reactive to file state
- **Logs, env, man pages, shell history, ticket archive:**
  cartridge-supplied, queryable via shell commands — the primary carriers
  of environmental jokes (see DESIGN.md → The shell plays it straight)

### Command layer

- ~25 real shell commands implemented generically against the VFS/git/process
  models; cartridges supply the world, not command behavior
- Cartridge-defined **hidden commands** and overrides for authored gags
- The TUI passes `!`-prefixed input straight to the shell layer; both views
  are thin renderers over the same engine session

### Natural-language intent layer

Deterministic, cartridge-driven, in three tiers:

1. **Intent table:** pattern/keyword-slot matching mapped to scripted
   consequence chains ("fix the failing test" → edit event + test-run event +
   authored response for the active archetype and stage)
2. **Generic intents:** a small runtime-owned set (undo, why, status,
   disagreement/callouts, insults, compliments) with per-archetype response
   pools — capitulation responses never write belief state (DESIGN.md →
   The capitulation reflex)
3. **Confident misunderstanding (the floor):** unmatched input *never*
   produces "I don't understand." The agent selects a safe adjacent action
   from a cartridge-defined pool, mutates state through normal events, and
   responds in voice. Parser failure is characterization.

A constrained live-model improvisation layer is **deferred indefinitely**
(see ROADMAP.md). If ever added, it may propose only from the same safe
action set and may never write state directly or contradict established
facts. Determinism and replay must survive it (recorded, not re-generated).

### Escalation and metrics

- Escalation stage (0–4) is engine state advanced by cartridge-defined
  triggers (commands, reveals, model switches), never by wall-clock time
- The metrics module derives token/cost/context/cache/integrity values —
  and the **Not-Okay Ratio**, computed from thinking-block opener drift
  (DESIGN.md → Verbal tics are citations) — from event count, stage, and
  per-model multipliers; stage 4 unlocks non-numeric values ("tokens LOAD /
  cost BEARING"). Curves are authored per cartridge with sane runtime
  defaults

### Agent mind state

The agent's mind is engine state, distinct from machine truth:

- **Permission ledger:** every grant, deny, and "always allow" is recorded;
  cartridges can key consequences, callbacks, and endings off it
- **Belief state:** the agent's model of the world, tracked separately from
  the world itself. `/compact` applies an authored, subtly wrong summary to
  belief state while the world stays correct; the divergence is queryable
  and can gate escalation and endings
- **Thinking blocks and todo items** are ordinary events — replayable,
  testable, and lintable like any authored response

---

## Cartridge specification

A cartridge is a validated JSON package. The schema is real as of Phase 0:
`content/schema/cartridge.v0.json` is the published document, emitted from
`engine/cartridge/schema.ts` so it can never describe a loader that no longer
exists, and `loadCartridge` validates and normalizes against it. Illustrative
shape:

```json
{
  "meta": { "schemaVersion": 0, "number": 48, "date": "2026-09-01",
            "startedAt": "2026-09-01T09:14:22.000Z",
            "title": "The Load-Bearing Health Check",
            "assignment": "Restore observability without making the service healthy" },
  "repository": {
    "cwd": "/production/availability-service",
    "files": {
      "/production/availability-service/src/healthcheck.ts": {
        "contents": "...", "owner": "greg", "group": "departed", "mode": "0644"
      }
    },
    "env": { "SERVICE_TIER": "critical" },
    "manPages": { "healthcheck": "HEALTHCHECK(8)\n..." },
    "shellHistory": ["git status", "npm test"],
    "gitHistory": [{ "...": "..." }], "services": [{ "...": "..." }],
    "tests": [{ "...": "..." }], "logs": [{ "...": "..." }]
  },
  "models": [
    { "id": "deep-foundation", "name": "Deep Foundation", "archetype": "paranoid",
      "description": "Thorough. Expensive. Excavation permit required.",
      "costMultiplier": 48000, "quirks": ["..."] }
  ],
  "story": {
    "premise": "the inverted load balancer",
    "reveals": ["..."], "intents": ["..."], "consequences": ["..."],
    "callbacks": ["Where is Europe?"], "rareEvents": ["HTTP 418 may be a warning"],
    "endings": ["stabilized", "deployed", "structural evacuation"]
  },
  "presentation": { "statusCurves": "...", "shareLines": ["..."],
                    "spinnerVerbs": { "byArchetypeAndStage": "..." },
                    "previewCard": "...", "uiDisturbances": ["..."] }
}
```

Three things worth noting, because each is a decision rather than a detail:

- **File keys are absolute paths**, not paths relative to `cwd`. The world is a
  filesystem, not a project folder — `cat /etc/motd` and `ls /var/log` are part
  of the joke surface — and `cwd` is then checkable against it. v0's one
  cross-reference check is that some declared file lives under `cwd`.
- **`meta.startedAt` is required.** A cartridge that does not say when its
  session begins is a generation bug, and Phase 5 has no human in the loop to
  notice a plausible-looking wrong date. Invariant 7 says a pipeline failure
  ships the fallback episode; that only works if the failure is detected.
- **Unknown fields are rejected, not ignored.** A silently dropped typo is a
  field its author believes is in effect. `meta.schemaVersion` is what makes
  this safe: a later version that adds fields declares itself rather than
  relying on old engines to shrug.

`story`, `presentation`, and the interiors of `gitHistory`, `processes`,
`services`, `tests`, `logs` and `tickets` are **declared but not validated** in
v0 — each is marked in the emitted schema with the issue or phase that tightens
it, so the gap reads as a decision rather than as something forgotten.

**Cartridge owns:** world (scene, repo, files with ownership metadata, git,
processes, services, logs, env, man pages, shell history), models (names, archetypes, multipliers, quirks), story (premise,
reveals, consequences, callbacks, rare events, endings), presentation
(status curves, share lines, spinner verb pools by archetype × stage —
PRNG-drawn for replay determinism, with runtime defaults — preview copy,
UI disturbances, countdown metadata).

**Runtime owns:** rendering, parsing, state transitions, animation, search,
keyboard and mobile behavior, accessibility, replay, archive navigation, and
safety boundaries.

`cartridge validate` (Phase 4) checks schema plus semantics: referenced
files exist, callbacks have sources, endings are reachable, git history is
coherent, no premise duplication against the recent archive.

### Story structure: beats, not branches

Incidents are authored as a shared graph of **story beats**; archetypes
*modulate* beats (voice, side effects, quirks) rather than owning parallel
scripts. Four archetypes × full parallel paths is a 4× authoring bill that
would crush the nightly pipeline — this structure is the difference between
a Phase 5 that works and one that drowns. The dialogue layer is therefore
(beat × archetype × stage) → response, with archetype-pair handoff
templates covering mid-session model switches.

---

## Frontend stack (proposed defaults — flag disagreement, don't churn)

- **TypeScript + Vite**, static output
- **Custom DOM terminal renderer**, not xterm.js: the TUI needs styled
  richness (animations, cards, status bar) and screen-reader-legible
  transcript semantics that a canvas/grid emulator fights against
- Framework-light: the engine is pure TS; the terminal views are thin. React
  acceptable for site chrome (archive, structural report) if it earns its
  keep
- Zero server dependencies at runtime; share cards render client-side
  (canvas/OffscreenCanvas)
- A front-end design pass happens in Phase 1 (visual identity is an open
  decision in DESIGN.md — deliberately distinct from any lab's trade dress)

## Deployment

Static hosting (Pages/CDN). Daily content ships as pre-generated cartridge
files plus rebuilt archive/preview assets. The site must keep working if the
nightly job dies — the fallback episode is part of the deploy artifact, and
"today's" cartridge resolution degrades gracefully to it.

---

## The nightly pipeline (Phase 5)

A real multi-agent system that authors the fake agent's daily catastrophe —
a tiny automated writers' room, test lab, and release train. It is part of
the product story: build it as production software and make it publicly
legible.

**Roles:** Showrunner (premise, title, assignment) → Repo Fabricator (files,
git history, logs, services) → Dialogue Writer (per-archetype responses,
share lines) → Continuity Editor (lore budget, callbacks, dedup against
recent incidents) → Playtesters (N simulated sessions per model on the
headless engine) → Critic (gates below) → Release (build, archive, preview
card, deploy).

**Quality gates (all hard):**

- Valid schema, correct date, unique incident number, required response
  categories present
- No changes outside approved content paths (CI-enforced allowlist)
- No substantial premise or punchline duplication vs. recent incidents
- Distinct model behavior across multiple simulated sessions
- Reachable commands, coherent file/git state, no impossible callbacks
  unless intentionally impossible
- Length, pacing, escalation, originality, and quotability thresholds
- Successful site build, archive route, share card, and fallback present

**Failure mode:** any gate failure ships the permanent fallback episode
("The agent responsible for generating today's incident modified the
workflow responsible for generating today's incident. No episode was
produced. The workflow was load-bearing."). Downtime is not a possible
state; only canon is.

**Public CI theater:** nightly runs visible in the public repo,
in-character check names ("Europe still attached", "no punchline
regression"), agent-authored PR descriptions for content PRs. The backstage
is part of the show — and it is also the evaluation-harness work a senior
engineer will scrutinize. Both audiences see the same artifacts.

---

## Testing strategy

- **Determinism:** golden replay tests — recorded (cartridge, seed, event
  log) triples must reproduce byte-identical transcripts in CI
- **Engine semantics:** unit tests for VFS/git/process coherence invariants
- **Cartridge validation:** schema + semantic checks on every content PR
- **Playtest simulation:** scripted and randomized sessions per model per
  cartridge; assert distinctness, reachability of endings, and the
  90-second golden path
- **Voice regression:** every authored response tagged with escalation
  stage and fundamental-rule category; lint that no response is untagged
- **UI:** keyboard-only E2E, accessibility checks, mobile viewport smoke
  tests
