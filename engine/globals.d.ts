/**
 * The one host global the engine is allowed to see.
 *
 * The engine's program is deliberately `lib: ["ES2022"]` with `types: []`, so
 * it has no `document`, no `window`, no `fetch`, no `Buffer` — that isolation
 * is what invariant 3 buys, and `engine/testing/README.md` explains why adding
 * `"DOM"` to `lib` would throw it away to get one function.
 *
 * `structuredClone` is declared here instead, because it is the only general
 * answer to a question the serializer has to answer: *is this value really
 * plain data?* A prototype can be re-pointed, so `Object.getPrototypeOf` can
 * be lied to. Internal slots cannot, and structured clone reads them — it
 * either refuses the value outright or hands back a copy wearing the true
 * prototype. Every other approach is an enumeration of named built-ins, which
 * is incomplete by construction: it misses whatever was added to the language
 * most recently, and cannot name the constructors the purity gate itself bans.
 *
 * The signature is narrowed to what `canonical.ts` uses. The real one takes a
 * `transfer` option that detaches its input, which is a mutation of the
 * caller's data and has no business anywhere near a serializer.
 *
 * Available in every target: Node 17+ and all current browsers.
 */
declare function structuredClone<T>(value: T): T;
