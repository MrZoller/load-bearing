# Plan: Phase 1 — one browser terminal, two views, one simulated machine

## Approach

Start with a framework-free TypeScript browser walking skeleton that imports the
existing public engine, owns one append-only visitor event log, and renders
semantic DOM from the resulting `SessionState`; DOM types and browser tooling
remain outside `engine/`, whose independent no-DOM program stays intact. Then
add replayable terminal/agent state and only the narrow Phase 1 cartridge
contract needed by the approved demonstration cartridge, preserving the root
seed across model switches and using dedicated named substreams for model and
spinner choices. Both Bash and TUI dispatch the existing shell path and engine
events rather than maintaining parallel state. Browser behavior is thickened in
focused interaction slices, with Playwright coverage added alongside each
surface and a final pinned-Chromium Lighthouse/keyboard/mobile acceptance gate.
The approved visual baseline is restrained terminal chrome with original
structural/I-beam accents; React, full terminal emulation, Incident #001 content,
and runtime model calls are deliberately excluded.

## Tasks

- [x] T13 (major) — Browser runtime walking skeleton
  - acceptance: `index.html`, `vite.config.ts`, `runtime/session.ts`, `runtime/main.ts`, and terminal styles build a production page that loads a real `content/incidents/phase-1-demo.json` through `loadCartridge`, derives one authoritative state by `appendEvent` + `step`, renders a semantic terminal landmark and engine transcript without direct slice mutation, focuses its prompt, and always shows `loadbearing.cc · Incident #NNN`; pinned Playwright smoke coverage runs the production build; root and engine-only TypeScript programs plus all Phase 0 gates remain green (criteria 1 foundation, 4 foundation, 16, 17)
  - deps: none
  - pr: 37
- [x] T14 (standard) — Replayable terminal mode and active model
  - acceptance: `engine/terminal/` registers a validated plain-JSON slice and events for `tui`/`bash` mode and active-model changes; `engine/commands/terminal.ts` implements `loadbearing --resume` and an authored bare-`exit` refusal; `/exit` and TUI `Ctrl+D` share one mode event; model switches retain the original `SessionState.seed` and isolate model-specific named substreams; unit, snapshot, and golden replay tests cover every transition (criteria 2, 6; approved decision 2A)
  - deps: none
  - pr: 38
- [x] T15 (standard) — Cold open and two-view terminal skeleton
  - acceptance: `runtime/app.ts`, `runtime/views/bash.ts`, `runtime/views/tui.ts`, and the shared terminal renderer visibly present the authored login/prompt and `loadbearing --resume incident-NNN` sequence before a focused `❯` prompt; keyboard-only `/exit` and `Ctrl+D` enter Bash, resume returns to the same engine session, and bare `exit` refuses without ending it; Playwright covers the complete mode round trip with no pointer actions (criteria 1, 2)
  - deps: T13, T14
  - pr: 39
- [R] T16 (major) — Bounded Phase 1 agent and cartridge contract
  - acceptance: `engine/agent/` defines validated, bounded, plain-JSON messages, tool calls, thinking blocks, todos, activity, and authored response records; `engine/cartridge/{schema,types,load}.ts` concretely validates only the Phase 1 `story`/`presentation` subsections needed for opening copy, minimal intents/fallback, help, compact/resume responses, placeholders, spinner pools, and metrics while leaving Phase 2 interiors extensible; the published schema, malformed fixtures, demo cartridge, public exports, docs, and an intentional golden-fixture update remain in lockstep (criteria 5, 7, 9, 11; approved decision 1A)
  - deps: T14
  - pr: 40
- [ ] T17 (standard) — Authored natural-language input and shell passthrough
  - acceptance: `engine/agent/intent.ts` and agent events choose the demo cartridge's minimal authored response/action set for recognized and unmatched natural-language input without apology or parser error; `!command` strips only the prefix and dispatches the same `createShellExecuteEvent` path as Bash, producing identical ordered output and machine effects; TUI rendering and unit/replay/Playwright tests prove both paths (criteria 5)
  - deps: T15, T16
- [ ] T18 (standard) — Shared-machine awareness and compacted beliefs
  - acceptance: generic agent resume logic compares typed mind beliefs with VFS/Git/service truth through `beliefDivergence`, selects cartridge-authored reactions without hardcoded demo paths, and records the response as agent state; deleting the demonstration file in Bash then resuming yields a deterministic in-character acknowledgment, while an authored compact summary replaces beliefs and survives mode changes; a golden replay pins the full behavior (criteria 3, 6)
  - deps: T16, T17
- [ ] T19 (standard) — Pending permissions and keyboard decisions
  - acceptance: `engine/mind/` adds bounded pending-request identity and request/resolve events without breaking existing direct decisions; grant, deny, and always-allow atomically clear the prompt and append the correct simulated-time ledger entry, with standing grants still exact-capability matches; `runtime/components/permission.ts` exposes labeled keyboard controls and restores prompt focus; unit, snapshot, replay, and interaction tests cover all choices (criteria 7)
  - deps: T15, T16
- [ ] T20 (standard) — Replayable tool, thinking, and todo elements
  - acceptance: typed events in `engine/agent/` create and update bounded tool calls, expandable thinking blocks, and todos without storing markup or DOM state; `runtime/components/artifacts.ts` renders each as a distinct semantic element with textual state and keyboard-operable disclosure; replay and interaction tests prove updates survive mode switches and restore from the event log (criteria 7, 13)
  - deps: T15, T16
- [ ] T21 (standard) — Engine-derived metrics and status bar
  - acceptance: `engine/metrics/` derives or records model, token count, cost, context percentage, and structural integrity solely from replay state plus validated cartridge parameters, with explicit bounds and snapshot validation; `runtime/components/status.ts` renders those values and attribution from engine queries rather than DOM counters; unit and replay tests prove model switches and identical logs produce stable values (criteria 8)
  - deps: T14, T16
- [ ] T22 (standard) — Deterministic working verb and suffix channel
  - acceptance: agent activity events select verbs from authored archetype-by-stage pools through a dedicated stable named stream and record the choice; the runtime spinner shows the selected verb plus timer, token count, and Escape guidance while wall time only interpolates presentation; reduced motion exposes the same text without animation, and tests prove unrelated streams, frame timing, and motion preference cannot alter replay state (criteria 9)
  - deps: T16, T21
- [ ] T23 (standard) — Slash commands, autocomplete, and model selector
  - acceptance: one typed slash-command registry implements and accurately describes `/help`, `/model`, `/compact`, `/cost`, and `/exit`; commands dispatch terminal, mind, and agent events or report engine metrics as appropriate; the semantic model selector and slash autocomplete are fully keyboard-operable, model and compact state survive view switches, and focused unit/interaction tests cover discovery, execution, cancellation, and focus restoration (criterion 6)
  - deps: T15, T16, T18, T21
- [ ] T24 (standard) — Terminal histories, completion, and core controls
  - acceptance: `runtime/terminal/{history,completion,input}.ts` provides mode-appropriate TUI and Bash histories, slash/command/path tab completion, arrows, selection-safe copy/paste, `Ctrl+C`, `Ctrl+L`, `Ctrl+D`, and Escape behavior through one input controller; presentation-only clear/cancel operations do not rewrite engine transcript or event log; automated interaction tests cover normal and empty-input cases (criterion 10)
  - deps: T15, T23
- [ ] T25 (standard) — Transcript search, scrollback, and anchoring
  - acceptance: `runtime/terminal/{search,scroll}.ts` provides keyboard transcript search, bounded scrollback, focus restoration, and new-output anchoring that follows only when already at the bottom and preserves the reader's place otherwise; an accessible new-output affordance returns to the latest entry; Playwright covers search navigation, copied text, scrolled-up output, and resumed anchoring (criterion 10)
  - deps: T15
- [ ] T26 (standard) — Diegetic onboarding without shell spoilers
  - acceptance: the demo cartridge authors rotating placeholders, accurate in-character help, autocomplete copy, and one idle nudge; runtime timers may reveal preselected presentation or dispatch the explicit replayable nudge event but never choose content from wall time; interaction tests prove each teaching surface appears, only one idle nudge records, and no tooltip, tutorial overlay/modal, post-cold-open shell hint, or hidden-depth advertisement exists (criterion 11)
  - deps: T16, T17, T23
- [ ] T27 (standard) — Semantic accessibility, reduced motion, and visual baseline
  - acceptance: terminal/components/styles use reading-order semantic DOM, labeled controls, visible focus, textual equivalents, and a dedicated polite live region that announces only new meaningful output; reduced motion preserves every status and cold-open fact; the restrained original terminal treatment uses structural/I-beam accents without lab names, model trademarks, copied colors, or exact trade dress; automated role/name/focus/motion checks cover the stable component surface (criteria 13, 16; approved decision 3A)
  - deps: T15, T19, T20, T21, T22
- [ ] T28 (standard) — Responsive terminal and mobile key strip
  - acceptance: responsive styles and `runtime/components/mobile-keys.ts` keep transcript, prompt, selectors, and permission controls usable at 390×844 with no page-level horizontal overflow; focused-prompt viewport resizing remains usable with a software keyboard; the labeled `/`, `!`, Tab, and arrow keys feed the same input controller as hardware keys; Playwright covers width, focus, long output, and key behavior (criterion 15; approved decision 4A)
  - deps: T24, T25, T27
- [ ] T29 (standard) — Phase 1 deterministic browser acceptance gate
  - acceptance: pinned Playwright Chromium replays one complete keyboard-only session covering cold open, TUI input, permission choice, shell passthrough, Bash mutation, resume reaction, model switch, compact, and exit refusal with visible focus; a Node/browser test canonical-serializes the same cartridge/seed/events to byte-identical state and transcript and proves focus, scroll, viewport, reduced motion, and animation frames do not alter the log; CI runs production build, browser interactions at desktop and 390×844, all Phase 0 verification, and a pinned desktop Lighthouse accessibility audit requiring score 100 with no unlabeled controls or keyboard trap (criteria 4, 12, 14, 15, 17; approved decision 4A)
  - deps: T17, T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28

## Risks

- T13 introduces the first browser/build subsystem and dev-only browser
  dependencies. If DOM libraries leak into `tsconfig.engine.json`, runtime code
  gains a second state store, or a production framework/runtime dependency is
  needed, stop rather than weakening the engine boundary.
- T14, T16, and T21 alter serialized engine/cartridge contracts. Generated
  schema and replay churn is expected only when explained by the new contract;
  unrelated fixture changes or a model switch that changes the root seed are
  determinism blockers.
- T18 must stay generic: if typed divergence cannot express the demonstration
  reaction without a hardcoded file/incident check, stop and revise the
  cartridge contract rather than hiding content in engine or runtime code.
- T19 permission resolution may need to coordinate a machine action with the
  mind ledger. If existing effects cannot make that atomic while preserving
  one-module-one-slice ownership, stop for an orchestration decision.
- T22 and T26 are wall-time traps. Browser timers may schedule presentation,
  but any timer-selected copy, metric, random draw, or unlogged state mutation
  fails the replay contract.
- T27–T29 use automated accessibility evidence, but Lighthouse 100 does not
  prove live-region quality. Any discovered keyboard trap, repeated full-log
  announcement, or information loss under reduced motion blocks completion
  even when the score is green.
- T28's automated 390×844 resize coverage cannot emulate every mobile software
  keyboard. If the visual viewport cannot keep the focused prompt usable, stop
  rather than silently broadening or weakening the approved phone criterion.

## Ad-hoc

- [x] T12 (standard) — parked review minors (batch)
  - acceptance: confirmed non-blocking review findings are collected and fixed as one focused batch with affected-test and repository-gate verification
  - released 2026-08-21 at plan approval (Chris, via operator): planning-skill drain trigger — drains before new Phase 1 feature work
  - PR #33: reject unrenderable shell input before tokenization errors so malformed syntax cannot enter shell history
  - PR #35: make the VFS/Git coverage gate fail when a new runtime production file falls outside its measured inventory, and align its comments and README wording
  - pr: 36

- [!] T30 (trivial) — parked review minors (batch)
  - acceptance: confirmed non-blocking review findings parked during Phase 1 delivery are collected, fixed as one focused batch, and verified by the affected tests and repository gates
  - PR #37: update README Status and root AGENTS.md layout/status copy for the Phase 1 browser runtime (walking skeleton renders; runtime/ and content/incidents/ exist)
  - PR #38: reserve or reject authored overrides for mechanics-owned commands whose static output would suppress replayable effects, beginning with `loadbearing --resume`
  - PR #39: cover terminal-renderer invariant/error paths and settle missing-`/etc/motd` behavior with T16's cartridge opening-copy contract
  - PR #40: require nonempty spinner verbs at the cartridge boundary (schema minLength) so a schema-valid pool cannot produce an empty working-activity verb
