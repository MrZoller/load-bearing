# Spec: Phase 0 issue-tracker backlog

## Problem

Phase 0 work is already specified and prioritized in the repository's GitHub
issues. Maintaining a second prose specification would duplicate that source of
truth and allow the factory plan to drift from tracker decisions.

## Outcome

The factory executes the open `phase-0` issues as independently tracked plan
tasks, preserving their acceptance criteria, semantic prerequisites, and issue
linkage through merge.

Spec = the issue tracker for MrZoller/load-bearing; imported 2026-08-19; filter: phase-0

## Scope

### In

- Open GitHub issues carrying the `phase-0` label.
- Acceptance, prerequisites, and scope boundaries recorded in each imported
  issue.
- A rolling task that batches minor review findings parked during delivery.

### Out

- Unlabeled and non-`phase-0` issues, because this import is intentionally
  limited to the Phase 0 milestone.
- Reinterpretation of existing imported tasks during later syncs; the committed
  plan remains the execution record.
- New work discovered while delivering the Phase 0 exit issue; issue #14
  requires such gaps to become separate tracker issues.

## Acceptance criteria

1. Every open issue carrying the `phase-0` label at import is represented once
   in the plan with `Fixes #N` linkage.
2. Each imported task retains testable acceptance distilled from its issue and
   only the prerequisites explicitly established by the issue body.
3. Delivery satisfies the acceptance criteria and scope boundaries in the
   linked issue before its task is completed.
4. A changed backlog cannot run until the imported plan is explicitly approved.

## Standing decisions (Phase 0)

Recorded 2026-08-20 after Q1-Q4 all resolved to the same answer. These exist
so a task does not stop the line to re-ask a question already settled.

1. **World facts are cartridge content.** When a task finds the schema lacks a
   field its issue requires - acting identity, directory metadata, git
   authorship, machine metadata, endpoints - ADD the field to
   `content/schema/` with a documented default and explain the choice in the
   PR. Do not park the task, and do not hardcode the fact in the engine. This
   is invariant 1 applied; Q1, Q2, Q3, and Q4 each resolved this way.
2. **Bounded CLI surface.** Implement exactly the commands and flags the issue
   names, with real-tool semantics and no surface beyond it. Conventions -
   output formats, locales, timezone, hash abbreviation width, argument arity -
   are not design questions. Take the real tool's behavior.
3. **Deliberate deviations from the real tool are permitted, but must be
   recorded** in `docs/DESIGN.md` in the same PR, with the reason. Two already
   stand: committed-tree blame (T6) and `history` not listing itself (T7).
4. **Still stop and ask** when a choice would weaken an invariant, change a
   merged contract other tasks depend on, or commit the product to a
   user-visible behavior its issue does not imply. The bar is a decision that
   is genuinely the human's, not an absent schema field.

## Risks & constraints

- The engine remains deterministic, headless, runtime/content separated, and
  free of runtime dependencies as required by `CLAUDE.md` and the issue set.
- Generated schemas and replay fixtures are contracts and change only through
  their repository update scripts with reviewed diffs.
- The issue tracker may change after import; `/backlog` syncs append or close
  tasks without rewriting the execution record.

## Open questions

None.
