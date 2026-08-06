// Sample: a Node built-in imported through a no-substitution template literal.
// Valid syntax, and prettier does not rewrite it to quotes, so a quote-only
// specifier pattern let it through the whole pipeline. Violates invariant 3 on
// purpose.
export async function load(): Promise<unknown> {
  return import(`node:fs`);
}
