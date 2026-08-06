// Sample: a violation in a .tsx file. An extension the gate does not scan is
// worse than one it scans and clears — it reports the tree clean without ever
// opening the file. Violates invariant 2 on purpose.
export function jitter(): number {
  return Math.random();
}
