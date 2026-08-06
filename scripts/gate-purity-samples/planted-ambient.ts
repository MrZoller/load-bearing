// Sample: nondeterminism and ambient state that need no import, which is what
// makes them the easy accidents. Violates invariants 2 and 3 on purpose.
export function newSessionId(): string {
  const id = crypto.randomUUID();
  if (process.env.DEBUG) setTimeout(() => undefined, 0);
  return id;
}
