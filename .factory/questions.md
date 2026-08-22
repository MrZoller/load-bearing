# Questions

Open blockers for the human. Agents append per the `factory-protocol` skill;
answers go inline under each question after `**A:**` (or answer in chat via
`/blocked`). Entries are never deleted — reconciliation marks an applied or
forwarded answer `consumed` in the same bookkeeping commit.

---

## Q1 (task T1, consumed) — What identity and implicit-directory policy should the VFS use?

Context: The cartridge declares file owners/groups but no acting user, groups,
home directory, umask, or directory metadata. T1 requires permission denials,
`~` resolution, and recursive mutations, so inventing defaults would define a
public cartridge policy; the approved plan explicitly identifies this as a
design blocker. Parked branch: `factory/t1-virtual-filesystem`.
Options considered: A — add cartridge identity plus authored directory metadata
and documented defaults for undeclared ancestors; B — add one global implicit
directory/identity defaults object, which is simpler but cannot author directory
ownership; C — defer permission enforcement, which does not meet issue #5.
Please also specify root bypass, creation owner/group and umask, whether bare
`~` is the only tilde form, chmod authorization, copy metadata behavior, and
whether successful child mutations update parent-directory mtimes.
**A:** Option A, with directory metadata optional.

Schema changes:

- `repository.identity` (REQUIRED): `user`, `group`, `home`, `umask` (default `0022`). This is the acting identity; without it permission denial and `~` have no subject.
- `repository.directories` (OPTIONAL): map keyed by absolute path, same shape as a file entry minus `contents` (`owner`, `group`, `mode`, `mtime`). Cartridges declare only the directories that carry authored meaning.
- Undeclared ancestor directories: inherit `owner`/`group` from the nearest declared ancestor directory, else `root:root`; default mode `0755`; default `mtime` = `meta.startedAt`, matching the existing file rule.

Sub-questions — take standard POSIX behavior for all of these:

- Root bypass: user `root` bypasses permission checks.
- Creation: new files and directories take the acting identity from `repository.identity`; mode `0666 & ~umask` for files, `0777 & ~umask` for directories.
- Tilde: bare `~` and `~/path` only. `~user` is unsupported and stays a literal path segment — there is no user database to resolve it against.
- chmod: authorized for the file's owner or root only.
- Copy: `cp` creates the destination with the acting identity and umask; `cp -p` preserves owner, group, mode, and mtime.
- Parent mtime: create, delete, and rename inside a directory update that directory's mtime; writing to an existing file does not.

This is public cartridge policy, not incident-specific: document it in the cartridge schema descriptions and record the decision in `docs/DESIGN.md` as part of this task.

## Q2 (task T4, consumed) — How should shell execution coordinate cross-slice mutations?

Context: An event module may return only its own namespace slice, but T5–T7
commands must atomically mutate VFS, git, process, service, and environment
slices while recording one ordered shell result. The approved plan names this
as an orchestration blocker; T4 also needs a cartridge-command schema and a
structured stdout/stderr transcript contract that do not yet exist. Parked
branch: `factory/t4-command-interpreter`.
Options considered: A — add reducer-supported ordered event expansion, with one
visitor command expanding into owning-subsystem events plus a shell-result
event; B — add a privileged orchestration module allowed to return multiple
slices, weakening the current isolation invariant; C — have each mutating
command be an owning-subsystem event and keep `shell.execute` only for pure
commands, complicating the single shell API and transcript ordering.
Please select the orchestration model and confirm whether cartridge commands
should be static `{stdout, stderr, exitCode}` records under `repository.commands`,
and whether transcript entries should gain structured stream-tagged output plus
an exit code.
**A:** Option A — reducer-supported ordered event expansion.

One visitor command expands into owning-subsystem events plus a shell-result
event. Rejected B because a privileged multi-slice module trades away the
one-module-one-slice isolation invariant (ARCHITECTURE.md:97), and CLAUDE.md
holds that weakening an invariant is never a valid solution. Rejected C because
issue #8 requires a single shell execution entry point that Phase 1's `!`
passthrough and Bash view both call; splitting mutating commands out of
`shell.execute` fights that requirement and complicates transcript ordering.

Expansion order must be deterministic and documented, and each expanded event
folds one TranscriptEntry at the same index, per ARCHITECTURE.md:121.

Sub-questions, both yes:

- Cartridge commands are static `{stdout, stderr, exitCode}` records under
  `repository.commands`. Data, not behavior — keeps incident logic out of the
  interpreter per invariant 1.
- Transcript entries gain stream-tagged output plus an exit code. Issue #8 makes
  the result shape part of the replay contract, and without stream tags Phase 1
  cannot render stderr distinctly or fixtures assert on it.

## Q3 (task T6, consumed) — What bounded Git CLI and commit-identity policy should the simulator expose?

Context: Issue #10 names ten commands and requires full semantics, but the Git
model has no author identity for new commits and the issue does not define the
mutating forms for `branch`, `commit`, `restore`, path checkout, or pathspecs.
Choosing these details defines public cartridge and shell behavior rather than
an implementation detail. Parked branch: `factory/t6-git-commands`.
Options considered: A — add required `repository.gitIdentity` name/email and
support a bounded Git-compatible contract (`branch [name]`, `commit -m`,
`restore [--staged] <path>`, `checkout <ref>` and `checkout -- <path>`, exact
cwd-relative paths plus `.` for add); B — derive author identity from the VFS
user and support only the narrowest happy-path forms, avoiding schema work but
inventing an email/default policy; C — make commit author/message explicit on
every command invocation, which is deterministic but unlike the requested Git
register. Please also confirm fixed seven-character hash abbreviations with
deterministic extension on collisions, UTC/C-locale dates, and committed-tree
blame (working edits remain visible through diff/status, not blame).
**A:** Option A — required `repository.gitIdentity` (name/email) and the bounded Git-compatible contract as listed.

Rationale: this follows the standing decision recorded in `.factory/spec.md` — world facts are cartridge content. Commit authorship is a comedy surface exactly like `ls -la` ownership (a commit by a departed engineer is authored content, not an engine default). Option B derives identity from the VFS user and invents an email policy, which is precisely what Q1 rejected; option C breaks the shell's straight register.

Confirmed as asked: fixed seven-character hash abbreviations with deterministic extension on collision; UTC and C-locale dates (the schema already states the simulated machine has no other timezone); committed-tree blame.

DELIBERATE DEVIATION to record in `docs/DESIGN.md` in this task's PR: committed-tree blame differs from real `git blame`, which annotates the working tree and attributes uncommitted lines to "Not Committed Yet" with a zero hash. We accept the deviation because issue #6 requires log and blame to agree, and the real behavior forces a pseudo-commit into every fixture. Document it as a chosen simplification so it is not later read as a bug.

## Q4 (task T7, consumed) — What cartridge contracts should back curl, machine identity, uptime, and shell history?

Context: Issue #11 requires simulated endpoints, `uname`, machine uptime, and
session-accumulated history, but the cartridge has no endpoint, machine, or boot
metadata and shell execution does not append history. The approved plan names
these source-of-truth choices as a design blocker. Parked branch:
`factory/t7-system-world-commands`.
Options considered: A — add `repository.system` (`hostname`, `operatingSystem`,
`kernelRelease`, `architecture`, `bootedAt`) and exact-URL
`repository.endpoints` records linked to a service, with declared running and
unavailable `{stdout, stderr, exitCode}` responses; append every nonblank raw
shell input before its command-owned events, while `history` displays only
prior entries because command output is computed before expansion; B — use
runtime-fixed machine strings/session elapsed time and body-only endpoint
records, which is simpler but moves world content and uptime semantics into the
engine; C — defer `curl`/`uname`/`uptime`/accumulated history, which does not meet
issue #11. For bounded CLI behavior, please also confirm no options except
`uname -a`; `export NAME=value`; `man [section] name`; `systemctl
status|start|stop|restart service`; one PID for `kill`; and UTC/C-locale
formats for `date` and `uptime`.
**A:** Option A — add `repository.system` (`hostname`, `operatingSystem`, `kernelRelease`, `architecture`, `bootedAt`) and exact-URL `repository.endpoints` records linked to a service, with declared running and unavailable `{stdout, stderr, exitCode}` responses; append every nonblank raw shell input before its command-owned events.

Rationale: same standing decision — world facts are cartridge content. Option B hardcodes one machine into the engine and derives uptime from session elapsed time, which means every episode shares a host that has been up for four minutes. The premise is a different incident every day; the machine has to be authorable. A box up for 400 days on a kernel nobody dares patch is content.

Confirmed as asked, all as bounded POSIX-shaped behavior with no surface beyond what issue #11 requires: no options except `uname -a`; `export NAME=value`; `man [section] name`; `systemctl status|start|stop|restart <service>`; one PID for `kill`; UTC and C-locale formats for `date` and `uptime`.

DELIBERATE DEVIATION to record in `docs/DESIGN.md` in this task's PR: `history` displays only prior entries and does not list itself. Real bash appends a command to history before executing it, so `history` shows itself as the final line. We accept the deviation because command output is computed before event expansion. Document it as a chosen simplification — history is a surface a curious visitor will poke.

## Q5 (task T8, consumed) — How should reaction cascades cross event-module boundaries?

Context: Issue #12 requires post-event rules, deterministic cascades, and
load-time rejection of rules that would fire in a cycle. The current reducer
forbids nested expansion and nested effects: a `shell.execute` child cannot
expand reaction action events, and a reaction effect cannot use
`world.log-append` because file-backed logs themselves emit a VFS effect. The
approved plan explicitly says to stop if ordered expansion cannot preserve
atomic replay semantics. Parked branch: `factory/t8-test-runner-reactions`.
Options considered: A — add a generic reducer-level post-event reaction phase
that evaluates the staged post-event state, applies cartridge rules/actions in
authored order, permits acyclic cascades, and commits the trigger plus all
reaction changes atomically; B — make every reactive module plan a flat effect
batch, which duplicates orchestration across VFS/world/tests and either loses
recursive event semantics or relaxes nested-effect isolation; C — add one
privileged reaction module that rewrites several slices, weakening the existing
one-module-one-slice ownership invariant. Recommendation: A; it changes the
central reducer but preserves ownership, atomicity, and the cycle requirement
without incident-specific behavior. Please confirm A or choose another model.
**A:** Option A confirmed — a generic reducer-level post-event reaction phase.

Pinned details, so the contract is explicit:

- Reaction rules and actions are cartridge DATA evaluated by the generic
  engine; no incident behavior enters engine code (invariant 1, and issue #12's
  own requirement).
- Evaluation order is authored order; cascade order is documented and
  fixture-pinned. Cascades must be acyclic, with cycles and dangling
  references rejected at cartridge load with useful errors.
- The trigger event plus ALL reaction-derived changes commit atomically as one
  replay step. Reactions are RE-DERIVED during replay from rules + trigger —
  never separately recorded in the event log — so `state = reduce(cartridge,
seed, eventLog)` remains literally true and nothing double-applies.
- Each reaction action is still an owned event applied by its owning module:
  the reaction phase orchestrates WHICH events fire and in what order; it
  never writes a slice itself. One-module-one-slice survives unchanged.
- T4's ordered-expansion contract stays intact; the reaction phase runs on the
  staged post-expansion state. The before/after-edit reaction fixture required
  by issue #12 must prove byte-identical cascades.

This is the T2/T4/T6/T8 orchestration risk the plan named; resolving it in the
reducer core with ownership preserved is the same resolution as Q2, applied to
reactions. Standing decisions in `.factory/spec.md` continue to apply.

## Q6 (task T9, consumed) — What explicit capability and typed belief vocabulary should mind state expose?

Context: Issue #13 requires standing permissions to answer whether a later
action is covered and `beliefDivergence(state)` to compare belief with world
truth, but it does not define either public vocabulary. The approved plan
explicitly rejects implicit permission scope and arbitrary object diffing, so
choosing these contracts would be a user-visible engine/API decision rather
than an implementation detail. Parked branch:
`factory/t9-agent-mind-state`.
Options considered: A — exact capabilities only (`{ kind: "exact", action,
resource }`) plus a closed typed belief union for file existence/contents, Git
HEAD, and service state/health; exact field equality checks standing grants and
each belief kind uses its subsystem's typed truth query. B — add broader typed
capability scopes (such as VFS subtree or command family) and a subsystem truth
resolver registry now, which is more extensible but commits Phase 1/2 to a
larger public contract. C — opaque strings and arbitrary paths/deep diffs,
which the approved plan prohibits. Recommendation: A as the smallest explicit
Phase 0 contract. Please also confirm that applying an authored `/compact`
summary replaces current belief assertions (while preserving a timestamped
summary history) rather than patching them.
**A:** Option A — exact capabilities and the closed typed belief union.

- Capabilities: `{ kind: "exact", action, resource }` only; standing-grant
  coverage is exact field equality. No subtree or command-family scopes in
  Phase 0.
- Beliefs: the closed union as proposed (file existence/contents, Git HEAD,
  service state/health); each kind compares through its owning subsystem's
  typed truth query. No object diffing anywhere.
- B is rejected under standing decision 4: broader scopes and a resolver
  registry commit Phase 1/2 to public contract surface issue #13 does not
  imply. The closed union widens compatibly later — adding kinds is
  non-breaking — so extensibility costs nothing to defer until a Phase 1/2
  issue actually demands it. C is prohibited by the plan outright.
- Confirmed: applying an authored `/compact` summary REPLACES the current
  belief assertions wholesale, preserving the timestamped summary history.
  Replacement is the load-bearing semantic: post-compact belief derives only
  from the summary, so authored summaries can induce divergence and
  `beliefDivergence` reports it faithfully; patching would let pre-compact
  truth leak through and dampen the exact effect the mechanism exists to
  create. Document the replace semantics in the module's public API docs
  (already required by the task's acceptance).

## Q7 (task T10, consumed) — What filesystem/Git coverage threshold is agreed for the Phase 0 exit gate?

Context: Issue #14 and the approved plan require an agreed threshold and warn
against silently substituting line coverage for semantic coverage, but no
number was approved. Parked branch: `factory/t10-phase-0-exit`. A trial 100%
per-file gate over the five executable VFS/Git model files started at 90.67%
statements/lines, 82.10% branches, and 100% functions. Focused semantic tests
raised the aggregate to 95.71% statements/lines, 86.74% branches, and 100%
functions, but individual files remain as low as 93.85% lines and 76.51%
branches; reaching literal 100% still requires substantial error-path work and
would materially expand this exit task.
Options considered: A — require 100% per file for statements, lines, branches,
and functions, and continue adding semantic tests until all five files meet it;
B — enforce aggregate floors of 95% statements/lines, 85% branches, and 100%
functions, retaining the named semantic tests as the meaning behind the metric;
C — enforce per-file floors of 93% statements/lines, 75% branches, and 100%
functions so no weak file can hide in the aggregate. Recommendation: B balances
a strong no-regression gate with the issue's explicit named semantic evidence;
A is the strict reading of “full,” while C is the strongest anti-masking gate.
**A:** Option C — per-file floors of 93% statements/lines, 75% branches, and
100% functions — with B's semantic rider made explicit.

Reasoning: the plan's risk line warns against a weak file hiding behind a
healthy average, and aggregates (B) permit exactly that; C is the anti-masking
gate, and its floors clear today's worst files (93.85 / 76.51), so it lands
without materially expanding the exit task the way literal 100% (A) would.

Pinned details:
- No percentage defines "full unit coverage." The DoD's "full" is carried by
  the NAMED semantic tests — the issue-enumerated behaviors (path resolution
  edge cases, permission denials, `mkdir -p`, rename/copy, deletion
  persistence, log/blame agreement) each present and passing. The per-file
  floors are the anti-regression mechanism, not the definition. State this
  distinction in the exit documentation.
- Floors may be RAISED later without a question (ratcheting up is safe);
  lowering one is a design question and stops the line.
- Functions stay at 100% per file — already achieved everywhere.

## Q8 (task T25, consumed) — Should T25 receive another focused fix cycle after its re-panel block?

Context: The initial panel confirmed and fixed a Linux Ctrl+C transcript-copy
bug and a degenerate scroll-anchor test. The required one-time re-panel then
confirmed that broadening the shared `hasSelection` helper also regressed Tab
completion whenever document text remains selected; the verifier classified
that as blocking because it reopens native focus traversal fixed in T24. The
review rubric says a task still blocked after its one re-panel must be parked
rather than fixed again in the same cycle. Parked branch:
`factory/t25-transcript-search-scrollback`.
Options considered: A — resume T25 in a fresh cycle, split input-only selection
from document selection so only Ctrl+C consults the latter, add the focused Tab
regression test, run verification, and panel again; B — replan or defer T25,
which also blocks T28 and T29. Recommendation: A; the defect and minimal fix are
well bounded, but proceeding now would violate the panel termination rule.
**A:** Option A — resume T25 in a fresh cycle (operator answer, as Chris's representative; process continuation with a documented default, no product-surface change). Split input-only selection state from document selection so only Ctrl+C consults the document selection; add the focused Tab-completion regression test alongside T24's coverage; full verification and a fresh panel. Option B rejected: deferral blocks T28/T29 for a defect Q8 itself describes as well bounded.

## Q9 (task T32, open) — Where should the waiver-consent query contract begin?

Context: T32 must add closed conditions sufficient to query every approved T31
ending row, including the row that requires a distinct typed waiver-consent
ledger fact. That fact and its capture semantics do not exist yet and are
explicitly assigned to T34. A condition backed by ordinary permission or an
untyped story fact would violate the approved matrix, while a declared but
unevaluable predicate would not meet T32's acceptance. Parked branch:
`factory/t32-closed-story-conditions`.
Options considered: A — let T32 establish only the typed waiver-ledger state,
snapshot validation, and read/query contract under `engine/mind/`, while T34
retains exact input capture and atomic continuation behavior; B — revise T32's
acceptance so it defines the waiver predicate structurally but does not evaluate
it until T34; C — move the whole waiver ledger and consent flow into T32,
materially expanding this already-major story-contract task. Recommendation: A,
because it gives T32 a truthful closed query vocabulary without taking T34's
consent-boundary implementation.
**A:** Option A — T32 establishes the typed waiver-consent ledger state, snapshot
validation, and read/query contract under `engine/mind/`; T34 retains exact
input capture and atomic continuation. (Operator answer, as Chris's
representative: task-boundary decomposition with a documented default and no
product-surface change. The approved spec decision Q1=A requires the distinct
typed fact, which A preserves verbatim; B would ship an unevaluable predicate
and C would materially expand an already-major task beyond its approved
scope.)
