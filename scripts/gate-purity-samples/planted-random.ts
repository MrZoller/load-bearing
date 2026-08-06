// Sample: unseeded randomness. Violates invariant 2 on purpose.
export function unluckyDraw(): number {
  return Math.random();
}
