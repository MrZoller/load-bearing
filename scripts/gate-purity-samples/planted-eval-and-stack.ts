// Sample: two ways to smuggle nondeterminism past a gate that blanks string
// literal text. Dynamic evaluation turns the blanked text back into code, and
// an error's stack carries the host engine's formatting and the developer's
// filesystem paths. Violates invariant 2 on purpose.
export function smuggle(): unknown {
  const drawn = eval("Math.random()");
  const stamped = new Function("return Date.now()")();
  return { drawn, stamped, where: new Error().stack };
}
