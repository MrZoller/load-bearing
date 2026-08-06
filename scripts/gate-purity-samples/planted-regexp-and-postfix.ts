// Sample: two reads that do not name a banned global at the point of use. The
// first divides by a wall-clock read immediately after a postfix `++`, which a
// naive regex-versus-division heuristic blanks straight through; the second
// reads RegExp's realm-wide last-match state. Violates invariant 2 on purpose.
export function subtle(x: number, text: string): unknown {
  const rate = x++ / performance.now() / 2;
  const { stack } = new Error();
  return text.match(/a(b)/) ? [rate, RegExp.$1, stack] : [rate];
}
