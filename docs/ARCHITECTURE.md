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

### Subsystems register events; nothing edits a central switch

`engine/events/` is the reducer core. Every subsystem below — filesystem, git,
processes, commands, mind state — adds its event types by writing an **event
module** and appending one line to `ENGINE_EVENT_MODULES`
(`engine/events/modules.ts`). Nothing edits the reducer, the transcript
renderer, or a `switch (event.type)`; with ten subsystems, that switch would be
one file every one of them has to touch and none of them can be tested without.

A module declares one `namespace`, and that single word does four jobs:

- **event-type prefix** — a module owns exactly the types under `vfs.*`, so two
  subsystems cannot collide on a name
- **state key** — `SessionState.slices[namespace]` is the only state it can
  write. It reads any other slice through the read-only `context.state`, and
  returns only its own, so a filesystem handler cannot reach git's state even
  by accident
- **PRNG stream** — the reducer hands it `root/<namespace>`, already forked, so
  its draws cannot shift another subsystem's sequence
- the word that appears in errors and in fixture diffs

**Registration order cannot matter**, and that is structural rather than
promised: namespaces are unique so lookup is by exact type, each slice is built
from its own module alone, and bootstrap hands out no clock — the two ways
order could leak in (a shared stream, a shared clock) are unreachable.
`engine/events/registry.test.ts` shuffles the list and asserts the fold is
byte-identical.

One logged event may declare **transactional effects** when a mechanic crosses
slice ownership. The reducer dispatches each effect to the module that owns its
namespace, records no intermediate state, and publishes all resulting slices
only after every effect succeeds. Effects may return only their own slice: no
nested effects and no hidden transcript output. `git.checkout` uses this seam to
ask `vfs.replace-files` to perform the filesystem transition, so Git never edits
VFS entries and VFS never edits refs or the index.

One visitor action may instead be an **unlogged expansion envelope**. Today
`shell.execute` tokenizes and dispatches one input, then expands to any owning-
subsystem events followed by one `shell.result`. The children are ordinary
logged events: each gets its own index, timestamp, transcript entry, clock and
named-stream position. Expansion itself may not change slices, transcript, time,
or randomness; empty and nested expansions are rejected. This keeps command
orchestration out of every owning subsystem without creating a privileged module
that can write all their slices.

After a logged event, or after every child of an expansion has been staged, the
reducer evaluates cartridge **reactions** against that completed state. Trigger
types enter a FIFO queue in source order; matching rules and their actions run
in authored order, and each action's owner event joins the queue tail. Predicates
are re-evaluated before each rule, so an earlier action may deliberately enable
a later one. Reaction-derived events are unlogged and cannot move time or
randomness, but they still dispatch through the service, process, log, or VFS
module that owns the affected slice. The full trigger plus cascade is atomic:
if any action fails, no intermediate state escapes `step`. Cartridge loading
rejects event-type cycles conservatively, so replay work is bounded by authored
acyclic data rather than a runtime iteration limit.

**An unregistered event type is refused, never ignored.** Treating it as a
no-op would let a subsystem missing from the module list produce a session that
looks complete and is missing part of its own history — with the golden fixture
recording the loss as correct. (This is not invariant 7's confident-
misunderstanding rule, which governs a *visitor's* input; an unhandled event
type is a defect in the engine or the log.) Payload schemas version per event
type, on the handler that owns them, so a recorded event written against older
rules fails loudly instead of being reinterpreted.

**The transcript is derived state, not a rendering side effect.** Each logged
event folds one `TranscriptEntry` into `SessionState.transcript` at the same
index; an expansion envelope is not logged, while every child it emits is. The
recorded `transcript.txt` is a pure rendering of those entries. Shell result
entries optionally carry ordered `{stream, text}` output plus an exit code; the
two fields are present together or absent together. A Phase 1 terminal view
renders the same entries differently without changing what was recorded.

### Simulated machine state

- **VFS:** an immutable, flat path-keyed slice that reconstructs a tree with
  contents, permissions, owners/groups, mtimes, and cwd. Ownership metadata is
  a comedy surface (`ls -la` shows owner `greg`, group `departed`); mutations
  persist for the session ("a deleted file stays deleted"). Directory listings
  sort names by numeric Unicode code point, shorter prefix first, with no locale
  collation; this is stable in Node and every browser even for astral characters.
  VFS rename never overwrites an existing destination: it returns `EEXIST`.
  This is a model contract, not an attempt to settle shell UX; a later shell
  layer may choose an explicit replacement policy before issuing its VFS event.
- **Git:** an immutable `engine/git/` slice hydrates the cartridge commit DAG,
  branches, branch or detached HEAD, and index. Forty-hex commit identities are
  derived from canonical commit mechanics (parent hashes, author, message,
  timestamp, and complete file contents), never from authored ids, time, or
  randomness. Log order is topological (every child before every parent), with
  authored timestamp descending then hash ascending as the deterministic tie
  break. Status compares HEAD → index → VFS and distinguishes staged,
  modified/deleted, and untracked paths. Diff is structured line data rather
  than command output; issue #10 owns command rendering. Authored blame has one
  commit id per logical line and load rejects a source that is absent, outside
  the commit's ancestry, never introduced matching text, or merely inherited
  every matching line unchanged. Checkout refuses any dirty repository path,
  including untracked files, then atomically changes HEAD/index and replaces
  tracked VFS files through the VFS-owned effect above. Coherence is a hard
  requirement — the moment `git log` contradicts `git blame`, reaction #3
  ("the state is consistent") dies.
- **Processes and services:** `engine/world/` hydrates cartridge-defined units.
  Zero PIDs and ports are assigned reproducibly from separate `world/pids` and
  `world/ports` streams: explicit values are reserved first, authored entries
  are sorted by stable id before each draw, and a random start plus bounded
  linear probe selects the first free value. Adding a process therefore cannot
  re-roll a service port. Process listings sort by numeric PID then code-point
  id; service and ticket listings sort by code-point id, with no locale
  collation. Service transitions change only running/stopped state; health
  remains cartridge- and reaction-owned.
- **Machine identity and endpoints:** required `repository.system` metadata
  supplies hostname, operating system, kernel release, architecture and boot
  instant. Uptime is the difference between that authored instant and the
  simulated clock. `repository.endpoints` maps exact HTTP(S) URL strings to a
  service plus complete running/unavailable responses; simulated `curl` is a
  pure lookup and has no network fallback.
- **Test runner:** `repository.tests` is an authored ordered list of file
  predicates and integer millisecond durations. `npm test` evaluates every case
  against the current VFS, renders stable PASS/FAIL lines and totals, exits 0
  only when every case passes, records the run in the `tests` slice, and advances
  simulated time by the sum of case durations. Start/finish timestamps, output,
  exit code and run history are therefore derived from cartridge + seed + event
  log; a later VFS edit changes later outcomes without rewriting earlier runs.
- **Logs, env, man pages, shell history, ticket archive:** cartridge-supplied,
  queryable environmental state. Stream log entries live in the world slice;
  file-log contents live only in VFS and append atomically through a VFS-owned
  effect. History remains authored order, oldest first. Man pages use exact
  `(name, section)` identity; name-only lookup chooses code-point section order.
  These are primary carriers of environmental jokes (see DESIGN.md → The shell
  plays it straight).

### Command layer

- `engine/commands/` owns POSIX-ish word tokenization, generic short/long option
  parsing, duplicate-safe command registration, and the one shell execution API
  used by both terminal views
- runtime commands are implemented generically against the VFS/git/process
  models; `pwd`, `echo`, and `true` establish the frame before the remaining
  Phase 0 command sets land
- Git commands render model queries and express every mutation as a versioned
  `git.*` event. Ref abbreviations begin at seven characters and extend until
  unique; dates are UTC in the C locale. Path checkout and restore cross into
  the VFS only through transactional `vfs.replace-files` effects.
- cartridge-defined hidden commands and overrides are static
  `{stdout, stderr, exitCode}` records under `repository.commands`, never
  executable behavior; a cartridge record explicitly wins over a runtime
  builtin with the same name, and its stdout lines precede stderr lines
- unknown names return straight shell-register stderr and exit 127; blank input
  records a successful empty result
- every nonblank raw shell input, including one that fails tokenization, expands
  first to `world.history-append`, then command-owned events, then
  `shell.result`. Output is computed before expansion, so `history` deliberately
  displays prior entries rather than itself.
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
    "identity": { "user": "visitor", "group": "visitor",
                   "home": "/home/visitor", "umask": "0022" },
    "gitIdentity": { "name": "Incident Visitor",
                     "email": "visitor@example.test" },
    "directories": {
      "/production/availability-service": {
        "owner": "greg", "group": "departed", "mode": "0755"
      }
    },
    "files": {
      "/production/availability-service/src/healthcheck.ts": {
        "contents": "...", "owner": "greg", "group": "departed", "mode": "0644"
      }
    },
    "env": { "SERVICE_TIER": "critical" },
    "manPages": [{ "name": "healthcheck", "section": "8",
                   "contents": "HEALTHCHECK(8)\n..." }],
    "shellHistory": ["git status", "npm test"],
    "commands": {
      "load-check": { "stdout": ["beam 4: nominal"],
                      "stderr": [], "exitCode": 0 }
    },
    "gitHistory": {
      "commits": [{ "id": "initial", "parents": [], "author": { "...": "..." },
                    "message": "...", "committedAt": "...",
                    "files": { "/absolute/path": { "contents": "...",
                                                         "blame": ["initial"] } } }],
      "branches": { "main": "initial" },
      "head": { "kind": "branch", "target": "main" }
    }, "services": [{ "...": "..." }],
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
  cross-reference check is that `cwd` is a declared or implied directory.
- **Filesystem identity is explicit.** `repository.identity` is required, with
  `umask` defaulting to `0022`. Optional `repository.directories` supplies the
  owner/group/mode/mtime comedy surface for selected absolute paths; omitted
  ancestors inherit owner/group from their nearest declared ancestor (otherwise
  `root:root`) and default to mode `0755` at `meta.startedAt`. New entries use
  the acting identity and umask. Root alone bypasses permissions.
- **Commit identity is separate world content.** Required
  `repository.gitIdentity` supplies the name and email for visitor-created
  commits; it is never inferred from the POSIX account.
- **`meta.startedAt` is required.** A cartridge that does not say when its
  session begins is a generation bug, and Phase 5 has no human in the loop to
  notice a plausible-looking wrong date. Invariant 7 says a pipeline failure
  ships the fallback episode; that only works if the failure is detected.
- **Unknown fields are rejected, not ignored.** A silently dropped typo is a
  field its author believes is in effect. `meta.schemaVersion` is what makes
  this safe: a later version that adds fields declares itself rather than
  relying on old engines to shrug.

`story`, `presentation`, and the interiors of `tests` are **declared but not
validated** in v0. `gitHistory` and the world surfaces (`processes`, `services`,
`logs`, env, man pages, history, and `tickets`) are concrete and
coherence-validated. Each remaining deferred section is marked in the emitted
schema with the issue or phase that tightens it, so the gap reads as a decision
rather than as something forgotten.

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
