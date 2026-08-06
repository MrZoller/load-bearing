# Purity gate samples

Fixtures for `scripts/gate-purity.test.mjs`. The `planted-*.ts` files break the
engine's invariants **on purpose** so the gate can be proven to catch them with
the right file and line; `clean.ts` proves the gate does not fire on prose in
comments.

Nothing here is imported by the engine, the runtime, or any build. The gate's
default scan covers `engine/` only, so these files are never scanned outside
their own test.

Do not "fix" the violations in this directory. Fixing them silently disables
the test that proves the gate works.
