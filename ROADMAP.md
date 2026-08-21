# Load Bearing — Roadmap

> Build one astonishingly deep incident before building the factory.

This roadmap is ordered for agentic execution. Each phase has a goal, scope,
and a definition of done. Phases are sequential; tasks within a phase can be
parallelized. Do not pull work forward from a later phase without flagging it —
several later features (live model calls, the nightly pipeline) are
*deliberately* deferred.

Companion documents:

- `docs/DESIGN.md` — product vision, experience design, comedy bible, branding rules
- `docs/ARCHITECTURE.md` — state engine, cartridge format, runtime/content boundary
- `CLAUDE.md` — working agreements and invariants for agents working in this repo

---

## Phase 0 — Headless state engine

**Goal:** A deterministic simulated machine with no UI at all.

The engine is the product. It must run headless (Node + browser) because the
same engine later powers automated playtesting in CI. If the engine is not
headless, Phase 5 is impossible.

Scope:

- Core state model: virtual filesystem (with permissions and cwd), git
  (commits, branches, index, working tree, blame), processes, services, logs,
  environment variables, man pages — plus agent mind state (permission
  ledger; belief state distinct from world truth — see ARCHITECTURE.md →
  Agent mind state)
- Event-sourced design: state = `reduce(cartridge, seed, eventLog)`. All
  mutation flows through events. No `Date.now()`, no `Math.random()` — a
  seeded PRNG and simulated clock only (see ARCHITECTURE.md → Determinism)
- Command interpreter for the core shell command set (~25 commands: `ls`,
  `cat`, `cd`, `git status/log/diff/blame/checkout`, `grep`, `ps`, `rm`,
  `curl`, `man`, etc.) operating on cartridge-defined state
- Simulated test runner and service/process reactions defined by cartridge data
- Cartridge loader with schema validation (see ARCHITECTURE.md → Cartridge spec)
- A minimal fixture cartridge used only by tests (not Incident #001)

Definition of done:

- [x] Engine runs in Node with zero DOM dependencies — enforced by
  `npm run gate:purity` and the bare-Node assertion in `engine/index.test.ts`
- [x] Replay test: same (cartridge, seed, event log) → byte-identical state and
  transcript, proven by `014-full-session`, the golden replay suite, and CI's
  UTC + Asia/Tokyo runs
- [x] Full unit coverage of filesystem + git semantics — named VFS/Git tests
  prove path, permission, mutation, deletion, branch, log/blame, commit, and
  checkout coherence; `vitest.config.ts` enforces per-file regression floors
- [x] Cartridge schema validator rejects malformed fixtures with useful errors
  — `engine/cartridge/load.test.ts` asserts the complete deterministic issue
  list and an exact multi-error diagnostic

Explicitly not in this phase: any rendering, any comedy writing, any real
model calls.

---

## Phase 1 — Terminal UI (two views, one machine)

**Goal:** The agent TUI and the simulated Bash shell rendered in the browser,
both driving the Phase 0 engine.

Scope:

- Custom DOM terminal renderer (not a full terminal emulator — see
  ARCHITECTURE.md → Stack) with authentic focus behavior, cursor, and scrollback
- Agent TUI: `❯` prompt, natural-language input, `!`-prefixed shell
  passthrough, slash commands (`/model`, `/compact`, `/cost`, `/exit`),
  tool-call animations, permission prompts, model selector
- Cold open: the terminal boots as the shell (login banner →
  `loadbearing --resume incident-NNN`) before the TUI takes over
- Simulated Bash view reached via `/exit` or `Ctrl+D`; `loadbearing --resume`
  returns to the TUI with state intact and an in-character reaction to
  whatever changed while the agent was gone
- Bare `exit` in the shell refuses in character ("exit is load-bearing");
  `/exit` and `Ctrl+D` genuinely switch modes
- Status bar: model, tokens, cost, context %, structural integrity — values
  driven by the engine's metrics module
- Expandable thinking blocks, the todo widget, and the permission-prompt
  flow as first-class TUI elements, backed by engine state (permission
  ledger, belief state, todo events)
- Working-state spinner with deterministic verb selection (archetype × stage
  pools via the seeded PRNG) and the suffix channel (timer, token count,
  degrading esc hint) — see DESIGN.md → The spinner is the ambient narrator
- Ambient attribution in the terminal chrome ("loadbearing.cc · Incident
  #NNN" in title bar / status line) so every organic screenshot
  self-attributes
- Diegetic onboarding mechanics: rotating input-placeholder system,
  in-character `/help`, idle-nudge timer, slash autocomplete — no
  tooltips, overlays, or tutorials (DESIGN.md → Onboarding)
- Command history, tab completion, `Ctrl+C`, `Ctrl+L`, copy/paste, search
- Mobile key strip and responsive layout; reduced motion; screen-reader
  transcript semantics (see DESIGN.md → Accessibility)

Definition of done:

- [ ] Both views verifiably share one state (delete a file in the shell, the TUI knows)
- [ ] Keyboard-only session possible end to end
- [ ] Lighthouse accessibility pass on the terminal page
- [ ] Renders acceptably on a phone

---

## Phase 2 — Incident #001: the vertical slice

**Goal:** One handcrafted incident so deep it feels implausible.

This is the proof. Everything comedic in DESIGN.md gets exercised here.

Scope:

- Complete Incident #001 cartridge: repository (files, git history, tests,
  services, logs), hidden premise, reveals, callbacks, rare events, and at
  least three endings
- Four model personas on the four behavioral archetypes (paranoid / reckless /
  superficial / existential) with genuinely different sessions — switching
  models mid-incident changes what happens next
- ~30 meaningful commands plus a natural-language intent table
- Environmental storytelling pass on the world itself: file owners/groups,
  shell history, env vars, man pages, process and service names, and the
  in-world ticket archive — authored to the "shell plays it straight" rule
  (DESIGN.md), deadpan with jokes in the details
- The confident-misunderstanding fallback for unmatched input (failure is
  content — never "I don't understand"; see DESIGN.md → Comedy bible)
- Escalation staging 0→4 wired to session events
- Reactive status-bar narrative (numbers go from ridiculous to impossible)
- The 90-second golden path: a visitor who types the obvious three commands
  gets a complete comedic arc (see DESIGN.md → Time to first laugh)
- Permission complicity: authored trivial asks, conspicuous non-asks, the
  waiver (WAIVER.md + typed "I agree", cited at the ending), and
  consequences keyed off the permission ledger
- `/compact` damage: authored subtly-wrong summaries per archetype, with
  belief divergence visible in later responses
- Handoff blame: archetype-pair review templates plus incident-specific
  lines for mid-session model switches
- Story authored as shared beats modulated by archetype (ARCHITECTURE.md →
  Beats, not branches), never four parallel scripts
- Authored spinner verb pools for all four archetypes across stages 0–4,
  weighted per the rationing rule (mostly plausible, spikes rare)
- Authored onboarding content: agent opening lines, stage-keyed placeholder
  pools, in-character /help copy, idle-nudge lines per archetype
- Capitulation reflex responses per archetype across stages, including the
  stage-3+ misfires (DESIGN.md → The capitulation reflex)
- Field-recognized habit content: scope-creep consequences, victory
  summaries, filesystem littering (real VFS writes), flail-loop lines with
  counter, test-gaming moves, fantasy time estimates (DESIGN.md →
  Field-recognized habits)

Definition of done:

- [ ] Golden path lands a punchline within ~3 exchanges, playtested
- [ ] A first-time visitor with no instructions reaches a punchline —
      playtested with someone who has never seen the site
- [ ] All four models produce distinct transcripts from identical inputs
- [ ] Three endings reachable; at least one requires the shell layer
- [ ] At least one ending keys off the permission ledger; /compact
      demonstrably alters later agent behavior
- [ ] No input path produces an out-of-character or state-inconsistent response
- [ ] A playtest checklist (docs/PLAYTEST.md, written during this phase) passes

---

## Phase 3 — The daily frame and the share artifact

**Goal:** Turn one great incident into a ritual.

Scope:

- Site shell: scene-setting incident brief above the terminal, countdown to
  the next incident, incident number/date, archive navigation, RSS
- Deterministic replay permalinks: (incident, model, seed, command log)
  encoded in a shareable URL
- Incident Resolution Report end screen: outcome name, joke stats, endings
  discovered, share action; ending flags the day complete without ending
  the session (DESIGN.md → Completion without victory)
- Share card generator: transcript excerpt + absurd status-bar line + incident
  number/date + URL, rendered as an image (the "Wordle grid" of this site —
  treat as first-class, not an afterthought)
- Share affordances: `/share` command plus tap/long-press on any exchange;
  native share sheet on mobile (`navigator.share` with image), copy-image on
  desktop; replay URL embedded; no share-button chrome, popups, or social
  branding (DESIGN.md → The share artifact is first-class)
- Social preview cards per incident
- Static build and deploy pipeline (site remains static; daily content is
  pre-generated)

Definition of done:

- [ ] A replay URL reproduces a session exactly on another machine
- [ ] Share card generates client-side and looks good in a group chat
- [ ] Archive works; countdown rolls over correctly across time zones

---

## Phase 4 — Incident #002: prove the cartridge

**Goal:** Demonstrate that content, not code, drives the experience.

Scope:

- Author a second, structurally different incident **without touching runtime
  code**. Every runtime change needed to make #002 work is a bug report
  against the cartridge spec — fix the spec, then the runtime
- Harden the cartridge schema based on what #002 exposed; publish the schema
  as a versioned document
- `cartridge validate` CLI (schema + reachability + coherence checks: every
  referenced file exists, every callback has a source, endings reachable)

Definition of done:

- [ ] #002 shipped from a cartridge alone
- [ ] Validator catches the classes of authoring mistakes made while writing #002
- [ ] A third party could plausibly author a cartridge from the spec doc

---

## Phase 5 — The nightly writers' room

**Goal:** The overengineered multi-agent pipeline that authors tomorrow's
catastrophe — visibly.

The pipeline is part of the product's comedy and the strongest professional
artifact in the project. Build it like production software, and let it be seen.

Scope:

- Agent roles: Showrunner (premise + assignment), Repo Fabricator (files, git
  history, logs), Dialogue Writer (per-archetype responses), Continuity Editor
  (lore, callbacks, dedup vs. recent incidents), Playtesters (N simulated
  sessions per model via the headless engine), Critic (quality gates), Release
- Quality gates (see concept doc, kept verbatim as requirements): schema
  validity, date/number correctness, no changes outside content paths, premise
  dedup, distinct model behavior across simulated sessions, reachability and
  state coherence, pacing/quotability thresholds, successful build + archive +
  share card + fallback
- Permanent fallback episode wired into deploy ("The workflow was
  load-bearing") — pipeline failure is content, never downtime
- Public CI theater: in-character check names ("Europe still attached"),
  agent-authored PR descriptions for content PRs, nightly runs visible in the
  public repo
- Cost controls and run budget for the nightly job

Definition of done:

- [ ] Pipeline produces a validated cartridge end-to-end on a schedule
- [ ] A gate failure ships the fallback episode automatically
- [ ] Playtest agents exercise all models and flag indistinct behavior
- [ ] The whole run is legible from the public repo's CI page

---

## Phase 6 — Launch and the structural report

**Goal:** Convert the laugh into credibility.

Scope:

- Discovery commands: `/whoami`, `/architecture`, `/source`, `/tip`
  ("temporary financial shoring" — discoverable, never interruptive, never
  gating), `/stickers` easter egg if desired
- Structural report page: the simulation engine, cartridge schema, pipeline,
  playtesting/eval harness, guardrails, accessibility work, interesting
  failures and tradeoffs, and the actual nightly generation cost vs. the
  terminal's fictional session bill — written for a senior engineer's
  ten-minute read
- Homepage build-stats footer ("Tonight's build: 5 agents · 42 simulated
  sessions · …") wired to real pipeline output from Phase 5
- Footer attribution; "not affiliated with Anthropic, OpenAI, or any AI lab"
  disclaimer (see DESIGN.md → Branding guardrails)
- Repo polish: README, architecture diagram, clean history, the appropriately
  ridiculous CI checks
- In-character edge surfaces: the 404 page ("This page was removed. It was
  load-bearing."), robots.txt, and a `/bug` command that files a real GitHub
  issue behind a clearly labeled second step
- Archive pre-seeded with incidents #001–#007 (pipeline output plus manual
  curation) so launch day has depth to binge; Incident 000 referenced,
  never shown
- status.loadbearing.cc: static status page with uptime monitors for
  fictional services and scheduled maintenance windows (DESIGN.md → The
  support apparatus), archive doubling as incident history
- Launch: Show HN post, X thread, share-card-first framing

Definition of done:

- [ ] The structural report answers "who built this and how" without the reader opening the repo
- [ ] Trademark guardrails checklist in DESIGN.md fully satisfied
- [ ] Launch assets ready before the post goes up

---

## Post-launch expansions (only after launch proves the ritual)

- The full support desk (DESIGN.md → The support apparatus): visitor
  tickets → real GitHub issues → real auto-triage bot → nightly
  in-character Support Agent responses through the standard quality gates,
  with a per-night response cap and the honesty rule strictly enforced

## Deferred indefinitely (do not build without a new decision)

- Runtime model calls / constrained improvisation layer — deterministic
  simulation is authoritative until the deterministic engine's limits are
  actually reached with real visitors
- Accounts, streaks, comments, or any server-side state
- Merchandise beyond the `/stickers` gag
