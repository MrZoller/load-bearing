// Sample: a violation sitting after a URL on the same line. The `//` inside the
// string must not be mistaken for a comment, or everything after it would be
// blanked and the violation missed.
export function pick(url: string): number {
  return url === "https://example.test/a" ? 0 : Math.random();
}
