# Load Bearing — Codebase Map

The deep map of the repository, for a day-one agent or engineer. Companion to
`docs/ARCHITECTURE.md` (design intent) and `docs/DESIGN.md` (comedy bible);
this document is *what exists today*, as opposed to what is designed.
`CLAUDE.md` and `AGENTS.md` carry the invariants and verified commands.

Status: **Phase 0 — headless state engine.** The determinism substrate,
event registry, cartridge validation, VFS, Git model, environmental world
state, command sets, test runner, cartridge reactions, and agent mind state are
built; natural-language intent remains. See
[Implementation status vs Phase 0](#implementation-status-vs-phase-0).

---

## The one equation

```
state = reduce(cartridge, seed, eventLog)
```

Everything in this repository is in service of making that equation true and
machine-checked. Three inputs, one output, byte-identical for identical input:

- **cartridge** — a validated JSON world (files, models, story, presentation).
- **seed** — the canonical string `formatSeed({incidentDate, dailySeed, model})`
  from `engine/random/seed.ts`.
- **eventLog** — an append-only list of `EngineEvent`s; every visitor action
  appends one.

`state` is the registered-slice `SessionState`, rendered to `state.json` and `transcript.txt` by the canonical serializer and
compared byte-for-byte against committed golden fixtures.

---

## Directory map

```
.
├── engine/                     THE product today: pure, headless TS
│   ├── index.ts                public entry point (re-exports everything)
│   ├── session.ts              replaySession fold + event vocab (PROVISIONAL)
│   ├── version.ts              ENGINE_VERSION (recorded into fixture state)
│   ├── pattern.ts              immutable RegExp wrapper (closure, no compile)
│   ├── globals.d.ts            the ONE ambient: structuredClone
│   ├── random/
│   │   ├── seed.ts             FNV-1a hash, formatSeed, SeedMaterial
│   │   └── stream.ts           mulberry32 tree of named streams
│   ├── clock/
│   │   ├── clock.ts            simulated clock (startMs + elapsedMs)
│   │   └── civil.ts            hand-written UTC calendar arithmetic
│   ├── events/                  registry, reducer, snapshots, transcript
│   ├── vfs/                     immutable filesystem model + event module
│   ├── git/                     DAG/index/status/blame/diff + event module
│   ├── world/                   processes/services/logs/env/man/history/tickets
│   ├── commands/                tokenizer/options/registry/builtins/shell events
│   ├── tests/                   authored predicates, runner plan + event module
│   ├── mind/                    permission ledger + typed belief divergence
│   ├── reactions.ts             predicates + owner-event action planning
│   ├── cartridge/
│   │   ├── schema.ts           descriptor-tree schema (the single authority)
│   │   ├── load.ts             validate + normalize → LoadedCartridge
│   │   ├── jsonSchema.ts       emits content/schema/cartridge.v0.json
│   │   └── types.ts            hand-written loaded types (compiler-tied)
│   ├── serialize/canonical.ts  the canonical serializer (byte-identity)
│   ├── testing/
│   │   ├── replay.ts           pure fixture shape + replay/compare
│   │   ├── fixtures.ts         disk I/O (only engine file with node:fs)
│   │   ├── diff.ts, text.ts    diff + writable-text validation
│   │   └── README.md           source of truth for fixtures + the gate
│   └── __fixtures__/
│       ├── replay/{001-012}/      fixture.json + state.json + transcript.txt
│       └── cartridges/            focused worlds + invalid/*.json
├── content/schema/cartridge.v0.json  published schema (emitted, contract)
├── scripts/
│   ├── gate-purity.mjs         the purity gate (+ gate-purity.test.mjs)
│   ├── update-fixtures.ts      npm run fixtures:update  (writes)
│   └── update-schema.ts        npm run schema:update    (writes)
├── docs/                       DESIGN.md (comedy), ARCHITECTURE.md (design)
├── .github/workflows/ci.yml    the CI gate
└── runtime/  pipeline/  content/incidents/  content/lore/
        ↑ none exist yet — future phases (1, 5, 2…)
```

---

## Core domain objects

| Object | Where | Role |
|---|---|---|
| `ReplayInput` | `engine/session.ts` | The input triple: `cartridge` (already loaded), `seed` (canonical string), `events`. |
| `ReplayOutput` | `engine/session.ts` | `state` + `transcript` (string[]). |
| `SessionState` | `engine/events/state.ts` | Cartridge, clock/PRNG state, transcript, and namespace-owned subsystem slices. |
| `EngineEvent` | `engine/events/state.ts` | Versionable `{ type, payload, version }` envelope dispatched by exact registered type. |
| `CommandExecution` / `CommandResult` | `engine/commands/types.ts` | Owning events followed by deterministic stdout, stderr, and exit status. |
| `CommandRegistry` | `engine/commands/types.ts` | Duplicate-safe runtime command lookup; cartridge records take explicit precedence at dispatch. |
| `TestRun` / `TestsSlice` | `engine/tests/types.ts` | Authored-duration case results and persistent simulated test history. |
| `CartridgeTest` / `CartridgeReaction` | `engine/cartridge/types.ts` | Typed file predicates and acyclic post-event rules that plan owner events. |
| `LoadedCartridge` | `engine/cartridge/types.ts` | The world after validation/normalization. Plain JSON, deep-copied, serializable. |
| `CartridgeMeta/File/Model/Repository` | `engine/cartridge/types.ts` | Loaded shapes for meta, files, models, repository. |
| `GitSlice` / `VfsSlice` / `WorldSlice` | `engine/git/types.ts`, `engine/vfs/types.ts`, `engine/world/types.ts` | Canonical plain-JSON machine state owned by each event module. |
| `MindSlice` / `Belief` / `ExactCapability` | `engine/mind/types.ts` | Timestamped permission history and the agent's typed, separately serialized model of machine truth. |
| `DeferredObject` | `engine/cartridge/types.ts` | A subtree v0 validates as "an object" but doesn't look inside (`story` and `presentation`). |
| `SimulatedClock` / `ClockState` | `engine/clock/clock.ts` | `now() = startMs + elapsedMs`. Advances only via events. |
| `CivilTime` / `CivilInput` | `engine/clock/civil.ts` | UTC calendar fields; hand-computed (no `Date`/`Intl`). |
| `RandomStream` / `RandomState` | `engine/random/stream.ts` | A named mulberry32 stream in the shared registry. `fork(label)` derives a child from seed+path, not position. |
| `SeedMaterial` | `engine/random/seed.ts` | `{incidentDate, dailySeed, model}` → canonical seed string. |
| `Pattern` | `engine/pattern.ts` | Immutable regex wrapper — only `source` + `test` escape; no `compile`/`lastIndex`. |
| `CartridgeIssue`, `CartridgeValidationError` | `engine/cartridge/load.ts` | All validation errors at once, as data (JSON pointers). |

---

## Data flow

```
cartridge JSON (authored / Phase-5 generated)
        │
        ▼  loadCartridge()  [engine/cartridge/load.ts]
        │   validate against CARTRIDGE_SCHEMA descriptor tree
        │   → all issues at once, JSON pointers, fixed order
        │   → normalize: fill defaults, deep-copy, sort keys
        ▼
   LoadedCartridge (plain JSON, validated, serializable)
        │
        ▼  reduce()  [engine/events/reduce.ts]
        │   bootstrap registered slices + clock + named PRNG streams
        │   fold events: expand envelopes → dispatch owners/effects → transcript
        │   → evaluate authored FIFO reaction cascades against staged state
        ▼
   SessionState + transcript:string[]
        │
        ▼  serialize()  [engine/serialize/canonical.ts]
        │   keys UTF-16-sorted, numbers via Number::toString,
        │   LF, one trailing newline, rejects non-round-trippable values
        ▼
   state.json  +  transcript.txt
        │
        ▼  compareRecording()  [engine/testing/replay.ts]
        byte-for-byte vs the committed golden fixture
```

Loaders feed the replay fixture suite the **same bytes** a session would use:
`fixtures.ts` reads cartridge JSON, hands it to `loadCartridge`, so every
fixture exercises the validator on the way in and records the *normalized*
world.

---

## The determinism contract, in code form

Three modules are the contract, not implementation detail — changing any of
them re-rolls or invalidates every committed fixture, on purpose.

1. **`engine/random/stream.ts`** — mulberry32 (counter-based, fixed constants
   `0x6d2b79f5` etc.). `fork(label)` seeds a child from `hashString(path,
   rootSeed)` — path, not position — so consuming one stream never perturbs
   another. Stream **names** are contract surface: renaming `spinner.verbs`
   re-rolls everything drawn under it. Only drawn-from streams appear in
   serialized `RandomState` (an untouched stream's position is derivable).
   `int()` uses rejection sampling (unbiased, variable draw count but
   deterministic). `weightedPick` is exact integer arithmetic; entry *order*
   is part of the contract.

2. **`engine/clock/civil.ts`** — UTC-only, hand-written Gregorian arithmetic
   (Howard Hinnant's `civil_from_days` era algorithm). No `Date`, no `Intl`,
   so a session renders identically on a laptop in Tokyo and CI in UTC. The
   C-locale `MONTH_NAMES`/`WEEKDAY_NAMES` are the abbreviations simulated
   `git log`/`ls -l` will print (issues #5/#6 must build their formats from
   `CivilTime` + these, not `Date`/`Intl`).

3. **`engine/serialize/canonical.ts`** — byte-identity. Keys in UTF-16
   code-unit order (never insertion order); `-0` → `0`; non-finite and
   non-plain-data values are **rejected loudly** (never coerced like
   `JSON.stringify` does). Brand detection reads internal slots via
   `structuredClone` (the one ambient in `globals.d.ts`), not the prototype
   chain. A hostile `Proxy` is contained by *ordering*, not by a single touch:
   `plainEntries` rejects anything whose `getPrototypeOf` does not report
   `Object.prototype`/`null`, takes the `getOwnPropertyDescriptors` snapshot
   before any brand probing, and only then calls `detectBrand` — whose
   `Object.prototype.toString` and internal-slot probes are further trap
   opportunities. So traps can fire more than once, and the real defense is
   the purity gate's outright ban on `Proxy` inside `engine/`; the ordering
   only ensures a trap cannot answer a question before the check that would
   have rejected it.

Supporting: `engine/pattern.ts` (validators can't be mutated), the purity gate
(`scripts/gate-purity.mjs`, [see below](#the-purity-gate)).

---

## Registered state and cross-slice transactions

`engine/events/modules.ts` is the extension point. A subsystem registers its
namespace, initial slice, snapshot validator, and exact event types; handlers
can return only their namespace's slice. Unknown events and payload-version
mismatches fail rather than becoming no-ops.

Cross-slice mechanics use bounded transactional effects. The outer handler
declares effect events, each is dispatched to its registered owner against the
in-transaction slices, and the reducer publishes only the final state. Effects
cannot emit transcript output or nested effects. Git checkout is the first
consumers: Git owns HEAD/index while VFS owns file replacement; world file logs
read VFS and append through one atomic VFS-owned write effect.

Shell orchestration uses ordered event expansion instead. `shell.execute` is an
unlogged visitor-action envelope; its expander cannot mutate time, randomness,
slices, or transcript, and empty/nested expansion is refused. Generated owning
events plus the final `shell.result` are normal logged entries, so future
filesystem, Git, and world commands retain one-module-one-slice ownership.

Cartridge reactions run only after a logged transition, or a shell expansion's
complete child sequence, is staged. Source trigger types, authored rules and
authored actions form a FIFO cascade; each action is converted by
`engine/reactions.ts` into an unlogged event and dispatched to its registered
owner. Predicates read the latest staged state, event-type cycles are rejected
at load, derived actions cannot move the clock/PRNG or expand again, and a
failure prevents the whole `step` result from being published. Simulated tests
use the same architecture: `npm test` plans output from the current VFS, emits
`tests.run`, and that owner records timing/results while advancing only the
simulated clock.

The `mind` slice is intentionally downstream of machine truth, never coupled to
its mutations. `mind.permission-decision` records exact action/resource grants,
denials, and standing `always-allow` decisions at simulated time;
`mind.belief-set` upserts one typed subject; and `mind.compact` replaces the
whole assertion set while appending timestamped summary history.
`beliefDivergence(state)` walks assertions in stored order and uses only the
closed VFS/Git/service truth queries, so authored wrongness is explicit and no
generic deep-diff contract leaks into later phases.

---

## The purity gate (`scripts/gate-purity.mjs`)

A grep with teeth. Scans non-test sources under `engine/` and fails the build
on ~40 rules enforcing invariants 2, 3, 6: no `Date`, no `Math.random` (and no
aliasing), no `crypto`/`performance`/`process`/`fetch`, no `async`/`Promise`/
`queueMicrotask`, no DOM globals, no Node built-ins, no `eval`/`Function`/
`Proxy`/`globalThis`, no `**`, no escaped identifiers, and so on. Every rule
bans a **whole global**, not a call site (`Date`, not `Date.now()`), because
enumeration misses one member every time. `Math` is inverted: an allowlist of
the exactly-specified members (`floor`, `max`, `imul`, …) — `random` and the
implementation-approximated transcendentals (`sin`/`cos`/`tan`/`pow`/…, which
differ between V8 and JavaScriptCore) are banned.

It **blanks comments, string literal text, and regex literals** before running
— so a doc comment explaining why `Date.now` is banned is fine, and so is the
`"Date:   "` header a simulated `git log` needs. Template *interpolations*
survive blanking (`` `${Date.now()}` `` is caught). Import specifiers are read
from a second strings-intact view.

**`ALLOWLIST`** has exactly two entries, each with a written argument for why:

- `engine/testing/fixtures.ts` — the one legitimate `node:fs` + `import.meta`
  use under `engine/` (test infrastructure, never imported by simulation code).
- `engine/globals.d.ts` — declares `structuredClone` (the only way to reach a
  host global with `lib: ["ES2022"]`, `types: []`).

`APPROVED_PACKAGES` is empty. A rotting allowlist entry fails the gate.

**Consequences you will trip on:** engine code may not name a local
`process` (the simulated process model uses `proc`/`entry`/`row`), may not use
`async`/`await`/`Promise`, may not use `**`, and has no `console`/`URL`/
`TextEncoder` in its type program. A `Date.now()` "just for a duration" is the
exact commit this gate exists to reject.

**Known limits** (documented, accepted): a regex literal right after a keyword
is read as division (assign regexes to constants); a member name assembled at
runtime is out of reach. Threat model is a plausible mistake, not an adversary.

---

## Test strategy

- **Golden replay suite** (`engine/testing/replay.test.ts`): every fixture
  must replay byte-identically; also asserts fresh-module isolation
  (`vi.resetModules()`), input-immutability under deep-freeze, and identity
  preservation. A single changed byte fails with a region diff.
- **Unit tests** colocated per module (`*.test.ts`), asserting *why* the code
  behaves as it does — cross-checks, byte identity, isolation — not just happy
  paths. Notable: `load.test.ts` (77 tests, every `invalid/*.json` fixture
  asserts its full issue list), `schema.test.ts` (published-schema lockstep),
  `stream.test.ts` (36, rejection sampling + weightedPick distributions),
  `civil.test.ts` (timezone guard), `canonical.test.ts` (43).
- **Two timezones**: `npm run test:timezones` runs the whole suite under
  `TZ=UTC` then `TZ=Asia/Tokyo`. A guard in `civil.test.ts` asserts the second
  run really is non-UTC.
- **Purity gate has its own test suite** (`gate-purity.test.mjs`, 70 tests)
  plus deliberately impure samples under `scripts/gate-purity-samples/`.
- **Cross-boundary agreement tests**: schema lockstep (emitted schema vs
  committed file), vitest-globs vs gate `TEST_FILE_PATTERN` agreement, engine
  no-DOM smoke test.
- CI runs typecheck → format → purity → tests in two timezones, on both
  `push` (branch as written) and `pull_request` (the *merge* tree), with
  careful per-event concurrency. CI never re-records.

**The timezone/byte/version matrix is the point.** The whole suite is
structured around "the same input, anywhere, produces the same bytes."

---

## Implementation status vs Phase 0

Phase 0 DoD (from `ROADMAP.md`), mapped to what exists:

| DoD item | Status |
|---|---|
| Engine runs in Node with zero DOM dependencies | ✅ **Done** — `engine/` is pure TS; purity gate + `index.test.ts` enforce no `document`/`window`; zero runtime deps. |
| Replay test: same (cartridge, seed, event log) → byte-identical state/transcript in CI | ✅ **Done** — golden fixtures, byte-identity compare, two timezones. |
| Full unit coverage of filesystem + git semantics | ✅ **Built** — immutable VFS and Git models, cartridge coherence checks, and cross-slice replay fixtures. |
| Cartridge schema validator rejects malformed fixtures with useful errors | ✅ **Done** — descriptor-tree validator and all-issues-at-once JSON pointers, including malformed Git graphs/refs/blame. |

**Explicitly not in this phase** (per ROADMAP) — all correct to be absent:
any rendering, any comedy writing, any real model calls.

**What Phase 0 scope has NOT yet been built** (the gap a day-one agent will
feel): the natural-language intent layer, escalation stage, metrics, and the
Phase 1 todo/thinking-block surfaces. All are designed in
`docs/ARCHITECTURE.md` and land behind later issues.

---

## Extension points

1. **The event registry** (`engine/events/modules.ts`) — add one module and one
   list entry. A cross-slice operation uses transactional effects rather than
   writing another module's slice.
2. **The cartridge schema descriptor tree** (`engine/cartridge/schema.ts`) —
   adding a world concept means adding a descriptor node here; the published
   schema and the loader follow automatically (three-way agreement: validator /
   emitted JSON Schema / hand-written types, one source of truth). Deferred
   sections name who tightens them and when: `story`/`presentation` (Phase 2
   shapes, Phase 4 hardens). Processes, services, logs, tickets, env, man pages,
   history, tests, and reactions are concrete and validated.
3. **New golden fixtures** — every Phase 0 subsystem PR adds at least one
   (`engine/__fixtures__/replay/NNN-…/`). A subsystem with unit tests and no
   fixture is tested against its own idea of correct.
4. **`engine/random/` stream names** — the set of names is contract surface;
   new subsystems `fork("their.domain")` rather than reusing streams.
5. **`engine/clock/`** — which events advance the clock, and by how much,
   belongs to the subsystems that raise them (issue #4 onward). `civil.ts`
   already owns the `git log`/`ls -l` format tables.
6. **Runtime/content boundary** — `scripts/update-schema.ts` is the one script
   permitted to write under `content/`. Phase 5 adds a content-path allowlist
   in CI. Never hardcode an incident into runtime.

---

## External dependencies & integration points

- **Runtime: none.** The engine is zero-dependency by design (purity-gate
  `APPROVED_PACKAGES` is empty). This is a hard invariant, not a happy
  accident.
- **Dev tooling**: TypeScript `^5.7`, Vitest `^3`, Prettier `^3`,
  `vite-node` (runs the `update-*.ts` scripts), `@types/node`. All typecheck
  via the root tsconfig.
- **Node built-ins**: used only in `scripts/*` and the allowlisted
  `engine/testing/fixtures.ts` (`node:fs`, `node:path`, `node:url`).
- **CI**: GitHub Actions (`.github/workflows/ci.yml`), Node 22 from `.nvmrc`.
- **The browser is a *target*, not a dependency**: the engine must run there
  (Phase 1 UI + Phase 5 playtesters) but nothing in the repo touches a DOM
  today.

---

## Where the bodies are buried

- **`engine/session.ts`** — a compatibility facade over the registered reducer;
  subsystem mechanics belong in event modules, never back in a central switch.
- **`engine/version.ts`** — `ENGINE_VERSION` is hardcoded `"0.0.0"` and
  baked into fixture state. Bumping it deliberately invalidates fixtures (as
  recorded `engineVersion` will differ). It is not wired to `package.json`
  version or release tooling; there is none yet.
- **No lint tooling.** There is no ESLint config anywhere. "Lint" is the
  `tsc --noEmit` stage plus the purity gate. Don't add ESLint casually — the
  project deliberately has none.
- **No logging.** The engine has no `console`/`URL`/`TextEncoder`/`TextDecoder`
  types and (mostly) no way to debug-print. Debugging is via fixtures and
  unit tests.
- **`content/` is nearly empty** — just the emitted schema. `content/incidents/`
  (the real cartridges, Phase 2) and `content/lore/` (Phase 2+) don't exist.
- **`.github/PULL_REQUEST_TEMPLATE.md`** requires a `## Verification` section
  with runnable commands and asks for fixture-change justification — the PR
  body is part of the contract.
- **The purity gate has a self-test** (`gate-purity.test.mjs`) and
  `gate-purity-samples/` — the gate's own rules are tested against deliberate
  violations, and the sample dir is excluded from the vitest include.

---

## Risks & oddities (start here if things break)

1. **A "green" engine change can still be a determinism regression** — the
   fixtures only catch what they pin. Fixture `002-random-clock` pins 1000
   raw draws, the `int` rejection window, and the weighted distribution;
   `003` pins normalization alone. A change that moves the PRNG or the
   serializer re-rolls *every* fixture at once — that's the designed signal.
2. **Prettier and the canonical serializer genuinely disagree** (short
   arrays). Generated artifacts are `.prettierignore`'d; running
   `prettier --write` broadly (or `npm run format`) will reformat the fixture
   bytes and turn `format:check` into a fight. Regenerate with the `update`
   scripts instead.
3. **Node version is part of the contract.** CI runs Node 22; a local Node 26
   has masked a real failure before (recursive `JSON.stringify` stack
   overflow). Run tests on Node 22 to be safe.
4. **Two enforcement points must stay in step** — vitest `include` and gate
   `TEST_FILE_PATTERN`. A new test root that isn't named in both silently
   never runs. There's a test asserting agreement.
5. **Strictness is a feature, not a bug**: unknown cartridge fields rejected,
   timestamps fixed-width, deferred subtrees depth-capped at 64, `invalid/`
   fixtures asserting exact issue lists. A validator that rejects "for the
   wrong reason" is considered broken.
6. **`process` is an unusable identifier in engine code** (banned as a whole
   global). Simulated process locals are `proc`/`entry`/`row`.
7. **No asynchrony in the engine** — `async`/`await`/`Promise` are banned.
   The engine's reducer is a synchronous fold by law. Test infra (under
   `engine/`) may be async, but production engine code never is.
8. **Model ids are PRNG seed material** — `checkModelIds` rejects duplicates
   because two models sharing an id is two models sharing a session. Changing
   an id re-rolls every session that used it.
9. **The engine's own program has no DOM/Node/console types** — code that
   typechecks in the root program may fail in `tsconfig.engine.json`. Both
   must pass; this is a common first trip-up.
10. **`EngineEvent.payload` is `Record<string, unknown>`** — callers must
    guard/shape-check at the boundary; the reducer throws helpful errors for
    malformed probe payloads (this is scaffolding; issue #4 replaces it).
