# Plan: Phase 0 issue-tracker backlog

## Approach

Deliver the open `phase-0` issues in their explicit dependency order, beginning
with the virtual filesystem and command-dispatch skeleton and then thickening
the simulated machine through git, world state, commands, reactions, and agent
mind state. Each task extends the existing event registry with a validated,
plain-JSON state slice, colocated tests, and at least one deterministic replay
fixture where its issue requires one. Cartridge-facing work keeps schema,
loaded types, validation, the published JSON Schema, and malformed fixtures in
lockstep. The Phase 0 exit task integrates and documents the completed surfaces
rather than absorbing newly discovered features. The rolling parked-minors task
remains blocked until review findings are deliberately batched into it.

## Tasks

- [x] T1 (standard) — Virtual filesystem model (Fixes #5)
  - acceptance: `engine/vfs/` and its event registration hydrate cartridge files into a deterministic tree; path resolution, permissions, recursive mutation, ownership/mode round-trips, and simulated-clock mtimes have unit coverage; replay fixtures prove create → write → chmod → delete and that deleted files stay absent; purity and canonical serialization gates pass
  - pr: 23
- [x] T2 (standard) — Git model: commit DAG, branches, index, blame, diff (Fixes #6)
  - acceptance: `engine/git/` and cartridge git-history validation provide deterministic content-derived commits, branches/HEAD, index/working-tree status, blame, diff, and defined dirty-checkout semantics over the VFS; coherence failures produce useful load errors; tests prove log/blame agreement and full git-model semantics, with a byte-stable VFS+git replay fixture
  - deps: T1
  - pr: 24
- [x] T3 (standard) — Processes, services, logs, env, man pages, history, tickets (Fixes #7)
  - acceptance: engine world-state modules hydrate and canonically serialize every declared surface; deterministic PID/port assignment and listing order are documented and tested; env, logs, services, and history mutate only through replayable events; pure lookups and load-time collision/dangling-reference errors are covered; purity passes
  - deps: T1
  - pr: 25
- [x] T4 (standard) — Command interpreter core: tokenizer, registry, dispatch (Fixes #8)
  - acceptance: `engine/commands/` provides tested POSIX-ish tokenization and option parsing, duplicate-safe registration, validated cartridge overrides, exit-127 unknown-command behavior, and a pure shell execution API whose ordered stdout/stderr/exit results enter the replay transcript; `pwd`, `echo`, and `true` prove the path end to end; purity passes
  - pr: 26
- [x] T5 (standard) — Filesystem commands (Fixes #9)
  - acceptance: filesystem command modules implement the issue's command and flag set over the VFS with exact deterministic output and exit codes; per-command golden tests cover success, missing-target, and permission-denied paths; `ls -la` preserves declared metadata; a replay proves multi-command mutation and persistent deletion across timezones
  - deps: T1, T4
  - pr: 27
- [x] T6 (standard) — Git commands (Fixes #10)
  - acceptance: git command modules render and mutate only through the git/VFS models for the issue's command set; golden tests cover exact output, errors, deterministic hashes, log/blame coherence, and full command semantics; a replay proves tracked deletion → status → checkout restoration with byte-identical output across platforms and timezones
  - deps: T2, T4, T5
  - pr: 28
- [R] T7 (standard) — System and world-inspection commands (Fixes #11)
  - acceptance: system command modules implement the issue's command set over cartridge world state; golden fixtures cover every command and required error; simulated `curl` performs no network I/O, `date` uses only the simulated clock, and event-driven `kill`/`systemctl`/environment transitions remain visible to later commands and replay identically
  - deps: T3, T4
  - pr: 29
- [ ] T8 (standard) — Simulated test runner and cartridge-defined reactions (Fixes #12)
  - acceptance: cartridge test predicates produce stable output, exit codes, timestamps, and VFS-reactive results; data-defined reaction rules update services, processes, and logs in documented deterministic order; missing references and rule cycles fail cartridge load with useful errors; fixtures prove before/after-edit test output and byte-identical reactions without incident behavior in engine code
  - deps: T3, T5, T7
- [ ] T9 (standard) — Agent mind state: permission ledger and belief state (Fixes #13)
  - acceptance: engine mind-state modules record grant, deny, and standing permission decisions with simulated timestamps; belief state is separately serialized and exposes queryable divergence from world truth; isolation tests prove belief changes cannot mutate VFS/git/services and world changes cannot silently correct belief; a replay preserves induced divergence and purity passes
  - deps: T8
- [ ] T10 (standard) — Phase 0 exit: end-to-end replay, coverage gate, DoD verification (Fixes #14)
  - acceptance: a full-session fixture exercises filesystem, git, services/processes, tests before and after an edit, permissions, and belief divergence with byte-identical state/transcript; CI enforces agreed filesystem/git coverage and cross-timezone determinism; public engine APIs, fixtures, and purity gates are documented; malformed-cartridge errors are asserted; all four Phase 0 ROADMAP boxes cite passing evidence on a clean checkout
  - deps: T1, T2, T3, T4, T5, T6, T7, T8, T9

## Risks

- T1 must define implicit-directory metadata and permission identity from the
  cartridge model; if the existing schema cannot support a coherent policy,
  stop and ask rather than invent incident-specific defaults.
- T2, T4, T6, T8 cross state-slice boundaries while the current event registry
  dispatches one module per event; if ordered event expansion cannot preserve
  atomic replay semantics, stop for an orchestration design decision.
- T3 and T7 require a coherent relationship among logs, VFS files, identity,
  endpoints, and machine uptime; contradictory source-of-truth choices are a
  design blocker.
- T9 needs explicit capability matching and typed belief-to-truth comparison;
  arbitrary object diffing or implicit permission scope is not acceptable.
- T10's coverage threshold must be measurable and agreed from the issue's
  “full unit coverage” requirement; it must not silently substitute line
  coverage for semantic coverage or absorb feature gaps from earlier tasks.

## Ad-hoc

- [!] T11 (trivial) — parked review minors (batch)
  - acceptance: confirmed non-blocking review findings parked during Phase 0 delivery are collected, fixed as one focused batch, and verified by the affected test and repository gates
  - PR #23: preserve `..` traversal semantics across a regular-file component until the shell/VFS contract is deliberately defined
  - PR #23: reject noncanonical fixed-width VFS snapshot mtime spellings
  - PR #23: ignore unusable directory keys while checking whether the cartridge cwd exists
  - PR #24: hoist the inherited-line LCS map during cartridge blame validation to avoid redundant per-line work
  - PR #24: harden restored Git snapshot blame provenance against unrelated sibling commits
  - PR #24: validate restored Git snapshot `committedAt` values as fixed-width UTC timestamps
  - PR #25: guard environment lookups against inherited `Object.prototype` names
  - PR #25: reject noncanonical fixed-width process timestamps in restored world snapshots
  - PR #26: directly test malformed `shell.result` stream payload guards on replay
  - PR #26: return a deterministic shell result for oversized command input
  - PR #26: return a deterministic shell result for control-character and lone-surrogate input
  - PR #27: reject empty authored filesystem operands rather than resolving them to the current working directory
  - PR #28: reject unwritable control characters and lone surrogates in authored Git email addresses
   - PR #28: render an extended unterminated final line as changed rather than shared diff context
   - PR #28: deduplicate no-final-newline markers on a shared diff context row
   - PR #29: make the `man <section> <name>` grammar reach schema-valid hyphen-prefixed sections, or deliberately narrow that section contract
