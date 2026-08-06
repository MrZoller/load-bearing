// Sample: output that varies with the host's locale, and behaviour that
// varies with garbage-collection timing. Neither mentions a banned global.
// Violates invariant 2 on purpose.
export function render(names: string[], size: number, held: WeakRef<object>) {
  const sorted = names.sort((a, b) => a.localeCompare(b));
  const pretty = size.toLocaleString();
  const stamp = new Intl.DateTimeFormat().format(0);
  return { sorted, pretty, stamp, live: held.deref() !== undefined };
}
