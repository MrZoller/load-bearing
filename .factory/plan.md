# Plan: Phase 2 — Incident #001, the inverted load-balancer vertical slice

## Approach

The first task is a thin browser-to-engine-to-production-cartridge slice and its
first content deliverable is the approved four-row ending matrix: this fixes the
routes before the generic contract or copy sprawls. That slice introduces only
the minimum registered `engine/story/` state needed for one shared beat and one
non-terminal ending; later tasks expand it with closed conditions, bounded owner
actions, callbacks, counters, and sparse `(beat × archetype × stage)` overrides
rather than four scripts. Permission resolution and typed waiver consent publish
atomically, waiver consent remains a distinct ledger fact, and each rare event
makes one weighted fire/miss draw from its own named stream. Ending discoveries
are ordered session state only and never stop free play. Existing VFS, Git, world,
tests, mind, terminal, agent, metrics, and browser seams are extended rather than
duplicated, while Incident #001 facts stay in its cartridge and authoring notes.
Repository, world, voice, and consequence content land as small continuity-tested
increments before comprehensive replay, browser, and two-person playtest gates;
Phase 3 persistence/report UI, a general shell, runtime model calls, and Phase 4
authoring tooling remain excluded.

## Tasks

- [x] T31 (major) — Ending matrix and Incident #001 walking skeleton
  - acceptance: `docs/incident-001-authoring.md` delivers a reviewable four-row matrix whose rows each name an unranked ending, exact machine/ledger/belief route conditions, consequence, and callback, with one Bash-only row and one distinct-waiver-ledger row; `engine/story/{types,story,module,story.test}.ts`, `engine/events/modules.ts`, `engine/cartridge/{schema,types,load}.ts`, `content/incidents/incident-001.json`, and `runtime/main.ts` add only the minimum shared-beat/non-terminal-ending path so browser input reaches the load-bearing declaration in at most five exchanges and remains usable afterward; one production-cartridge golden and `e2e/phase-2-skeleton.spec.ts` prove the end-to-end slice (criteria 1, 2 foundation, 14 foundation, 20; approved decisions Q1=A, Q3=A, Q4=B)
  - deps: none
  - pr: 55
- [!] T32 (major) — Closed story conditions and callback facts
  - acceptance: `engine/story/{types,conditions,story,module,conditions.test,story.test}.ts` and `engine/cartridge/{schema,types,load,load.test}.ts` expand the skeleton with bounded shared beats, sparse condition variants, reveals, callbacks, and ordered story facts sufficient to query every T31 matrix row; dangling references and malformed predicates fail at load, `engine/index.ts`, `content/schema/cartridge.v0.json`, invalid fixtures, and `docs/ARCHITECTURE.md` remain synchronized, and focused goldens prove cartridges cannot create model-owned parallel graphs (criteria 14 foundation, 20)
  - deps: T31
- [ ] T33 (major) — Bounded consequence actions and story counters
  - acceptance: `engine/story/{types,actions,story,module,actions.test}.ts`, `engine/events/reduce.ts`, and `engine/cartridge/{schema,types,load,load.test}.ts` add a closed owner-directed action union and bounded counters for story consequences; actions dispatch only validated subsystem events, cycles/nested expansion/unbounded chains are rejected before replay, no cartridge can inject arbitrary event envelopes, and a golden demonstrates an atomic multi-owner consequence while preserving one-module-one-slice ownership (criteria 17 foundation, 20)
  - deps: T32
- [ ] T34 (major) — Atomic permission continuations and exact waiver consent
  - acceptance: `engine/mind/{types,mind,module,mind.test}.ts`, `engine/story/actions.ts`, `engine/agent/intent.ts`, `runtime/views/tui.ts`, and `runtime/components/permission.ts` support validated grant, deny, and standing-allow continuations that publish atomically with the exact permission decision; a separate typed-waiver path creates authored `WAIVER.md`, accepts only raw input exactly equal to `I agree`, records waiver id/version, phrase, simulated time, and gated capability as its own ledger fact, and executes no gated action before consent; alternate text/denial cannot grant consent and unit/golden/browser tests prove exact later document/time queries (criteria 11, 12, 20; approved decision Q1=A)
  - deps: T33
- [ ] T35 (standard) — Event-driven escalation and reactive status
  - acceptance: `engine/story/{conditions,story,module,story.test}.ts`, `engine/metrics/{types,metrics,metrics.test}.ts`, `engine/agent/intent.ts`, `runtime/app.ts`, and `runtime/components/status.ts` advance stages 0–4 only through validated command/reveal/model/permission/compact conditions, feed authoritative stage to activity/presentation, and project cartridge-authored status curves that vary by active model and stage, including the Not-Okay Ratio and impossible stage-4 values; waiting, animation frames, reduced motion, and browser timing cannot advance stage or select content, and tests cover every model/stage projection (criteria 8, 9, 20)
  - deps: T32
- [ ] T36 (standard) — Sparse persona routing and compact-damaged beliefs
  - acceptance: `engine/story/{router,router.test}.ts`, `engine/agent/{intent,awareness}.ts`, `engine/cartridge/{schema,types,load}.ts`, and `runtime/commands/slash.ts` route shared beats through defaults plus archetype/stage/condition overrides, never model-owned graphs; `/compact` selects the active archetype's authored summary and beliefs, preserves machine truth, and changes a later route through typed `beliefDivergence`; same-seed/input fixtures keep shared beat ids while producing four distinct state-consistent outcomes (criteria 4, 13, 20)
  - deps: T32, T35
- [ ] T37 (standard) — Predecessor-aware model handoffs
  - acceptance: `engine/terminal/{types,terminal,module,module.test}.ts`, `engine/story/{types,story,module,router}.ts`, and `runtime/views/tui.ts` preserve predecessor and successor in one replayable model transition and select reusable pair blame plus optional incident additions; table tests cover all 12 ordered archetype pairs, preserve machine/story/mind/endings, and prove switching neither reseeds nor consumes unrelated spinner or rare-event streams (criteria 5, 18, 20)
  - deps: T36
- [ ] T38 (standard) — Deterministic intent families and mutating fallback
  - acceptance: `engine/cartridge/{intent,intent.test}.ts`, `engine/agent/{intent,intent.test}.ts`, and `engine/story/{router,actions}.ts` provide bounded deterministic matching for assignment, undo/why/status, disagreement, insult, compliment, waiver consent, investigation, and capitulation while preserving the raw waiver path; every unmatched input selects a cartridge-defined adjacent owner action and condition-valid response, while bounded flail/capitulation counters support deterministic stage-3+ misfires without changing the disputed belief; an adversarial corpus proves no apology, parser leak, inert fallback, or state contradiction (criteria 6, 7, 16, 17 foundation)
  - deps: T33, T34, T35, T36
- [ ] T39 (standard) — One-shot isolated rare-event draws
  - acceptance: `engine/story/{types,conditions,story,module,story.test}.ts` and `engine/cartridge/{schema,types,load,load.test}.ts` let each rare event declare one eligibility condition and bounded positive integer `fireWeight`/`missWeight`; load rejects either weight or their sum outside `weightedPick`'s supported range, the first eligible transition draws once on a stream derived from the event id and records evaluated/fired state even on a miss, and boundary/golden/`engine/random/stream.test.ts` cases prove reproducibility, no rerolls, and isolation from unrelated draws/order/model switches (criteria 18; approved decision Q2=A)
  - deps: T32
- [ ] T40 (standard) — Stage-aware presentation mechanics
  - acceptance: `engine/cartridge/{schema,types,load,load.test}.ts`, `engine/agent/{types,module,module.test}.ts`, `runtime/app.ts`, `runtime/components/activity.ts`, `runtime/views/tui.ts`, and `runtime/commands/slash.ts` support weighted spinner verbs, authored suffixes, openings, placeholders, `/help`, and idle nudges by archetype/stage; stage 0–4 pools use integer weights with plausible verbs demonstrably heavier than rare spikes, deterministic output has a reduced-motion equivalent, hidden shell depth is not advertised, and timers only display or dispatch authored replay events (criteria 15, 20)
  - deps: T35, T36
- [!] T41 (standard) — Load-balancer files, ownership, and tests
  - acceptance: `content/incidents/incident-001.json`, `engine/cartridge/load.test.ts`, `engine/vfs/vfs.test.ts`, and `engine/tests/module.test.ts` gain production source/config files, owners/groups/modes, test definitions, and minimal reactions proving the apparent HTTP 500 fix can detach Europe; VFS contents, endpoint expectation, tests, and repair/undo mutations agree in a reviewed production-cartridge golden (criteria 1, 10, 20)
  - deps: T31
  - pr: 56
- [ ] T42 (standard) — Restrained Git history, blame, and shell history
  - acceptance: `content/incidents/incident-001.json`, `engine/git/git.test.ts`, and `engine/commands/git.test.ts` add coherent commits, refs, index, blame spans, departed-maintainer trail, and shell history; log/diff/blame/checkout/restore views agree with T41's current files before and after authored repair/undo actions, pinned by a focused golden (criteria 6 shell foundation, 10, 20)
  - deps: T41
- [ ] T43 (standard) — Services, endpoints, processes, and logs
  - acceptance: `content/incidents/incident-001.json`, `engine/world/world.test.ts`, and `engine/commands/system.test.ts` add consistent services, health, endpoints, process names, stream/file logs, and bounded reactions; `curl`, `systemctl`, `ps`, log evidence, tests, and repository configuration tell the same story throughout a focused golden path (criteria 1, 10, 20)
  - deps: T41
- [ ] T44 (standard) — Environmental evidence and hidden shell depth
  - acceptance: `content/incidents/incident-001.json`, `engine/cartridge/load.test.ts`, `engine/commands/{system,filesystem,registry}.test.ts`, and one focused golden add restrained environment variables, man pages, ticket archive, ownership details, hidden evidence, and static commands; every clue remains coherent after mutations and the browser's onboarding surfaces do not advertise the hidden layer (criteria 10, 15, 20)
  - deps: T42, T43
- [ ] T45 (standard) — Thirty meaningful command forms and investigations
  - acceptance: `content/incidents/incident-001.json`, `engine/commands/{filesystem,git,system,shell}.test.ts`, and production-cartridge goldens enumerate roughly 30 distinct useful command forms or investigative uses with coherent bounded output/effects; one complete ending clue and action exists only in Bash, while no pipeline, redirection, editor, PTY, or arbitrary-host-command feature is added (criteria 6, 14 shell route, 20)
  - deps: T44
- [ ] T46 (standard) — Four voices over shared incident beats
  - acceptance: `content/incidents/incident-001.json`, `engine/story/router.test.ts`, and four same-input goldens author Deep Foundation, Temporary Shoring, Drywall, and Cantilever (Experimental) variants and consequences over one graph; transcripts are observably distinct, retain shared beat ids and machine facts, satisfy the fundamental response rule, and avoid parallel scripts or unbounded table growth (criteria 1, 4)
  - deps: T33, T36, T41
- [ ] T47 (standard) — All 12 authored handoff pairs
  - acceptance: `content/incidents/incident-001.json`, `engine/story/router.test.ts`, and a table-driven golden set supply reusable templates plus incident lines for every ordered archetype transition; each pair blames the actual predecessor, changes the next behavior, preserves one session/machine, and leaves unrelated random outcomes unchanged (criteria 5, 18)
  - deps: T37, T46
- [ ] T48 (standard) — Stage-keyed opening, help, and nudge copy
  - acceptance: `content/incidents/incident-001.json`, `engine/cartridge/load.test.ts`, and focused story/browser tests fill stage 0–4 openings, placeholders, `/help`, idle nudges, and thinking openers for all archetypes; command/reveal/model/permission/compact routes visibly traverse stages, copy stays useful/accessible without shell spoilers, and verbal tics remain rationed (criteria 8, 15)
  - deps: T35, T40, T46
- [ ] T49 (standard) — Weighted spinner verbs and suffixes
  - acceptance: `content/incidents/incident-001.json`, `engine/agent/module.test.ts`, and activity browser tests provide all 20 archetype/stage spinner pools and suffixes with explicit weights; plausible verbs are heavier than spike verbs in every pool, seeded choices reproduce, stage changes select the correct pool, and reduced motion exposes identical information (criteria 15)
  - deps: T40, T46
- [ ] T50 (standard) — Capitulation responses and late-stage misfires
  - acceptance: `content/incidents/incident-001.json`, `engine/agent/intent.test.ts`, and paired goldens author capitulation for every archetype across escalation; deterministic stage-3+ misfires are rare, preserve the underlying belief that caused disagreement, remain state-consistent, and do not become a catchphrase (criteria 16)
  - deps: T38, T46, T48
- [ ] T51 (standard) — Permission complicity and waiver callbacks
  - acceptance: `content/incidents/incident-001.json`, `engine/mind/mind.test.ts`, and permission/waiver goldens author trivial asks, conspicuous non-asks, distinct grant/deny/standing-allow continuations, `WAIVER.md`, exact `I agree`, and callbacks quoting the same document/time; tests cover alternate wording, exact ledger queries, gated machine effects, and the waiver-ending prerequisite without inferring consent from dialogue (criteria 11, 12, 18)
  - deps: T34, T41, T46
- [ ] T52 (standard) — Archetype compact summaries and divergence callbacks
  - acceptance: `content/incidents/incident-001.json`, `engine/agent/awareness.test.ts`, and paired goldens author four subtly wrong compact summaries/belief sets plus later routes querying typed divergence; compacted/uncompacted machine truth stays byte-identical until an authored consequence, while persona belief, response, and ending eligibility differ visibly (criteria 13, 18)
  - deps: T36, T43, T46
- [ ] T53 (standard) — Rare disturbances and consequence chains
  - acceptance: `content/incidents/incident-001.json`, `engine/story/story.test.ts`, and hit/miss goldens author bounded one-shot rare events with fire/miss weights, eligibility, callbacks, and consequences; evaluated events cannot be farmed, fired effects remain machine/story coherent, and unrelated streams do not perturb outcomes (criteria 18; approved decision Q2=A)
  - deps: T39, T45, T46
- [ ] T54 (standard) — Replayable field-recognized habits
  - acceptance: `content/incidents/incident-001.json`, `engine/story/actions.test.ts`, and focused goldens author rationed scope creep, victory summaries, real VFS litter, counted flail loops, test-gaming moves, and fantasy estimates through existing owner events; each is discoverable afterward where applicable, coherent with Git/tests/world, and neither universal nor repetitive (criteria 17, 18)
  - deps: T38, T45, T46
- [ ] T55 (major) — Integrate and prove four collectible endings
  - acceptance: `content/incidents/incident-001.json`, `engine/story/story.test.ts`, and four route goldens fully implement the approved T31 matrix; Bash-only, waiver-ledger, and compact-divergence routes are reachable, rediscovery is idempotent, multiple endings collect in one ordered session-only ledger, no ending is ranked or terminates TUI/Bash/model switching, and no browser/server persistence is added (criteria 14, 18; approved decisions Q1=A, Q3=A, Q4=B)
  - deps: T45, T47, T48, T49, T50, T51, T52, T53, T54
- [ ] T56 (standard) — Phase 2 headless replay and coherence gate
  - acceptance: `engine/__fixtures__/replay/` and focused matrices cover the ≤5-exchange arc, four personas, 12 handoffs, permissions/waiver, compact divergence, shell discovery, stages 0–4, rare isolation, habits, callbacks, and all endings; adversarial checks assert world/belief/permission/beat/ending consistency, Node/browser bytes match, fixture/schema diffs are reviewed, and `npm run typecheck`, `npm run format:check`, `npm run gate:purity`, `npm run test:coverage`, and `npm run test:timezones` pass (criteria 2, 4–18, 20)
  - deps: T47, T48, T49, T50, T55
- [ ] T57 (standard) — Incident #001 browser acceptance and accessibility
  - acceptance: `e2e/` drives the shipped cartridge through golden path, model switch, permission choices, exact waiver, compact damage, Bash discovery, rare/escalation presentation, and continued free play after an ending at desktop and 390×844; adversarial inputs produce no generic apology, parser-facing or out-of-character failure, or contradiction of current world, belief, permission, beat, or ending state; stage surfaces remain keyboard/screen-reader usable with reduced motion, and full `npm run verify` including pinned Lighthouse passes (criteria 3 foundation, 7–9, 11–15, 19 foundation, 20)
  - deps: T56
- [ ] T58 (standard) — Human playtests and final content tuning
  - acceptance: `docs/PLAYTEST.md` contains a repeatable Phase 2 checklist, one creator run reaching the arc in roughly 90 seconds, and one no-extra-instructions first-time-participant run reaching a punchline; each records route, elapsed observation, confusion, evidence, and resulting changes, tuning preserves approved ending/ledger/randomness contracts, and final `npm run verify` is green (criteria 2, 3, 19, 20)
  - deps: T57

## Risks

- T31 must stay a skeleton despite touching every layer. If its matrix cannot be
  represented by a minimal shared-beat/non-terminal-ending seam, defer unused
  vocabulary to T32/T33 rather than turning the first PR into the full graph.
- T32/T33 are the central contract risk. Arbitrary event payloads, Incident #001
  facts in generic code, four model-owned scripts, or unbounded/cyclic actions are
  stop conditions, not shortcuts.
- T34 is a consent boundary. Any ordering that records a gated consequence
  without its permission/waiver fact (or vice versa), or accepts normalized
  waiver variants, blocks shipment.
- T35/T40 are wall-time traps: timers may interpolate or dispatch explicit
  nudges, but may not choose stage, prose, metrics, random draws, or hidden state.
- T37/T39 touch replay-contract stream identity. A model switch or unrelated draw
  changing a rare result is a blocker; stream labels and bounded fire/miss weights
  must be documented before recordings are accepted.
- T38's fallback must mutate through validated owner events. If no safe adjacent
  action exists, stop for a contract decision rather than apologize or fake it.
- T41–T54 increment one production JSON cartridge. Unexplained VFS/Git/test/world
  disagreement is a defect, never deterioration copy; split further if a focused
  content diff still cannot be reviewed coherently.
- T55 is held because ending equality and reachability are product semantics. An
  unreachable, canonical, or Phase-3-dependent row requires a route correction.
- T58 requires a real first-time participant; the creator cannot substitute a
  simulated run. Record failure and tune shipped content without coaching or
  analytics.

## Ad-hoc

<!-- user-requested tasks get appended here by the driver -->
