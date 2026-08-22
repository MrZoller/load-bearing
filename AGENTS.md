# Load Bearing

A daily interactive comedy presented as a polished browser-based coding
environment: visitors investigate a fictional production incident inside a
coding-agent TUI where everything is load-bearing and the agent deteriorates.
The terminal is real; the computer is lying. The product is deterministic —
`state = reduce(cartridge, seed, eventLog)` — and today Phase 1 is building a
browser terminal over the completed headless engine. The engine remains pure
TypeScript with zero DOM/runtime dependencies and runs identically in Node and
the browser; DOM mechanics live under `runtime/`.

Read before working: `CLAUDE.md` (the invariants and working agreements —
authoritative, do not edit casually), `ROADMAP.md` (phase order + definitions
of done), `docs/DESIGN.md` (experience + comedy bible), `docs/ARCHITECTURE.md`
(engine, cartridge spec, pipeline), `engine/testing/README.md` (the
determinism harness).

## Commands

All verified on Node 22.19+/npm 11 (`npm run verify`, green on this machine):

- setup: `npm install && npx playwright install chromium` (CI uses `npm ci`
  and installs Chromium with its system dependencies; `package-lock.json` is
  committed)
- test: `npm test` — Vitest unit + golden replay suite
- test both host timezones: `npm run test:timezones` (CI runs this: UTC then
  Asia/Tokyo — the engine must not read a host timezone)
- typecheck: `npm run typecheck` — `tsc --noEmit` on the **whole repo** *and*
  `tsc -p tsconfig.engine.json --noEmit` (the engine's own program, no Node
  globals). Both are required.
- format: `npm run format` (fix) / `npm run format:check` (CI gate) — Prettier.
  Prose under `docs/`, `CLAUDE.md`, `ROADMAP.md`, and the canonical-generated
  artifacts are `.prettierignore`'d on purpose.
- purity gate: `npm run gate:purity` — scans `engine/` non-test sources;
  machine-enforces invariants 2, 3, 6 (no wall-clock time, no unseeded
  randomness, no DOM, no Node built-ins, no network, no async, no `**`, no
  `process`/`Date`/`Math.random`/`eval`/`Proxy`/…). A commit that needs to
  "just add one `Date.now()`" in the engine is rejected here.
- full CI gate (all of the above in CI's order): `npm run verify` — read-only.
- **regenerate** golden replay fixtures (deliberate; writes files):
  `npm run fixtures:update [fixture-name]`
- **regenerate** published schema `content/schema/cartridge.v0.json`
  (deliberate; writes under `content/`): `npm run schema:update`

Commands I read but did **not** run (all write to the tree): `fixtures:update`,
`schema:update`, `format` (fix form), `test:watch`.

## Stack & layout

- TypeScript `^5.7` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules`, `verbatimModuleSyntax`), ESM (`"type": "module"`), Node
  `>=22.19` (`.nvmrc` = 22.19). Dev deps only: `vitest`, `prettier`, `vite-node`,
  `@types/node`. **The engine has zero runtime dependencies and must keep it
  that way** — `APPROVED_PACKAGES` in the purity gate is empty and approving a
  package means manually asserting it reads no clock, draws no randomness,
  touches no network.
- `engine/` — the simulation engine: pure, headless, browser + Node. Also the
  only place the determinism contract lives.
  - `session.ts` — the fold `replaySession(cartridge, seed, events)` and the
    event vocabulary. **PROVISIONAL**: the reducer is scaffolding that proves
    the replay loop; issue #4 replaces it with a real event registry.
  - `random/` — mulberry32 PRNG as a tree of **named streams** (`fork("label")`
    derives a child from the root seed + path, never from the parent's
    position). `seed.ts` = seed derivation `(incidentDate, dailySeed, model)`;
    `stream.ts` = the generator.
  - `clock/` — simulated clock (`startMs + elapsedMs`, advanced only by
    events) and hand-written UTC civil arithmetic (`civil.ts`). No `Date`, no
    `Intl`.
  - `cartridge/` — the cartridge spec: descriptor-tree schema (`schema.ts`),
    the published JSON Schema emitter (`jsonSchema.ts`), the validate +
    normalize loader (`load.ts`), the loaded types (`types.ts`).
  - `agent/` — bounded replayable messages, authored response instances, tool
    calls, thinking blocks, todos, and activity.
  - `serialize/canonical.ts` — the canonical serializer; byte-identity for
    fixtures. Rejects anything that can't round-trip deterministically.
  - `testing/` — the determinism harness: `replay.ts` (pure) + `fixtures.ts`
    (the one engine file allowed `node:fs`, purity-gate allowlisted).
    `testing/README.md` is the source of truth for fixtures and the gate.
  - `pattern.ts` — immutable regex wrappers (freezing a `RegExp` doesn't stop
    `compile`; a closure does).
  - `version.ts` — `ENGINE_VERSION`; recorded into fixture state.
- `runtime/` — browser session, cold-open transcript, and Bash/TUI views. It
  renders engine state and owns DOM-only focus/presentation behavior.
- `content/schema/cartridge.v0.json` — the published, committed cartridge
  schema, emitted from `engine/cartridge/schema.ts`. `schema.test.ts` fails if
  it drifts. `content/incidents/phase-1-demo.json` is the non-#001 browser demo.
- `docs/` — `DESIGN.md` (comedy bible), `ARCHITECTURE.md` (engine/cartridge/
  pipeline), and now `codebase-map.md` (this architecture map).
- `scripts/` — `gate-purity.mjs` (the gate + its own test suite
  `gate-purity.test.mjs` + `gate-purity-samples/`), `update-fixtures.ts`,
  `update-schema.ts`.
- `.github/workflows/ci.yml` — CI gate: typecheck → format → purity → tests in
  two timezones. Reads `.nvmrc`, not a pinned version.
- Not yet present (future phases): `pipeline/` and `content/lore/`.

## Conventions

- **The invariants are laws, not style.** `CLAUDE.md` lists eight; the ones
  that change *how you code* every day:
  - **Determinism** (invariant 2): all randomness through the seeded PRNG's
    named streams, all time simulated. `state = reduce(cartridge, seed,
    eventLog)`; no `Math.random()`, no `Date.now()` in the engine. Machine-
    enforced by the purity gate.
  - **Runtime/content separation** (invariant 1): runtime owns mechanics,
    cartridges own worlds. If a cartridge needs a runtime change, fix the
    cartridge *spec* first, then the runtime — never hardcode an incident.
  - **Headless** (invariant 3): no DOM in `engine/`. The Phase 5 playtester
    agents drive this same engine in CI.
  - **No runtime model calls** (invariant 6), **no lab trademarks** (invariant
    5), **failure is content, never apology** (invariant 7).
- **Golden replay fixtures are contracts.** `engine/__fixtures__/replay/*` is
  compared byte-for-byte; a recording that changes without justification in
  the PR is a determinism regression waved through. Re-record only on purpose
  with `npm run fixtures:update`, and read the diff. Every Phase 0 subsystem
  PR adds at least one fixture.
- **`vitest.config.ts` globs and the purity gate's `TEST_FILE_PATTERN` must
  stay in step** — a test asserts the two agree, and the vitest `include` is
  explicit (every future source root must be added or its tests silently never
  run).
- Test idiom: `describe`/`expect`/`it` from Vitest, one `*.test.ts` per module,
  colocated. Tests assert *why* the code must behave as it does (isolation,
  byte identity, cross-checks), not just happy paths. `engine/testing/`
  fixtures are read through the same bytes a replay would use.
- Conventional commits with a `scope` (`feat(engine):`, `fix(cartridge):`).
  In-character commit messages are permitted for content under `content/`
  only.
- **Comments carry the reasoning.** This repo documents *why* extensively in
  inline comments (determinism decisions, gate-rule rationales, schema-deferred
  gaps). A change that makes a documented invariant wrong must update the
  comment. Preserve this voice.
- Branch-first, never edit committed files on a default branch; small,
  reviewable commits.

## Factory

This repo is being onboarded onto the software-factory line by this commit.
Once onboarded, durable task state lives in `.factory/` (spec, plan, worklog,
questions); agents load the `factory-protocol` skill before factory work.

## Gotchas

- **`engine/session.ts` is a compatibility facade.** Subsystem mechanics and
  event vocabulary belong in registered modules, not a central switch.
- **The purity gate bans `async`/`await`/`Promise`, `**` and `**=`, `process`
  (the whole identifier — name simulated process locals `proc`/`entry`/`row`,
  not `process`), `Date`, `Math.random`, `eval`, `Proxy`, `globalThis`,
  `structuredClone` (except `globals.d.ts`), `TextEncoder`, and more, *inside
  the engine*. Test files under `engine/` are exempt from scanning but must
  not be imported by production code. The engine tsconfig has no `console`,
  `URL`, or DOM libs either — nothing to log with and no browser types.
- **The engine's two enforcement points must move together.** `vitest.config.ts`
  `include`/`exclude` and `scripts/gate-purity.mjs` (`TEST_FILE_PATTERN`,
  `ALLOWLIST`) describe the same boundary. Adding to `ALLOWLIST` is a design
  decision worth arguing about; a rotting allowlist entry fails the gate.
- **Canonical bytes vs Prettier bytes disagree on short arrays.** The replay
  `state.json`/`transcript.txt` and the published schema are generated with
  the canonical serializer and `.prettierignore`'d; regenerate them with the
  `update` scripts, never hand-edit or re-format them. `.gitattributes` pins
  LF everywhere so checkouts can't rewrite recorded byte identity.
- **Node version skew.** CI reads `.nvmrc` (22.19); a local Node 26 can mask
  failures (a test overflowed the stack on Node 22 but passed on 26 — V8 made
  `JSON.stringify` non-recursive). Use `nvm use`/Node 22.19 to match CI.
- **`meta.startedAt` and all timestamps are fixed-width `…mmmZ` UTC.** A
  cartridge declaring another spelling is rejected, because replay state embeds
  the loaded cartridge and two spellings of one instant would produce
  different `state.json` bytes.
- **Strict everywhere:** unknown cartridge fields are rejected (not ignored);
  Phase 1 `story`/`presentation` shells and repository interiors are concrete
  and bounded. Only the explicitly named `phase2` interiors remain deferred,
  with a 64-level nesting cap and future owner in the schema.
- **No lint tooling.** There is no ESLint. The closest to lint is the
  `tsc --noEmit` stage of typecheck plus the purity gate. `docs/` prose is
  hand-formatted and prettier-skipped — don't let Prettier churn it.
