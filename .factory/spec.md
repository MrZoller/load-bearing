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

## Risks & constraints

- The engine remains deterministic, headless, runtime/content separated, and
  free of runtime dependencies as required by `CLAUDE.md` and the issue set.
- Generated schemas and replay fixtures are contracts and change only through
  their repository update scripts with reviewed diffs.
- The issue tracker may change after import; `/backlog` syncs append or close
  tasks without rewriting the execution record.

## Open questions

None.
