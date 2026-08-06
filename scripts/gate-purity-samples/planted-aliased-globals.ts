// Sample: banned globals reached through an alias or a member the earlier
// call-shaped rules did not enumerate. Each is the same leak with an extra
// step. Violates invariants 2 and 3 on purpose.
export function indirection(): unknown {
  const schedule = setTimeout;
  const origin = performance.timeOrigin;
  const entropy = crypto.subtle;
  const bytes = Buffer.alloc(4);
  return [schedule, origin, entropy, bytes, __dirname];
}
