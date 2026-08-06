// Sample: a test file with a violation in it. Test files are exempt, and
// widening the scan to .tsx must not accidentally start scanning them.
export function fixtureNoise(): number {
  return Math.random();
}
