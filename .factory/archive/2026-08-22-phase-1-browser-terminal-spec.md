# Spec: Phase 1 — one browser terminal, two views, one simulated machine

## Problem

Phase 0 provides a deterministic, coherent simulated machine, but visitors
cannot experience it: there is no browser runtime, terminal rendering, agent
surface, or way to enter the Bash layer. The product's central realization —
that the coding-agent parody sits on top of a real, shared fictional computer —
does not yet exist outside headless replays.

## Outcome

Visitors can complete a polished browser session through an agent-style TUI or
a simulated Bash shell. Both views operate one replayable Phase 0 session, so a
change made in either view remains true in the other. The experience teaches
its surface diegetically, works end to end by keyboard, is legible to assistive
technology, and remains usable on a phone.

## Scope

### In

- A custom semantic-DOM terminal renderer with authentic focus, cursor,
  scrolling, scrollback, copy/paste, transcript search, and responsive layout.
- A cold open that boots into Bash, shows the login/prompt and
  `loadbearing --resume incident-NNN`, then enters the agent TUI.
- An agent TUI with a `❯` natural-language prompt, `!` shell passthrough,
  `/help`, `/model`, `/compact`, `/cost`, and `/exit`, plus slash autocomplete
  and a model selector.
- A simulated Bash view over the existing shell command layer, with command
  history, tab completion, `Ctrl+C`, `Ctrl+L`, and mode changes through
  `/exit`, `Ctrl+D`, and `loadbearing --resume`; bare Bash `exit` refuses in
  character.
- Engine-backed TUI state for messages, tool calls, expandable thinking,
  todos, pending permission prompts and decisions, active mode/model, and the
  agent's reaction to machine changes made while it was absent.
- Engine-derived status values for model, tokens, cost, context percentage,
  and structural integrity, plus a deterministic archetype-by-stage working
  spinner and its timer/token/Escape-hint suffix.
- Diegetic onboarding through authored rotating placeholders, an accurate
  in-character `/help`, an idle nudge, autocomplete, and mobile terminal keys;
  no overlays, tutorials, tooltips, or hints that advertise the shell layer.
- Visible `loadbearing.cc · Incident #NNN` attribution, an original
  lab-agnostic visual treatment, reduced-motion behavior, and a semantic
  screen-reader transcript.
- The smallest generic engine and cartridge-contract additions needed to make
  those mechanics deterministic and content-driven while preserving the
  existing headless API and golden replay contracts.

### Out

- Incident #001, its 90-second arc, endings, four complete personas, authored
  intent table, escalation story, and deep comedy content — Phase 2.
- A production-grade confident-misunderstanding catalog; Phase 1 includes only
  enough authored demonstration content to prevent an out-of-character input
  path, subject to Open question 1.
- Daily brief/countdown/archive chrome, replay URLs, resolution reports, share
  cards, and `/share` — Phase 3.
- Full terminal emulation, PTYs, arbitrary host commands, networking, or an
  xterm-compatible escape-sequence surface — never required for this product.
- Runtime model/API calls, accounts, server-side session state, or other
  backend infrastructure — prohibited or unnecessary.
- Automated incident generation, playtester agents, and production deployment
  infrastructure — later phases.

## Acceptance criteria

1. Loading the terminal page shows the authored shell login banner and prompt,
   visibly runs `loadbearing --resume incident-NNN`, and enters a focused TUI
   without requiring pointer input.
2. `/exit` and `Ctrl+D` move from TUI to Bash; `loadbearing --resume` returns to
   the same TUI session; bare Bash `exit` prints an in-character refusal and
   leaves the experience running.
3. Deleting a file in Bash changes the shared engine state, and resuming the TUI
   produces a deterministic, in-character response that reflects that deletion
   rather than stale agent knowledge.
4. Replaying the same cartridge, seed, and visitor-event log produces
   byte-identical authoritative state and transcript in Node and the browser;
   UI animation frames, focus, and scroll position do not affect the replay.
5. The `❯` prompt accepts natural-language input without a generic apology or
   parser error, and `!command` uses the same shell execution path and output as
   entering that command in Bash.
6. `/help`, `/model`, `/compact`, `/cost`, and `/exit` are keyboard-operable,
   accurately described in autocomplete/help, and mutate or report engine state
   as appropriate; model changes and compacted beliefs survive view switches.
7. Tool calls, thinking blocks, todos, and permission prompts render as distinct
   TUI elements backed by replayable engine state; granting, denying, and
   always-allowing a prompt records the correct permission-ledger decision.
8. The status bar's model, token, cost, context, and structural-integrity values
   come from engine metrics and remain replay-stable; no displayed narrative
   metric is maintained only as a DOM counter.
9. Working verbs are selected from authored archetype-by-stage pools through a
   dedicated seeded stream. The suffix exposes timer, token count, and Escape
   guidance, while reduced motion presents the same information without
   animation.
10. TUI and Bash each provide appropriate history and tab completion;
    `Ctrl+C`, `Ctrl+L`, copy/paste, transcript search, focus restoration,
    scrollback, and new-output scroll anchoring have automated interaction
    coverage.
11. Rotating placeholders, `/help`, slash autocomplete, and one idle nudge
    teach the visible surface in character. No tooltip, tutorial overlay/modal,
    or post-cold-open shell hint appears.
12. A complete session — cold open, TUI input, permission choice, shell
    passthrough, Bash switch, machine mutation, resume, model switch, compact,
    and exit refusal — is possible using only the keyboard with visible focus.
13. The transcript uses semantic DOM in reading order, announces new meaningful
    output without repeatedly reading the full log, gives textual equivalents
    for visual state, and preserves all information with reduced motion enabled.
14. The terminal page meets the approved Lighthouse accessibility threshold
    and has no keyboard trap or unlabeled interactive control under the pinned
    audit profile described in Open question 4.
15. At the approved phone viewport, the terminal remains readable without page-
    level horizontal scrolling, the prompt and transcript stay usable with the
    software keyboard, and a mobile key strip exposes `/`, `!`, Tab, and arrows.
16. Every normal visible frame includes `loadbearing.cc · Incident #NNN`, and
    product copy, model names, colors, and chrome do not use lab trademarks or
    clone any lab's exact trade dress.
17. The existing engine remains pure, headless, zero-runtime-dependency
    TypeScript with no DOM/host-time/network access, and the full Phase 0 replay,
    purity, typecheck, format, coverage, and timezone gates remain green.

## Risks & constraints

- Authoritative behavior remains `state = reduce(cartridge, seed, eventLog)`.
  Visitor input, mode/model changes, permission choices, and idle-nudge effects
  must be replayable events; wall time may interpolate presentation only and
  must never choose content or mutate engine state.
- Both views are renderers over one `SessionState`; the shell cannot be a
  subprocess, cosmetic transcript, or second source of truth. Runtime code may
  dispatch events but may not edit engine slices directly.
- Runtime owns mechanics and cartridges own worlds, copy, response pools,
  presentation pools, and model parameters. No Incident #001 behavior may be
  hardcoded to make the demo convincing.
- The current transcript is an event diagnostic log, and the current mind slice
  has a decision ledger but no pending-prompt lifecycle. New UI-facing state
  must remain plain JSON, versioned, bounded, serializable, and meaningful to
  future headless playtesters rather than inferred from DOM state or event-name
  strings.
- DOM types and browser dependencies belong under `runtime/`; they must not leak
  into the engine's independent TypeScript program or weaken the purity gate.
- Existing golden fixtures are contracts. Intentional state/transcript schema
  changes require generated fixture updates and explicit review; incidental
  rendering changes must not rewrite them.
- Accessibility is a shipped feature. Visual fidelity, animation, or terminal
  authenticity cannot displace keyboard, reduced-motion, mobile, or semantic
  transcript behavior.

## Open questions (all four resolved 2026-08-21 — decisions recorded inline)

1. **What content should prove natural-language and agent mechanics before
   Incident #001 exists?** Options: A — add a clearly non-production Phase 1
   demonstration cartridge with a minimal authored input/response/action set;
   B — pull a thin slice of Incident #001 into this phase; C — put generic agent
   responses in runtime code. **Recommendation: A.** It exercises the real
   cartridge boundary without stealing Phase 2's vertical slice or violating
   runtime/content separation.
   **Decision: A — approved by Chris, 2026-08-21 (operator-relayed).**
2. **How should model switching interact with a seed that currently includes
   the initial model?** Options: A — keep one root session seed and treat each
   model switch as an event, deriving model-specific named substreams from that
   root; B — reseed the session on every switch; C — remove the model from seed
   derivation now. **Recommendation: A.** It preserves the existing seed format,
   event-log continuity, and deterministic switching without rerolling unrelated
   state.
   **Decision: A — approved by Chris, 2026-08-21 (operator-relayed).**
3. **Which Phase 1 visual direction should set the product baseline?** Options:
   A — restrained original terminal styling with subtle structural/I-beam
   accents; B — a stronger warning-placard aesthetic; C — terminal-genre
   defaults with minimal branding. **Recommendation: A.** It remains credible at
   first glance, establishes distinct identity, and minimizes trade-dress risk.
   **Decision: A — approved by Chris, 2026-08-21 (operator-relayed).**
4. **What objective bar defines “Lighthouse accessibility pass” and
   “acceptable on a phone”?** Options: A — accessibility score 100 in a pinned
   Chromium desktop audit plus manual keyboard checks, with 390×844 as the
   required phone viewport; B — score at least 95 and a broader viewport matrix;
   C — manual acceptance only. **Recommendation: A**, with additional responsive
   spot checks treated as plan-level verification rather than expanding the
   formal browser matrix.
   **Decision: A — approved by Chris, 2026-08-21 (operator-relayed).**
