# CLAUDE.md — Load Bearing

You are working on **Load Bearing** (loadbearing.cc): a daily interactive
comedy presented as a polished browser-based coding environment. Visitors
investigate a fictional production incident inside a coding-agent TUI where
everything is load-bearing and the agent deteriorates. The terminal is real;
the computer is lying; you are building the liar.

Yes, you are implementing a parody of a tool very much like yourself.
Anthropic-adjacent self-awareness is welcome in commit banter, not in the
product (see invariant 5).

Read before working: `ROADMAP.md` (current phase + definitions of done),
`docs/DESIGN.md` (experience + comedy bible), `docs/ARCHITECTURE.md`
(engine, cartridge spec, pipeline).

## Invariants (violating these is never a valid solution)

1. **Runtime/content separation is sacred.** Runtime owns mechanics;
   cartridges own worlds. Content tooling and (later) the nightly pipeline
   may only write under approved content paths. If a cartridge needs a
   runtime change, fix the cartridge *spec*, then the runtime — never
   hardcode an incident into the app.
2. **Determinism is non-negotiable.** All randomness through the seeded
   PRNG; all time simulated; state = reduce(cartridge, seed, eventLog).
   No `Math.random()`, no `Date.now()` inside the engine. If a feature
   can't survive deterministic replay, redesign the feature.
3. **The engine stays headless.** Pure TS, zero DOM dependencies, runs in
   Node. CI playtesting depends on this.
4. **The world lies consistently.** State coherence (files, git, blame,
   services) is a hard requirement. An inconsistent simulation is a broken
   build even if nothing throws.
5. **No lab trademarks in the product.** No "Claude"/"Anthropic"/"GPT"/etc.
   in product copy, fake model names, or branding. Nominative reference is
   allowed only on the structural report/about page with the non-affiliation
   disclaimer. Evoke the genre, never any lab's trade dress.
6. **No runtime model calls.** Deterministic simulation is authoritative.
   The improvisation layer is deferred indefinitely; do not add API calls
   to the runtime "to handle an edge case."
7. **Failure is content, never apology.** No user input path may produce
   "I don't understand" or a generic error from the agent character.
   Unmatched input routes to the confident-misunderstanding generator.
   Pipeline failure ships the fallback episode.
8. **Accessibility is in scope.** Keyboard-only operation, screen-reader
   transcript semantics, and reduced motion ship with the feature, not after.

## Voice quick reference (for any authored content)

Every agent response must state/imply something is load-bearing, reveal the
agent worsened or misunderstood the task, or advance its deterioration.
Deadpan and specific; escalation stages 0–4 per DESIGN.md; "load-bearing"
is a worldview, not a catchphrase — ration the literal phrase. Match the
bar of: "All tests pass. This has reduced my confidence."

Two registers, never blended: the **agent** is the overtly unhinged
character; the **shell** plays it straight — plausible output with the
jokes hidden in environmental details (owners, services, history, man
pages). The shell's restraint is what makes the agent's escalation land.

## Working agreements

- Follow ROADMAP.md phase order. Do not pull later-phase work forward
  without flagging it explicitly.
- Every engine change lands with tests; every content change passes
  `cartridge validate` (once it exists) and the determinism suite.
- Small, reviewable commits. Professional commit messages for runtime code;
  in-character commit messages are permitted for content under
  `content/` only.
- Incidents are authored as shared story beats that archetypes modulate —
  never four parallel scripts (ARCHITECTURE.md → Beats, not branches).
- Golden replay fixtures are contracts: if a change breaks one, the change
  is wrong or the fixture update needs explicit justification in the PR.
- When a design question isn't answered by the docs, add it to
  DESIGN.md → Open decisions and ask — don't silently decide product
  questions in code.

## Repo layout (target)

```
/engine/        pure TS simulation engine (headless)
/runtime/       terminal views, site chrome, share cards
/content/
  schema/       versioned cartridge schema + validator
  incidents/    dated cartridges (001, 002, ... fallback)
  lore/         continuity registry
/pipeline/      nightly writers' room (Phase 5)
/docs/          DESIGN.md, ARCHITECTURE.md, PLAYTEST.md
```

## Definition of done

Per-phase checklists live in ROADMAP.md. A phase is not complete until its
checklist passes — including the playtest and accessibility items, which
are the ones most tempting to skip and most load-bearing to the product.
