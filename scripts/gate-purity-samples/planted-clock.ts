// Sample: wall-clock reads. Violates invariant 2 on purpose.
export function stamp(): string {
  const started = Date.now();
  const at = new Date(started);
  return `${at.toISOString()} after ${performance.now()}ms`;
}
