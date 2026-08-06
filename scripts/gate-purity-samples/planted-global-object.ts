// Sample: ambients reached through globalThis with string property names.
// The gate blanks string literal text, so no banned identifier appears in the
// code view at all. Violates invariants 2 and 3 on purpose.
export function sneak(): unknown {
  const now = globalThis["Date"].now();
  const build = Function;
  return [now, build("return 1")()];
}
