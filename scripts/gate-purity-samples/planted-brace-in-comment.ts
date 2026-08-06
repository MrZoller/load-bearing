// Sample: a stray closing brace inside a template interpolation, once in a
// comment and once in a regex literal. A scanner that counted those braces
// would end the interpolation early and blank the real expression after it.
// Violates invariant 2 on purpose.
export function drift(input: string): string {
  const a = `${/* } */ Math.random()}`;
  const b = `${input.replace(/}/g, String(Date))}`;
  return a + b;
}
