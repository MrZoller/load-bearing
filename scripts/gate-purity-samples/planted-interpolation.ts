// Sample: a violation inside a template interpolation. Blanking string literal
// text must not blank the expressions embedded in it. Violates invariant 2 on
// purpose.
export function stamped(label: string): string {
  return `${label} at ${Date.now()}`;
}
