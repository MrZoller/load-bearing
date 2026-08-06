// Sample: Math reached indirectly, and Math members the spec leaves
// implementation-approximated. Violates invariant 2 on purpose.
export function drift(x: number): number {
  const { random } = Math;
  const alias = Math;
  return random() + Math.tan(x) + alias.pow(x, 2);
}
