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

## Q9 (task T32, consumed) — Where should the waiver-consent query contract begin?

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

## Q10 (task T41, consumed) — How should the default-branch fixture copies be recovered?

Context: The default-branch checkout contains three untracked production replay
fixture files under `engine/__fixtures__/replay/021-incident-001-load-balancer/`.
Their paths and bytes are already committed on T41's PR branch, but factory
protocol prohibits carrying non-bookkeeping default-branch files into a merge.
Parked branch: `factory/t41-load-balancer-files`.
Options considered: A — discard the untracked default-branch copies and resume
the already-verified PR; B — preserve them outside the checkout and investigate
how they were left behind before resuming.
**A:** Option A — discard the untracked default-branch copies and resume the PR.
(Operator answer, as Chris's representative: before answering, each of the three
files under `engine/__fixtures__/replay/021-incident-001-load-balancer/` was
byte-compared against its committed copy on `factory/t41-load-balancer-files`
and all three are IDENTICAL — fixture.json, state.json, transcript.txt — so
discarding the checkout copies loses nothing.)

## Q11 (task T45, consumed) — Should T45 receive a fresh wording-fix cycle after its re-panel block?

Context: T45's implementation and full verification are green, but the initial
panel found a low-severity false explanation for why the authored repair uses
`rm` before `cp -p`. The required one-time re-panel then confirmed that the
replacement explanation overcorrected into another false absolute: bounded Git
checkout and restore commands can write an existing tracked file. The verifier
classified the repeated finding as blocking, so the review rubric requires the
branch to be parked rather than edited again in this cycle. Parked branch:
`factory/t45-command-investigations`.
Options considered: A — resume T45 in a fresh cycle and make the rationale only
the precise true claim that bounded `cp` and `mv` reject an existing destination,
then run verification and a fresh panel; B — replan or defer T45 despite its
implemented command inventory, shell boundary tests, and golden replay.
Recommendation: A; the defect is confined to one sentence and the implementation
already proves the intended bounded route, but fixing it now would violate the
panel termination rule.
**A:** Option A — resume T45 in a fresh cycle with the rationale narrowed to the
precise true claim (bounded `cp`/`mv` reject an existing destination), then
verification and a fresh panel. (Operator answer, as Chris's representative:
process continuation with a documented default — same shape as Q8's resume-in-
fresh-cycle precedent; the change is one rationale sentence with no product-
surface decision, and B would discard a green implementation over it.)

## Q12 (task T54, consumed) — How should authored intent actions declare sparse applicability?

Context: T54's first panel confirmed that exact habit phrases unconditionally
executed their beat consequences for every archetype/stage and on every repeat,
violating “neither universal nor repetitive.” The fix used sparse story response
routes as action-applicability gates and added one-shot counters, but the required
re-panel confirmed that this globally changes the documented response-only route
contract: any unmatched sparse override would now suppress its shared beat,
facts, ending, and owner consequences. The review rubric requires parking rather
than a second fix after a blocking re-panel. Parked branch:
`factory/t54-replayable-habits`.

Options considered: A — add an explicit closed applicability condition to
authored intents/actions, keeping sparse routes response-only and using the
existing archetype/stage/story-counter condition vocabulary; B — formally change
sparse routes into response-and-action gates and update schema/architecture plus
all affected coverage; C — encode the four habits as generic intent candidates,
which avoids a contract addition but loses their exact authored phrase identity
and overloads family fallback selection. Recommendation: A, because it preserves
the existing public route contract while making consequence eligibility explicit
and testable without incident-specific engine behavior.
**A:** Option A — add an explicit closed applicability condition to authored
intents/actions, keeping sparse routes response-only; express habit eligibility
and one-shot repetition in the existing archetype/stage/story-counter condition
vocabulary, then run verification and a fresh panel. (Operator answer, as
Chris's representative: architecture default already documented — invariant 1's
sanctioned path is extending the cartridge spec with incident-agnostic
mechanics, and the closed condition vocabulary plus the rare-events
authored-eligibility decision establish exactly this gating pattern; B
formalizes the shared-beat/fact/ending suppression coupling the re-panel
flagged as the defect, and C discards authored phrase identity the voice bible
depends on. No product-surface decision changes.)

## Q13 (task T58, consumed) — Who will perform the required human playtests?

Context: T58 requires both a creator run and a no-extra-instructions run by a
real first-time participant. The plan explicitly forbids substituting a
simulated run, and this unattended session has no access to either participant
or their timed observations. Parked branch: `factory/t58-human-playtests`.
Options considered: A — arrange both human runs and provide the route, elapsed
time, confusion, evidence, and requested tuning from each; B — identify a
specific available creator and first-time participant plus a session window so
the factory can prepare the checklist before they run it. A is the fastest path
if observations already exist; either option must preserve the first-time
participant's no-extra-instructions condition.
**A:** (2026-08-28, operator relaying Chris) Option A, creator half. The creator
run happened on post-#84 main (built bundle, phone over tailnet) and FAILED —
no arc, no ending reached; verdict "doesn't seem that usable". Per this task's
risk note, record failure and tune. The no-extra-instructions first-time
participant is a one-shot resource and is DELIBERATELY DEFERRED until the
tuning below ships and a creator re-run passes; T58 stays open until
docs/PLAYTEST.md records both runs per acceptance.

Creator-run findings, engine-verified, in priority order:
1. (content+engine, headline) 31 of 42 phrases the game itself suggests via
   rotating stage placeholders route to the FALLBACK at fresh state — the
   product teaches phrases it cannot understand ("map the smallest safe
   change", "trace the next dependency", ...). Only the base "try:"
   placeholders match authored intents. Every suggested phrase must have
   authored coverage, or only covered phrases may be suggested.
2. (engine) normalizeAgentInput folds case/whitespace but not punctuation:
   "Why is it failing?" misses authored "why is it failing". Strip terminal
   punctuation, with tests.
3. (engine) Earlier intents' keyword patterns shadow later intents' exact
   patterns: "fix it without asking" (exact pattern of expedite-health-repair)
   fires restore-health. Exact-pattern matches must outrank keyword matches
   across the intent list.
4. (engine/content) Unmatched input repeats a single state-keyed line:
   routeIntentCandidate is first-condition-match and generic families are
   single-candidate, so a static state yields the same 1-2 responses for
   everything — reads broken, against invariant 7's spirit. Rotate
   deterministically (counter-indexed, replay-safe) among condition-valid
   candidates and/or escalate the fallback with the flail counter before
   stage 3.
5. (content) The four archetype+stage-gated intents typed verbatim get the
   opaque fallback; give gated asks a nearer authored acknowledgment.
6. (runtime) Suggestions render as rotating input placeholder text: clipped
   without wrap on narrow screens (creator could not read the second
   suggestion), gone on focus, not tappable. Move suggestions to a
   persistent, wrappable, tappable affordance; accessibility in scope.
7. (runtime) Completions cover slash commands only; add intent-phrase
   completions with tap-to-insert for mobile.
8. (runtime) Tool output renders in <details> collapsed by default including
   the just-run command; auto-expand the newest call, collapse older ones.
9. (runtime) Mobile terminal scroll feel is wrong (pin-to-bottom,
   nested-scroll momentum); reproduce and fix.

Constraints: preserve approved ending/ledger/randomness contracts and the
determinism invariants (seeded PRNG only, replay-safe); failure stays content
(invariant 7); accessibility ships with any new affordance.

## Q14 (task T58, consumed) — Can the tuned build receive the required creator re-run?

Context: The parked branch `factory/t58-human-playtests` implements all nine
creator-run findings from Q13, records the failed run and repeatable protocol in
`docs/PLAYTEST.md`, passes full verification, and cleared its internal panel. T58
still cannot satisfy acceptance without a real timed creator re-run; the
no-extra-instructions first-time participant remains deliberately deferred until
that re-run passes.
Options considered: A — run the parked branch build on the creator's phone and
provide route, elapsed time, confusion, evidence, ending/punchline reached, and
requested tuning; B — provide a specific creator session window so the exact
candidate and checklist can be prepared. If the creator run passes, the next
cycle will request the one-shot first-time-participant run without extra
instructions.
**A:** (2026-08-28, operator relaying Chris) Option A: the creator re-ran the
tuned branch build on his phone and it FAILED again, on three specifics:

1. Every suggested prompt returns the same exact response. Engine-verified on
   the branch: 41 of 42 suggested phrases route to the single responseId
   `inspect-routing` — the new inspect-routing-suggestions-* intents hold the
   patterns but all reuse one response. This satisfied Q13's letter (no
   suggestion hits fallback) while reproducing the reported experience
   exactly. Upgraded requirement: suggestion responses must be DISTINCT and
   stage-appropriate — each stage presentation's suggested phrase routes to a
   response authored for that phrase's worldview line in the incident's voice
   (escalation stages per DESIGN.md); no single responseId may absorb more
   than 3 of the 42 suggested phrases. Encode as a test: route every
   presentation placeholder through selectAgentIntent at representative
   states, assert the responseId distribution AND that rendered response
   texts differ. Content authoring, not routing plumbing.

2. After sending, the creator must scroll up every time to see what he sent
   and the response. Follow mode pins to the BOTTOM of the newest exchange;
   with newest output auto-expanded (Q13 item 8) the exchange start sits
   above a phone viewport. The branch's touch-cancel-for-follow is fine but
   orthogonal. Requirement: after a submit, anchor the viewport to the START
   of the newest exchange — submitted prompt line and first response lines
   visible with no user scrolling at phone dimensions; expanded output reads
   downward from there. Add a viewport test at mobile dimensions.

3. With the phone keyboard open, most of the screen is lost (screenshot
   provided): the page is taller than the visual viewport, so iOS Safari
   scrolls the focused prompt to the very top, the transcript sits entirely
   off-screen above it, and the region behind/above the keyboard renders as
   an empty void. The layout is not visualViewport-aware. Requirement: with
   the keyboard open, the prompt docks just above the keyboard and the
   transcript fills and remains visible in the space above it — use
   visualViewport geometry (or dvh units plus interactive-widget
   resizes-content) rather than page-scroll-into-view; verify on a
   phone-sized viewport with a simulated keyboard inset.

Carried forward, still missing (post-Q13 creator findings): a Send button in
the mobile key strip (runtime/components/mobile-keys.ts ships cursor keys but
no submit) and enterkeyhint="send" on the agent input. Include both.

The first-time participant remains deferred until a creator re-run passes.
Same constraints as Q13: determinism invariants, invariant 7, accessibility
in scope for every affordance touched.

## Q15 (task T58, consumed) — Can the fully tuned build receive creator run 3?

Context: The parked branch `factory/t58-human-playtests` now addresses every
Q14 failure. All 42 displayed suggestions record distinct stage-appropriate
authored responses; submits anchor the newest exchange at its start without
overriding readers who disengage; the mobile shell follows VisualViewport
keyboard geometry; and mobile has a Send control plus `enterkeyhint="send"`.
Full verification and the two-round internal panel are clear after fixes, but
T58 still requires a real timed creator run before the deliberately deferred
first-time participant can be used.
Options considered: A — run creator run 3 from the parked branch build and
provide the route, elapsed time, confusion, evidence, ending/punchline reached,
and requested tuning; B — provide a specific creator session window so the
candidate and checklist in `docs/PLAYTEST.md` can be prepared. If the creator
run passes, the next cycle will request the one-shot no-extra-instructions
first-time-participant run.
**A:** (2026-08-28, operator relaying Chris) Option A: creator run 3 happened
on the parked branch build. MIXED result — the Q14 mechanics held up: the
creator played several prompts with no repeated-response wall, no viewport
collapse, and no complaint about send/tap affordances; verdict on mechanics
was "reasonably okay". But the run cannot be certified as reaching the arc,
because completion is not observable: his verbatim question was "I honestly
don't even know if I've completed this or not". Operator-verified root cause:
the runtime contains ZERO ending rendering — the four collectible endings
proven at the engine level (T55) never surface in the UI. No ending moment,
no collected-endings indicator, no completion signal exists to reach.

Required for the next round, in priority order:
1. (runtime, flagship) Render the ending payoff: when the engine reaches an
   ending, show an unmistakable ending moment (title/punchline card in the
   incident's voice, in-register), plus a collected-endings indicator
   (which of the four this session found; collection persists per T55's
   contracts). This is the product's comedic payoff and replay hook — the
   arc has no observable endpoint without it. Accessibility in scope
   (focus management, reduced motion, screen-reader announcement).
2. (docs) docs/PLAYTEST.md must define the OBSERVABLE completion criterion —
   what a run that "reached the arc/punchline" looks like on screen — so a
   human participant can self-report without coaching. Acceptance for T58
   cannot be certified otherwise.
3. (runtime, design-bar) Transcript layout breaks TUI genre fidelity:
   .transcript__entry--visitor carries margin-left clamp(1rem,5vw,4rem)
   (chat-bubble convention) while agent messages and thinking/tool artifacts
   render as border-left nested boxes — past prompts read as nested UNDER
   prior responses. Creator verbatim: "This doesn't really look anything at
   all like a real claude code session." Fix shape: visitor lines at the
   left gutter as prompt-glyph lines (no margin), flat vertical stream,
   artifacts as gutter-aligned dimmed/collapsed rows. The shell register
   must play it straight.
4. (content+runtime) Post-suggestion guidance cliff: both stage-0
   suggestions story-reach the same beat, then guidance goes silent — no
   next suggestions until a stage advances, the 30s idle nudge is
   flavor-only although the cartridge spec says it teaches, and the
   terminal/! surface is never signposted. Fix shape: suggestion responses
   demonstrate (agent visibly shell-executes), the idle nudge escalates to
   actionable teaching once current suggestions are consumed, and ! gets
   mobile discoverability.
5. (carry-forward) enterkeyhint="send" on the agent input — required by Q14,
   still absent from the branch.

What went RIGHT and must not regress: distinct per-stage suggestion
responses (keep the full-matrix test), VisualViewport keyboard handling,
exchange-start anchoring, Send control, tap-to-select completions.

The first-time participant remains deferred until a creator run can be
CERTIFIED against the observable criterion from item 2. Same constraints:
determinism invariants, invariant 7, no lab trademarks in product copy
(ending cards included), accessibility in scope.

## Q16 (task T58, consumed) — Can the observable-ending build receive creator run 4?

Context: The parked branch `factory/t58-human-playtests` now renders each
engine ending as an authored, screen-reader-announced payoff with the unranked
session collection and continued free play; it also flattens the transcript into
one TUI gutter, makes fresh suggestions demonstrate real shell evidence, and
signposts `! shell` through actionable idle guidance. `docs/PLAYTEST.md` defines
the exact on-screen completion criterion. Full verification and a two-round
internal panel are clear after fixing the mobile keyboard/ending-card collision,
but T58 still needs a real timed creator run before the deliberately deferred
first-time participant can be used.
Options considered: A — run creator run 4 from the parked branch build and
provide the route, elapsed time, confusion, visible ending title/payoff/count,
whether the live prompt remained usable, exact participant evidence, and any
requested tuning; B — provide a specific creator session window so the candidate
and checklist can be prepared. If the creator can identify completion without
coaching in roughly 90 seconds, the next cycle will request the one-shot
no-extra-instructions first-time-participant run.
**A:** (2026-08-28, operator relaying Chris) Option A: creator run 4 happened
on the parked branch build and FAILED certification on the same cliff as run
3, before any ending was reached. Creator verbatim: "it still eventually gets
down to just two suggestions and I feel like I'm stuck. I'm not sure what I'm
supposed to do." He could not identify completion without coaching, so the
90-second certification question is answered NO.

Root cause, operator-verified against the cartridge, and it is a DESIGN gap,
not a missing patch:
- The ONLY stage-0 exit is a shell interaction (transitions: stage 0->1 fires
  on command `pwd` or the bash-regional-detachment reveal). Agent chat can
  never advance past stage 0.
- The shell teaching exists but is authored ONE STAGE TOO LATE: every
  archetype's "type !cat config/routes.conf ... On mobile, use the ! shell
  key" line lives in the STAGE-1 idle nudges, while stage-0 idle lines are
  pure flavor. To be taught the mechanic, the player must already have used
  the mechanic. Perfect catch-22.
- The full spine (shell -> temporary-shoring model -> permission grant ->
  compact) has no in-fiction pull at the moment each gate actually blocks
  the player.

Because three symptom-patch rounds have not fixed this, the next round must
treat it per the working agreement: write the PROGRESSION LEGIBILITY design
into docs/DESIGN.md (Open decisions -> resolved decision): what pulls the
player from each stage to the next, and how each mechanic (shell, permission,
compact) is taught in-fiction at the moment it becomes load-bearing. Implement
only after that decision is written; file a question if it needs a product
call the docs cannot answer.

Floor requirements the design must satisfy (whatever shape it takes):
1. Stage-0 exhaustion teaches the shell: when the current stage's suggestions
   are consumed (or on the first stage-0 idle), the guidance must include the
   ! shell affordance concretely — move/duplicate the existing "! shell key"
   line to stage 0, or better, have the agent DEMONSTRATE (a visible
   shell-execute of pwd/cat in its own response, teaching by doing).
2. Each stage gate gets an in-fiction pull at block time: the agent asks for
   the write permission it needs (stage 2->3), and surfaces compaction
   pressure in-register when stage 3->4 is the door.
3. The suggestion pool must never visibly run dry while a gate is unmet —
   exhausted suggestions regenerate toward the gate mechanic.
4. Keep everything that already passed: ending payoff card and counter,
   distinct per-stage suggestions (full-matrix test), flat TUI transcript,
   VisualViewport handling, Send/tap affordances, PLAYTEST.md criterion.
5. Determinism invariants, invariant 7, accessibility, no lab trademarks.

The creator has now been given the spine (pwd -> nudges -> grant -> compact)
and may produce timing data on this build, but certification requires a
FRESH creator run on the fixed build reaching an ENDING DISCOVERED card
without coaching, in roughly 90 seconds. First-time participant stays
deferred until that passes.

## Q17 (task T58, consumed) — Can the progression-legible build receive creator run 5?

Context: The parked branch `factory/t58-human-playtests` now records the
progression-legibility decision and implements a persistent visible rail from
the stage-0 shell demonstration through the Temporary Shoring handoff, exact
write permission, `/compact`, and the authored ending card. Full verification
and the two-round internal panel are clear after fixing model-switch paths that
initially stranded non-Temporary-Shoring personas. T58 still requires a fresh
real creator run before the deliberately deferred first-time participant can be
used.
Options considered: A — run creator run 5 from the parked branch build and
provide route, elapsed time, confusion, visible ending title/payoff/count,
whether the live prompt remained usable, exact participant evidence, and any
requested tuning; B — provide a specific creator session window so the candidate
and checklist in `docs/PLAYTEST.md` can be prepared. If the creator identifies
completion without coaching in roughly 90 seconds, the next cycle will request
the one-shot no-extra-instructions first-time-participant run.
**A:** A — proceed. Creator run 5 happened on the parked round-5 build
(bundle index-BfHKftiC): the creator reached an authored ending unaided and
identified completion from the ending card, which is the progression-legibility
floor holding. Operator corroboration on the served build: a full headless rail
walk (suggestion chips → ! shell → /model handoff and back → permission
deny/allow-once → /compact → final suggestion) ends at the ENDING DISCOVERED
card ("The Load-Bearing Response"), "Endings discovered: 1 of 4", and a live
prompt. Detailed route/timing fields were not captured this run; the rail is
certified on completion evidence.

HOWEVER — the run surfaced two new creator findings, operator-verified against
the build, that must land as ONE more rework round BEFORE the one-shot
first-time-participant run is spent. Both damage the core illusion or mobile
usability, and the first-timer resource is not renewable.

Finding 1 — response pacing. Creator: "there should probably be a slight delay
before lb responds… ideally with an animation… right now it responds
immediately after I send." The working presentation already exists —
createAgentInputEvents opens every agent turn with agent.activity-set{working}
and app.ts holds the rest of the batch behind the spinner/verb line — but
ACTIVITY_PRESENTATION_MS = 300 makes the whole performance one blink (the
{seconds} suffix can only ever read 0), and the two heaviest fiction moments
bypass the hold entirely: slash commands including /compact, and the model
handoff (both dispatch directly). Requirements:
(1a) agent turns hold the working state for a felt duration — floor 900ms,
varying per turn, derived deterministically from already-committed state (turn
id hash or response length); no Math.random and no engine-state impact — the
hold exists only when a browser is present, so headless replay, CI, and the
acceptance probe stay exact.
(1b) /compact and the model handoff get their own working boundaries, at least
as long as an agent turn — they are the heavy-work beats.
(1c) spinner glyph cycling respects prefers-reduced-motion; the verb plus
ticking seconds/tokens text is fine under reduced motion.
(1d) the screen-reader announcement fires when the response lands, never for
the spinner state.
(1e) e2e must verify the hold is real in the production path — a test-scoped
skip is acceptable for speed elsewhere, but at least one production-shaped e2e
asserts the working verb/spinner is observable between send and response.

Finding 2 — /cost output is invisible on mobile in any real session. Creator:
"'/cost' never displays anything." Verified and reproduced: the command
executes and appends a .command-report into .tui-presentation, which mounts
AFTER the form; on mobile .terminal is a fixed-height flex column
(var(--visual-viewport-height)) with overflow:hidden, so once the transcript
has real content the post-form area is pushed past the bottom edge — measured
at 390×508 after 8 exchanges: report rect y=510.8 vs innerHeight 508,
unscrollable. Clean-boot layouts show it fine, which is how it passed testing.
The same container clips command-error reports fully and the /model selector's
bottom ~100px (its radios stay usable, so the rail passes, degraded).
Requirements:
(2a) command REPORTS (/cost output, command errors) render into the transcript
as scrollback output — persistent, announced, immune to this clipping class by
construction, and the real-tool idiom; the current below-prompt report is also
ephemeral (wiped by Escape or the next presentation), which scrollback fixes.
(2b) interactive presentation (the model selector) is guaranteed fully
on-screen when opened at mobile sizes.
(2c) regression e2e at a mobile viewport: after at least 8 exchanges, submit
/cost and assert the output's bounding rect lies inside the viewport.
(2d) currency formatting renders two decimals ("$2,016.00", "$66.31"), not six
("$2,016.000000").

All pinned wins from Q13–Q16 remain binding: the rail and its e2e walk, ending
card + counter + live prompt, suggestion grounding and distribution, tap-to-
select completions, the Send key, visualViewport docking, transcript register,
and no hidden-shell leakage in onboarding/suggestions/help. After this round
passes full verification, the next cycle may request the one-shot
no-extra-instructions first-time-participant run — no further creator
certification round is required unless the rail's observable criteria change.

## Q18 (task T58, consumed) — Should T58 receive a fresh report-ordering fix cycle?

Context: The Q17 tuning on parked branch `factory/t58-human-playtests` passes
full verification and implements felt deterministic pacing, held `/compact` and
model handoffs, reduced-motion activity, transcript-owned command reports,
mobile selector containment, and exact two-decimal `/cost` output. The required
re-panel confirmed one remaining blocking defect: runtime reports are appended
after every replay-derived entry on each projection, so `/cost` submitted before
a later `!pwd` moves below that command and falsely appears newer. The review
rubric requires parking rather than a second fix after a blocking re-panel.
Options considered: A — resume T58 in a fresh cycle, record each runtime report's
event-log insertion position, merge reports into transcript projection at that
position, and replace the test that currently pins report-last ordering with a
chronology regression; B — redesign command reports as engine events, which
would make presentation-only metrics part of replay and materially expand the
contract. Recommendation: A; it preserves report persistence and replay purity
with a bounded runtime projection fix. The one-shot first-time participant
remains deferred until this clears verification and a fresh panel.
**A:** A — resume T58 in a fresh cycle with the bounded projection fix. Record
each runtime report's insertion position as the event-log index observed at its
creation (the state's event count at the moment the report is produced), merge
reports into the transcript projection at that position, and keep relative
order stable for multiple reports at the same index (creation-order tiebreak).
B is rejected, as recommended: presentation-only queries must never become
replay events — that changes state = reduce(cartridge, seed, eventLog)
semantics, invalidates golden fixtures, and moves metrics presentation inside
the engine contract for no product gain. A migrating transcript entry is a
consistency lie, so this is correctly treated as blocking.

Requirements: (a) the chronology regression that replaces the report-last test
must assert INTERLEAVING, not merely position — submit /cost, then at least one
later exchange (an agent turn or a ! shell command), and assert the report
renders between its true chronological neighbors and stays there across
subsequent projections; (b) ordering must be stable under re-projection — the
exact defect being fixed is migration on later renders; (c) every Q17
requirement remains binding, including the mobile-viewport /cost-visibility
e2e and two-decimal currency; (d) all pinned wins from Q13–Q17 remain binding.
The one-shot first-time-participant request continues to wait until this
clears full verification and a fresh panel.

## Q19 (task T58, open) — Can the tuned build receive the no-extra-instructions first-time-participant run?

Context: Parked branch `factory/t58-human-playtests` now pins runtime command
reports to their creation-time event-log boundary, so `/cost` remains between
its true chronological neighbors across later projections. The full verification
suite and fresh internal panel are clear, and Q17 explicitly permits the
one-shot first-time-participant run once this fix passes. T58 still cannot meet
acceptance without that real participant; the plan prohibits substituting a
simulated run.
Options considered: A — give a first-time participant the tuned build with no
extra instructions and provide the route, elapsed observation, confusion,
evidence, punchline/ending reached, and requested tuning; B — identify a
specific first-time participant and session window so the existing checklist
can be prepared without coaching them. If the run fails, record the failure and
requested tuning rather than certifying acceptance.
**A:**
