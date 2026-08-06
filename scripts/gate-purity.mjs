#!/usr/bin/env node
/**
 * The purity gate.
 *
 * Invariants 2, 3, and 6 are the ones a plausible-looking commit breaks
 * quietly: one `Date.now()` for a "harmless" duration, one `fetch` to "handle
 * an edge case", one `node:fs` import that makes the engine stop running in a
 * browser. Code review catches those unreliably; a grep with teeth catches
 * them every time. This script is that grep, and it fails the build.
 *
 * It scans non-test sources under `engine/` and reports `file:line:column` for
 * every hit.
 *
 * ## What it looks at
 *
 * Comments, string and template literal *text*, and regex literals are blanked
 * before the identifier rules run — so a doc comment about `Date.now`, and the
 * `"Date:   "` column header that simulated `git log` output will need, are
 * both fine. Template *interpolations* survive: `` `${Date.now()}` `` is
 * caught, which is the only thing inside a template worth catching.
 *
 * Import specifiers are strings, so the module-specifier rule reads a second
 * view of the file with strings left intact — and cross-checks the first, so
 * that `const example = 'import "node:fs"'` is not read as an import.
 *
 * The one known gap is a regex literal immediately following a keyword
 * (`return /a\/\/b/`), which the "is this a regex or a division" heuristic
 * reads as division. Assign such regexes to a constant.
 *
 * The rules ban whole globals rather than call sites — `Date`, not `Date.now`;
 * `fetch`, not `fetch(`. `const later = Date` and `const f = fetch` are the
 * same leak with an extra step.
 *
 * `Math` is the one inversion: an allowlist of its exactly-specified members,
 * because the engine genuinely needs `floor` and `max` while `random` and the
 * implementation-approximated transcendentals have to go.
 *
 * ## Adding an allowlist entry
 *
 * Don't, if there is any alternative. If there genuinely is not, add an entry
 * to `ALLOWLIST` with a reason that would satisfy a reviewer six months from
 * now. Entries that point at a missing file, or that suppress nothing, fail
 * the gate — an allowlist that rots is worse than no allowlist.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root, derived from this file's location. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories scanned when no roots are given. */
export const DEFAULT_ROOTS = ["engine"];

const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "__fixtures__"]);

/**
 * Files the gate treats as tests and does not scan.
 *
 * Exported because `vitest.config.ts`'s `include` globs have to cover exactly
 * this set. A file this pattern skips that Vitest also misses would be neither
 * purity-checked nor executed — a regression test that silently never runs.
 */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Patterns matched against the `code` view from `prepareSource` — comments,
 * string literal text, and regex literals already blanked.
 *
 * `Date` is banned as a whole global rather than just `Date.now`: `new Date()`,
 * `Date.parse`, and a stashed `const D = Date` are the same leak, and the
 * engine has a simulated clock for every legitimate use.
 */
export const CODE_RULES = [
  {
    // An allowlist rather than a ban on `random`, for two reasons. Aliasing:
    // `const { random } = Math` and `Math["random"]()` reach the same unseeded
    // generator without ever spelling `Math.random`. And approximation: the
    // spec leaves `sin`, `cos`, `tan`, `pow`, `exp`, `log`, `hypot`, and
    // `cbrt` implementation-defined, and V8 and JavaScriptCore genuinely
    // disagree — `Math.tan(1e300)` differs in the last two digits between
    // Node and Safari, which invariant 3 requires the engine to run on both
    // of.
    //
    // The allowlist is drawn from what the *spec* pins, not from what engines
    // happen to agree on today. `sqrt` is deliberately absent: IEEE 754
    // requires it to be correctly rounded and every real engine defers to the
    // hardware, but ECMA-262 still calls it implementation-approximated, which
    // is the same sentence that disqualifies `cbrt`. Nothing in a terminal
    // simulation needs a square root, so the cheap answer is to not have the
    // argument.
    id: "math-nondeterministic",
    pattern:
      /\bMath\s*\.\s*(?!(?:abs|ceil|floor|round|trunc|sign|min|max|imul|clz32|fround|PI|E|LN2|LN10|LOG2E|LOG10E|SQRT2|SQRT1_2)\b)\w*/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Only the exactly-specified members of Math are allowed. `random` is unseeded — " +
      "draw from the engine's seeded PRNG. The transcendentals are implementation-" +
      "approximated and differ between JS engines, so they cannot survive replay across " +
      "browsers.",
  },
  {
    // The half that closes aliasing without enumerating its spellings: any
    // mention of `Math` that is not an immediate dotted access.
    id: "math-alias",
    pattern: /\bMath\b(?!\s*\.)/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Reference Math members directly. Aliasing, destructuring, or computed access " +
      '(`const { random } = Math`, `Math["random"]`) routes around the member allowlist.',
  },
  {
    // The gate blanks string literal text, which is what makes simulated shell
    // output cheap to write — and exactly what makes dynamic evaluation a hole
    // in it. `eval("Math.random()")` turns ignored text back into running
    // code, so the two primitives that can do that are banned outright.
    // `Function\s*\(` rather than a bare `Function` so a `: Function` type
    // annotation is not a violation.
    id: "dynamic-eval",
    pattern: /\beval\b|\bFunction\b|\.\s*constructor\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Dynamic evaluation resurrects string contents as code, which the gate blanks " +
      "and therefore cannot check. Whatever it would build, build it directly. `Function` " +
      "is banned as a whole identifier, aliases included — and as a type it should be a " +
      "call signature anyway. `.constructor` goes with it: `(() => {}).constructor` is " +
      "the Function constructor without ever spelling its name.",
  },
  {
    // Property names are strings, and the gate blanks string literal text, so
    // `globalThis["Date"].now()` reaches wall-clock time with no banned
    // identifier anywhere in the code view. A headless engine has no reason to
    // touch the global object at all.
    id: "global-object",
    pattern: /\bglobalThis\b/g,
    invariant: "3 — the engine stays headless",
    message:
      "Reaching an ambient through globalThis routes around every rule here, because " +
      "the property name is a string and string contents are blanked. The engine's " +
      "inputs are the cartridge and the event log.",
  },
  {
    // Stack strings carry the host engine's formatting, file URLs or absolute
    // paths, and line numbers — different in Node, Chrome, and Safari, and
    // different again on another machine.
    id: "error-stack",
    pattern:
      /\.\s*stack\b|\bcaptureStackTrace\b|\{[^{}]*\bstack\b[^{}]*\}\s*=/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "An error's stack is host-formatted and machine-specific, so recording one puts " +
      "the developer's filesystem into replayed state. Normalize errors to declared " +
      "fields before they reach engine output.",
  },
  {
    // `RegExp.$1`, `lastMatch`, and `input` reflect the most recent successful
    // match *anywhere in the realm*, including work that ran before replay
    // began. Ordinary regex use is untouched — `new RegExp(…)` is a
    // construction, not a static read.
    id: "regexp-statics",
    pattern: /\bRegExp\s*\./g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "RegExp's legacy statics carry the last match made anywhere in the realm, so " +
      "identical replay inputs can read different values depending on what ran first. " +
      "Capture from the match result instead.",
  },
  {
    // ECMAScript does not standardize the text built-ins put in an error, so
    // `JSON.parse`'s complaint about the same malformed cartridge differs
    // between V8, JavaScriptCore, and SpiderMonkey. Reading one into state or
    // a transcript makes replay depend on which engine ran it.
    id: "host-error-message",
    pattern: /\.\s*message\b|\{[^{}]*\bmessage\b[^{}]*\}\s*=/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "A built-in's error text is host-specific and unversioned. Attach the original as " +
      "`cause` and write your own message from values the engine controls.",
  },
  {
    // Identifier escapes are valid JavaScript and resolve to the same binding:
    // `D\u0061te.now()` is `Date.now()`. Every rule here matches raw text, so
    // one escape would route around all of them at once. Strings, templates,
    // regexes, and comments are already blanked from this view, so a surviving
    // backslash-u is in an identifier and has no legitimate use.
    id: "identifier-escape",
    pattern: /\\u/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "An escaped identifier resolves to the same global while matching none of these " +
      "patterns, which would route around every rule at once. Spell identifiers plainly.",
  },
  {
    // A Proxy cannot be detected from inside the language, so the canonical
    // serializer cannot refuse one — reflecting over it already runs its traps.
    // Stopping the engine from *creating* one is the enforceable half, and the
    // realistic one: a proxy in engine state would have to come from engine
    // code, since cartridges arrive as JSON. `Reflect` goes with it as the
    // other half of the metaprogramming pair.
    id: "proxy-reflection",
    pattern: /\bProxy\b|\bReflect\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "A Proxy runs user code during the reflection the serializer performs, so the same " +
      "state could record differently on consecutive calls — and no in-language check can " +
      "detect one. Engine state is inert plain data.",
  },
  {
    // `import.meta.url` is a local filesystem URL in Node and a deployed
    // module URL in a browser. Anything derived from it that reaches state or
    // a transcript makes replay depend on where the code happens to live.
    id: "import-meta",
    pattern: /\bimport\s*\.\s*meta\b/g,
    invariant: "3 — the engine stays headless",
    message:
      "import.meta describes where the module was loaded from, which differs between " +
      "Node, a browser, and a bundle. The engine's inputs are the cartridge and the " +
      "event log.",
  },
  {
    // `Atomics.isLockFree(8)` is explicitly implementation- and
    // platform-dependent, and `SharedArrayBuffer` availability depends on the
    // host's cross-origin isolation. Both typecheck under ES2022.
    id: "host-capability",
    pattern: /\bAtomics\b|\bSharedArrayBuffer\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "These report what the host is capable of, which is exactly the thing replay may " +
      "not depend on — the spec lets `Atomics.isLockFree(8)` differ by platform.",
  },
  {
    id: "gc-timing",
    pattern: /\b(?:WeakRef|FinalizationRegistry)\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Garbage-collection timing is not reproducible, so branching on `deref()` or a " +
      "finalization callback lets identical event logs reduce differently. WeakMap and " +
      "WeakSet are fine — they expose no iteration and no size, so GC is unobservable.",
  },
  {
    // No global to ban for the prototype methods, so the method names are the
    // only textual lever — and unlike `Date.now`, there is no deterministic
    // sibling being sacrificed.
    id: "locale-sensitive",
    pattern:
      /\b(?:Intl|toLocaleString|toLocaleDateString|toLocaleTimeString|localeCompare|toLocaleLowerCase|toLocaleUpperCase)\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Locale-sensitive formatting reads the host's locale, time zone, and ICU data, " +
      "none of which CI can pin — `localeCompare` sorts å before z in Swedish and after " +
      "it in German. Format and sort by hand; bare `sort()` is UTF-16 code-unit order " +
      "and is fine.",
  },
  {
    id: "crypto-random",
    pattern: /\bcrypto\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Web Crypto needs no import, which is what makes it the easy accident, and every " +
      "randomness-producing member of it draws on system entropy — `subtle.generateKey` " +
      "as much as `randomUUID`. Ids and shuffles come from the seeded PRNG.",
  },
  {
    id: "wall-clock-date",
    pattern: /\bDate\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "The Date global is wall-clock time. Read the engine's simulated clock instead.",
  },
  {
    id: "wall-clock-performance",
    pattern: /\bperformance\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "The performance global is wall-clock time — `timeOrigin` as much as `now()`. " +
      "Read the engine's simulated clock instead.",
  },
  {
    id: "wall-clock-timer",
    pattern:
      /\b(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Time in the engine advances by event, not by timer. Anything that needs to " +
      "happen later is an event that happens later.",
  },
  {
    id: "node-global",
    pattern: /\b(?:Buffer|__dirname|__filename|global|require)\b/g,
    invariant: "3 — the engine stays headless",
    message:
      "A Node-only global. It does not exist in a browser, and unlike a `node:` import " +
      "it arrives with no import line to notice.",
  },
  {
    // Banned as a whole identifier, not per member. An earlier version listed
    // members so that issue #7's simulated process model could name a local
    // `process` — but the members that model carries are `pid`, `ppid`,
    // `title`, `uptime`, which are exactly the ones a real leak would read.
    // Enumerating members re-creates the collision it was meant to avoid.
    // Engine code names simulated-process locals `proc` / `entry` / `row`;
    // shadowing a global is poor style regardless.
    id: "ambient-process",
    pattern: /\bprocess\b/g,
    invariant: "3 — the engine stays headless",
    message:
      "The engine reads no ambient environment, and `process` does not exist in a " +
      "browser. Everything the engine knows arrives through the cartridge and the " +
      "event log. Name simulated-process locals `proc` or `entry`.",
  },
  {
    id: "dom-global",
    pattern:
      /\b(?:document|window|navigator|localStorage|sessionStorage|jsdom|requestAnimationFrame|cancelAnimationFrame)\b/g,
    invariant: "3 — the engine stays headless",
    message:
      "Browser globals belong in /runtime. The engine must run in bare Node.",
  },
  {
    id: "network",
    pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/g,
    invariant: "6 — no runtime model calls",
    message:
      "The engine has no way to call anything. Simulated responses come from cartridge data.",
  },
];

/**
 * Node built-ins, as bare specifiers. The `node:` prefix is caught separately,
 * so both `import "fs"` and `import "node:fs"` are covered.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sqlite",
  "stream",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

export const SPECIFIER_RULE = {
  id: "node-builtin-import",
  invariant: "3 — the engine stays headless",
  message:
    "Node built-ins do not exist in a browser. The engine must run in both.",
};

/**
 * Rules matched against the *raw* source, before any blanking.
 *
 * Only for constructs that live inside a comment and mean something to the
 * compiler anyway — which in practice is the triple-slash directive. The
 * engine's own tsconfig sets `types: []` to keep Node's ambient globals out of
 * its program, and a single `/// <reference types="node" />` anywhere in that
 * program silently undoes it: TypeScript's global type scope is per-program,
 * not per-file, so one file's directive serves globals to every file.
 */
export const RAW_RULES = [
  {
    id: "ambient-types-reference",
    pattern: /\/\/\/\s*<reference\s+(?:types|lib|path|no-default-lib)\s*=/g,
    invariant: "3 — the engine stays headless",
    message:
      "A triple-slash reference changes what the whole program sees, per-file: `types` " +
      "loads ambient globals and undoes tsconfig.engine.json's `types: []`, and `lib` " +
      'restores a library the config deliberately left out — `lib="dom"` hands the ' +
      "engine `location`, `Worker`, and `indexedDB`. Move the code that needs them out " +
      "of the engine program.",
  },
];

/**
 * Files permitted to break a specific rule, each with the argument for why.
 *
 * @type {ReadonlyArray<{ file: string, rules: readonly string[], reason: string }>}
 */
export const ALLOWLIST = [
  {
    file: "engine/testing/fixtures.ts",
    rules: ["node-builtin-import", "import-meta"],
    reason:
      "Test infrastructure: reads committed golden-replay fixtures from disk for the " +
      "CI replay suite and the deliberate `npm run fixtures:update` re-record. It needs " +
      "`node:fs` to do that and `import.meta.url` to locate the fixture directory " +
      "relative to itself. It is never imported by simulation code — the " +
      "`allowlisted-module-import` rule enforces exactly that — and never reaches the " +
      "browser bundle. The pure half of the harness lives in engine/testing/replay.ts.",
  },
];

/**
 * Split a source file into the two views the rules need, blanking with spaces
 * so every surviving character keeps its original offset and line number.
 *
 * - `code` — comments, string and template *literal text*, and regex literals
 *   all blanked. This is what the identifier rules scan, so a simulated
 *   `git log` line reading `"Date:   "` is not mistaken for a wall-clock read.
 * - `withStrings` — comments blanked, strings kept, because an import
 *   specifier *is* a string and the module-specifier rule has to read it.
 *
 * Template interpolations survive in both. Blanking `` `${Date.now()}` ``
 * wholesale would hide the one thing inside a template worth catching.
 */
export function prepareSource(source) {
  const length = source.length;
  const code = source.split("");
  const withStrings = source.split("");

  const blanks = {
    both: (start, end) => {
      for (let index = start; index < end; index += 1) {
        if (source[index] !== "\n") {
          code[index] = " ";
          withStrings[index] = " ";
        }
      }
    },
    literal: (start, end) => {
      for (let index = start; index < end; index += 1) {
        if (source[index] !== "\n") code[index] = " ";
      }
    },
  };

  let index = 0;
  /** The previous meaningful character, used to tell a regex from a division. */
  let previous = "";
  let beforePrevious = "";

  while (index < length) {
    const skipped = skipLiteralOrComment(
      source,
      index,
      previous,
      beforePrevious,
      blanks,
    );
    if (skipped !== null) {
      // A comment is whitespace and leaves `previous` alone; a literal is a
      // value, so a `/` after it is division rather than a regex.
      if (!skipped.isComment) {
        beforePrevious = previous;
        previous = ")";
      }
      index = skipped.end;
      continue;
    }

    const current = source[index];
    if (!/\s/.test(current)) {
      beforePrevious = previous;
      previous = current;
    }
    index += 1;
  }

  return { code: code.join(""), withStrings: withStrings.join("") };
}

/**
 * If a comment, string, template, or regex literal starts at `index`, blank it
 * and return where it ends. Returns `null` when it starts none of them.
 *
 * Shared by the top-level scan and the interpolation scan, so that a comment
 * or regex *inside* `${…}` is handled the same way as one outside it.
 */
function skipLiteralOrComment(source, index, previous, beforePrevious, blanks) {
  const current = source[index];
  const next = source[index + 1];

  if (current === "/" && next === "/") {
    let end = index;
    while (end < source.length && source[end] !== "\n") end += 1;
    blanks.both(index, end);
    return { end, isComment: true };
  }

  if (current === "/" && next === "*") {
    const close = source.indexOf("*/", index + 2);
    const end = close === -1 ? source.length : close + 2;
    blanks.both(index, end);
    return { end, isComment: true };
  }

  if (current === '"' || current === "'" || current === "`") {
    return {
      end: scanString(source, index, current, blanks),
      isComment: false,
    };
  }

  if (current === "/" && startsRegexLiteral(previous, beforePrevious)) {
    const end = skipRegexLiteral(source, index);
    if (end !== -1) {
      blanks.literal(index, end);
      return { end, isComment: false };
    }
  }

  return null;
}

/**
 * Walk a string or template literal from `start`, blanking its literal text
 * but leaving `${…}` expressions intact. Returns the index just past it.
 */
function scanString(source, start, quote, blanks) {
  const length = source.length;
  let index = start + 1;
  let literalStart = start;

  while (index < length) {
    const current = source[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === quote) {
      blanks.literal(literalStart, index + 1);
      return index + 1;
    }
    if (quote === "`" && current === "$" && source[index + 1] === "{") {
      blanks.literal(literalStart, index);
      index = skipInterpolation(source, index + 2, blanks);
      literalStart = index;
      continue;
    }
    // An unterminated quote is a syntax error elsewhere; bail at the line end
    // rather than blanking the rest of the file.
    if (quote !== "`" && current === "\n") {
      blanks.literal(literalStart, index);
      return index;
    }
    index += 1;
  }

  blanks.literal(literalStart, length);
  return length;
}

/**
 * Index just past the `}` closing a `${` interpolation.
 *
 * Comments and regex literals are skipped rather than counted, because a `}`
 * inside either is not a brace. A block comment holding a stray closing brace,
 * or a regex like `x.replace(/}/g, …)`, would otherwise end the interpolation
 * early — and everything after it in the expression would be blanked as
 * template text, hiding exactly the nondeterminism the gate exists to find.
 */
function skipInterpolation(source, start, blanks) {
  const length = source.length;
  let index = start;
  let depth = 1;
  let previous = "";
  let beforePrevious = "";

  while (index < length && depth > 0) {
    const skipped = skipLiteralOrComment(
      source,
      index,
      previous,
      beforePrevious,
      blanks,
    );
    if (skipped !== null) {
      if (!skipped.isComment) {
        beforePrevious = previous;
        previous = ")";
      }
      index = skipped.end;
      continue;
    }

    const current = source[index];
    if (current === "{") depth += 1;
    else if (current === "}") depth -= 1;
    if (!/\s/.test(current)) {
      beforePrevious = previous;
      previous = current;
    }
    index += 1;
  }

  return index;
}

const REGEX_CAN_FOLLOW = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
]);

function startsRegexLiteral(previous, beforePrevious) {
  // Three postfix forms end a value, so a slash after them is division — but
  // each ends in a character that otherwise reads as an operator expecting an
  // operand. Without these the scanner blanks from the first slash to the
  // next and swallows whatever sat between them.
  //
  //   x++ / y     the `+` of `++`
  //   x-- / y     the `-` of `--`
  //   x!  / y     TypeScript's non-null assertion, vs. logical negation
  if ((previous === "+" || previous === "-") && beforePrevious === previous) {
    return false;
  }
  if (previous === "!" && /[\w$)\]]/.test(beforePrevious)) {
    return false;
  }
  return REGEX_CAN_FOLLOW.has(previous);
}

/** Index just past a regex literal starting at `start`, or -1 if it is not one. */
function skipRegexLiteral(source, start) {
  const length = source.length;
  let index = start + 1;
  let inCharacterClass = false;

  while (index < length) {
    const current = source[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === "\n") return -1;
    if (current === "[") {
      inCharacterClass = true;
    } else if (current === "]") {
      inCharacterClass = false;
    } else if (current === "/" && !inCharacterClass) {
      index += 1;
      while (index < length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }

  return -1;
}

/**
 * Module specifiers imported by a source file, with their offsets.
 *
 * Matched against `withStrings`, which keeps string contents because a
 * specifier *is* a string. That view also keeps strings that merely *look*
 * like imports, so `code` is passed in as a mask: the `from` / `import` /
 * `require` keyword must still be present there. A match that lives inside a
 * string or regex literal has that keyword blanked, and is not an import.
 *
 *     const example = 'import "node:fs"';   // keyword blanked in `code` — ignored
 *     import { x } from "node:fs";          // keyword is real code — reported
 */
export function extractModuleSpecifiers(withStrings, code = withStrings) {
  // The quote class includes a backtick, because a no-substitution template is
  // a valid static specifier — `await import(`node:fs`)` — and prettier does
  // not rewrite it to quotes, so a quote-only pattern let it through the whole
  // pipeline. A template with a substitution still matches when its literal
  // half names a built-in (`import(`node:${name}`)`), which is the right
  // answer; one whose prefix resolves to nothing recognisable is left alone,
  // since no text-level gate can resolve it.
  const patterns = [
    /\bfrom\s*(['"`])([^'"`\n]*)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`\n]*)\1/g,
    /\bimport\s+(['"`])([^'"`\n]*)\1/g,
    /\brequire\s*\(\s*(['"`])([^'"`\n]*)\1/g,
  ];

  const found = [];
  for (const pattern of patterns) {
    for (const match of withStrings.matchAll(pattern)) {
      if (code[match.index] === " ") continue;
      found.push({ specifier: match[2], index: match.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Whether a module specifier resolves to a Node built-in.
 *
 * The first path segment is what counts: `fs/promises`, `assert/strict`, and
 * `timers/promises` are built-ins too, and `import { readFile } from
 * "fs/promises"` is what an editor's autocomplete produces — the likely
 * accident rather than an exotic one. A relative path's first segment is `.`
 * or `..`, and lookalikes such as `path-browserify` and `fs-extra` are whole
 * segments of their own, so neither is caught by this.
 */
/**
 * Resolve a relative specifier against the importing file, as a repo-relative
 * POSIX path with the TypeScript source extension restored.
 *
 * Returns `undefined` for anything that is not relative — bare package names
 * and `node:` builtins are somebody else's rule.
 */
export function resolveRelativeSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;

  const segments = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }

  // ESM specifiers point at the emitted `.js`; the file on disk is `.ts`.
  return segments
    .join("/")
    .replace(/\.mjs$/, ".mts")
    .replace(/\.cjs$/, ".cts")
    .replace(/\.jsx$/, ".tsx")
    .replace(/\.js$/, ".ts");
}

/**
 * The module a path names, ignoring how it was spelled.
 *
 * `moduleResolution: "bundler"` accepts `./testing/fixtures`,
 * `./testing/fixtures.js`, and `./testing/fixtures.ts` as the same import, and
 * a directory resolves through its `index`. Comparing raw strings would let
 * the extensionless spelling walk straight past an allowlist entry.
 */
export function moduleIdentity(path) {
  const withoutExtension = path.replace(
    /\.(?:mts|cts|tsx|ts|mjs|cjs|jsx|js)$/,
    "",
  );
  return withoutExtension.replace(/\/index$/, "");
}

/**
 * Bare packages the engine may import.
 *
 * Empty, and that is the intended steady state. A dependency's own code is
 * never scanned by this gate, so approving one means asserting by hand that it
 * reads no clock, draws no randomness, and touches no network — the three
 * things every rule above exists to prevent. Add a name here only with that
 * argument written down, exactly as for an ALLOWLIST entry.
 */
export const APPROVED_PACKAGES = new Set();

export const BARE_PACKAGE_RULE = {
  id: "bare-package-import",
  invariant: "6 — no runtime model calls",
  message:
    "Package code is never scanned by this gate, so an unreviewed dependency is a hole " +
    "through every rule above — `axios` makes a real network call with no `fetch` in " +
    "sight. Add it to APPROVED_PACKAGES with the argument for why it is deterministic.",
};

/**
 * The first path segment — the directory a scan root names.
 *
 * `undefined` for a path with no directory at all, where there is no tree to
 * stay inside and the containment rule cannot say anything.
 */
function topLevelDirectory(path) {
  const [head, ...rest] = path.split("/");
  return rest.length > 0 ? head : undefined;
}

export const UNSCANNED_IMPORT_RULE = {
  id: "unscanned-import",
  invariant: "3 — the engine stays headless",
  message:
    "This path is outside the tree the gate scans, so nothing checks it for wall-clock " +
    "reads, randomness, DOM globals, or network calls — while TypeScript and every " +
    "bundler follow the import regardless. Engine code imports engine code.",
};

export const DYNAMIC_IMPORT_TARGET_RULE = {
  id: "computed-import-target",
  invariant: "3 — the engine stays headless",
  message:
    "A dynamic import whose target is not a literal is invisible to every import rule " +
    "here — the string it resolves to could be a Node built-in, an unapproved package, " +
    "or the allowlisted fixture loader. Import statically.",
};

export const SPECIFIER_ESCAPE_RULE = {
  id: "specifier-escape",
  invariant: "3 — the engine stays headless",
  message:
    "An escape inside a module specifier resolves to a different path than it spells, " +
    "so the built-in, allowlist, test-module, and containment checks all compare the " +
    "wrong string. Spell module paths plainly.",
};

export const TEST_MODULE_IMPORT_RULE = {
  id: "test-module-import",
  invariant: "3 — the engine stays headless",
  message:
    "This module is exempt from purity scanning because it is a test, which is only " +
    "safe while nothing production imports it. Move the shared code into a scanned " +
    "module.",
};

export const ALLOWLISTED_IMPORT_RULE = {
  id: "allowlisted-module-import",
  invariant: "3 — the engine stays headless",
  message:
    "This module is allowlisted for a rule it could not otherwise pass, on the grounds " +
    "that nothing in the engine imports it. Importing it makes that justification false " +
    "and pulls whatever it was excused for into the browser bundle. Note that the engine " +
    "tsconfig's `exclude` does not help here — TypeScript still follows an import.",
};

export function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  const [head] = specifier.split("/");
  return NODE_BUILTINS.has(head);
}

/** Every violation in one file's source. */
export function scanSource(file, source, allowlist = ALLOWLIST) {
  const { code, withStrings } = prepareSource(source);
  const lineStarts = computeLineStarts(source);
  const sourceLines = source.split("\n");
  const violations = [];

  const record = (rule, index) => {
    const { line, column } = locate(lineStarts, index);
    violations.push({
      file,
      line,
      column,
      rule: rule.id,
      invariant: rule.invariant,
      message: rule.message,
      snippet: (sourceLines[line - 1] ?? "").trim().slice(0, 120),
    });
  };

  for (const rule of CODE_RULES) {
    // The rule patterns are module-level and carry the /g lastIndex, so reset
    // before every file rather than sharing state between them.
    rule.pattern.lastIndex = 0;
    for (const match of code.matchAll(rule.pattern)) record(rule, match.index);
  }

  // Raw source, deliberately: these live inside comments, which `code` blanks.
  // `withStrings` is the mask here, inverted from the specifier check above —
  // it blanks comments and nothing else, so a blank at the match position
  // means the text really was a comment. The same directive quoted inside a
  // string literal survives in `withStrings`, and is inert.
  for (const rule of RAW_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      if (withStrings[match.index] !== " ") continue;
      record(rule, match.index);
    }
  }

  // A dynamic import or require whose argument is not a literal never reaches
  // the specifier rules at all, because there is no specifier to extract.
  for (const match of withStrings.matchAll(/\b(?:import|require)\s*\(\s*/g)) {
    if (code[match.index] === " ") continue;
    const next = withStrings[match.index + match[0].length];
    if (next !== '"' && next !== "'" && next !== "`") {
      record(DYNAMIC_IMPORT_TARGET_RULE, match.index);
    }
  }

  for (const { specifier, index } of extractModuleSpecifiers(
    withStrings,
    code,
  )) {
    // `"./testing/fixt\u0075res.js"` resolves to the allowlisted loader while
    // matching none of the checks below, which all compare the raw spelling.
    if (specifier.includes("\\")) {
      record(SPECIFIER_ESCAPE_RULE, index);
      continue;
    }
    if (isNodeBuiltin(specifier)) {
      record(
        {
          ...SPECIFIER_RULE,
          message: `${specifier}: ${SPECIFIER_RULE.message}`,
        },
        index,
      );
      continue;
    }

    // An allowlist entry's justification is always "nothing in the engine
    // imports this". Importing it is what makes that false, so the import is
    // the violation rather than the allowlisted file.
    const resolved = resolveRelativeSpecifier(file, specifier);
    if (resolved !== undefined) {
      const identity = moduleIdentity(resolved);
      if (allowlist.some((e) => moduleIdentity(e.file) === identity)) {
        record(
          {
            ...ALLOWLISTED_IMPORT_RULE,
            message: `${resolved}: ${ALLOWLISTED_IMPORT_RULE.message}`,
          },
          index,
        );
      }
      // A test module is skipped by `collectFiles`, so it is free to use
      // timers, Node APIs, and test dependencies. That is only safe while
      // nothing production imports it — TypeScript and every bundler follow an
      // explicit import regardless of any `exclude`.
      //
      // The `.ts` fallback covers the extensionless spelling: `./helper.test`
      // resolves to `helper.test.ts` on disk, and testing the bare path
      // against a pattern anchored on the extension would miss it.
      if (
        TEST_FILE_PATTERN.test(resolved) ||
        TEST_FILE_PATTERN.test(`${resolved}.ts`)
      ) {
        record(
          {
            ...TEST_MODULE_IMPORT_RULE,
            message: `${resolved}: ${TEST_MODULE_IMPORT_RULE.message}`,
          },
          index,
        );
      }

      // A relative path that leaves the importing file's top-level directory
      // leaves the gate's reach: `engine/session.ts` importing
      // `../runtime/leak.js` is followed by TypeScript and by every bundler,
      // while nothing scans the target.
      // A directory the scanner skips is unscanned for the same reason a test
      // file is, and importing into it has the same consequence.
      if (
        resolved.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment))
      ) {
        record(
          {
            ...UNSCANNED_IMPORT_RULE,
            message: `${resolved}: ${UNSCANNED_IMPORT_RULE.message}`,
          },
          index,
        );
        continue;
      }

      const tree = topLevelDirectory(file);
      if (tree !== undefined && topLevelDirectory(resolved) !== tree) {
        record(
          {
            ...UNSCANNED_IMPORT_RULE,
            message: `${resolved}: ${UNSCANNED_IMPORT_RULE.message}`,
          },
          index,
        );
      }
      continue;
    }

    // Anything left is a bare package. The gate scans `engine/`, never
    // `node_modules`, so an unreviewed dependency is a hole straight through
    // every rule above — `axios` makes a real network call with no `fetch` in
    // sight. Nothing is approved today; adding a name here is the same
    // deliberate act as adding an allowlist entry.
    if (
      !APPROVED_PACKAGES.has(
        specifier.replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, "$1"),
      )
    ) {
      record(
        {
          ...BARE_PACKAGE_RULE,
          message: `${specifier}: ${BARE_PACKAGE_RULE.message}`,
        },
        index,
      );
    }
  }

  return violations.sort((a, b) => a.line - b.line || a.column - b.column);
}

function computeLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locate(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - lineStarts[low] + 1 };
}

/** Scannable source files under `roots`, as repo-relative paths, sorted. */
export function collectFiles(roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT) {
  return walkRoots(roots, repoRoot).files;
}

/**
 * Symbolic links found while walking the scanned tree, as repo-relative paths.
 *
 * A symlink's Dirent is neither a file nor a directory, so it was silently
 * skipped — while TypeScript and every bundler follow it. A linked source
 * could hold `Date.now()` under a path that looks like ordinary engine code.
 * Rejecting is the answer rather than following: engine sources have no reason
 * to be links, and following raises loop questions the gate should not have.
 */
export function collectSymlinks(roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT) {
  return walkRoots(roots, repoRoot).symlinks;
}

export const SYMLINK_RULE = {
  id: "symlinked-source",
  invariant: "3 — the engine stays headless",
  message:
    "A symbolic link is skipped by the scanner but followed by TypeScript and by every " +
    "bundler, so its contents reach the engine unchecked. Engine sources are real files.",
};

function walkRoots(roots, repoRoot) {
  const files = [];
  const symlinks = [];

  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      const relativePath = relative(repoRoot, child).split(sep).join("/");

      // Every symlink, not only the ones that look like sources. A directory
      // link (`engine/linked -> ../outside`) has no extension at all, and an
      // import of `./linked/leak.js` through it satisfies the containment
      // check while the target was never walked.
      if (entry.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (TEST_FILE_PATTERN.test(entry.name)) continue;
      if (
        !SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      )
        continue;
      files.push(relativePath);
    }
  };

  for (const root of roots) {
    const absolute = resolve(repoRoot, root);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) walk(absolute);
  }

  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * Scan `roots` and return every violation, with the allowlist NOT applied.
 * Tests use this to assert what the rules actually see.
 */
export function collectViolations(roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT) {
  const { files, symlinks } = walkRoots(roots, repoRoot);

  const violations = files.flatMap((file) =>
    scanSource(file, readFileSync(resolve(repoRoot, file), "utf8")),
  );

  // Reported at line 1: the link itself is the violation, not anything in it.
  for (const file of symlinks) {
    violations.push({
      file,
      line: 1,
      column: 1,
      rule: SYMLINK_RULE.id,
      invariant: SYMLINK_RULE.invariant,
      message: SYMLINK_RULE.message,
      snippet: file,
    });
  }

  return { files, violations };
}

/** Split violations into those the allowlist covers and those it does not. */
export function applyAllowlist(violations, allowlist = ALLOWLIST) {
  const kept = [];
  // Counted per rule, not per entry. An entry naming two rules whose file
  // still breaks one of them would otherwise keep a nonzero total and hide
  // that the other permission is obsolete — letting that impurity come back
  // later without review.
  const suppressedBy = new Map(
    allowlist.map((entry) => [entry, new Map(entry.rules.map((r) => [r, 0]))]),
  );

  for (const violation of violations) {
    const entry = allowlist.find(
      (candidate) =>
        candidate.file === violation.file &&
        candidate.rules.includes(violation.rule),
    );
    if (entry) {
      const counts = suppressedBy.get(entry);
      counts.set(violation.rule, counts.get(violation.rule) + 1);
    } else kept.push(violation);
  }

  return { kept, suppressedBy };
}

/**
 * Allowlist entries that no longer earn their place: the file is gone, or the
 * violation it excused has been fixed.
 *
 * Only entries covered by this run's `roots` are judged. A scan narrowed to
 * one directory has no evidence about entries outside it, and reporting them
 * as stale would make every partial scan lie.
 */
export function findStaleAllowlistEntries(
  suppressedBy,
  roots = DEFAULT_ROOTS,
  repoRoot = REPO_ROOT,
) {
  const stale = [];
  for (const [entry, counts] of suppressedBy) {
    if (
      !roots.some(
        (root) => entry.file === root || entry.file.startsWith(`${root}/`),
      )
    )
      continue;

    if (!existsSync(resolve(repoRoot, entry.file))) {
      stale.push(
        `${entry.file}: allowlisted file does not exist — remove the entry.`,
      );
      continue;
    }

    // Per rule, not per entry. An entry naming two rules whose file still
    // breaks one of them would otherwise stay "in use" as a whole, hiding that
    // the other permission is obsolete — and letting that impurity return
    // later without review.
    for (const [rule, count] of counts) {
      if (count === 0) {
        stale.push(
          `${entry.file}: allowlisted for ${rule} but no longer violates it — ` +
            `drop that rule from the entry.`,
        );
      }
    }
  }
  return stale;
}

/** Full gate run: scan, allowlist, stale check. */
export function runGate(roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT) {
  const { files, violations } = collectViolations(roots, repoRoot);
  const { kept, suppressedBy } = applyAllowlist(violations);
  const stale = findStaleAllowlistEntries(suppressedBy, roots, repoRoot);
  return { files, violations: kept, stale };
}

export function formatViolations(violations) {
  return violations
    .map(
      (violation) =>
        `${violation.file}:${violation.line}:${violation.column}  [${violation.rule}]\n` +
        `    ${violation.snippet}\n` +
        `    ${violation.message}\n` +
        `    invariant ${violation.invariant}`,
    )
    .join("\n\n");
}

function main() {
  const roots = process.argv.slice(2);
  const { files, violations, stale } = runGate(
    roots.length > 0 ? roots : DEFAULT_ROOTS,
  );

  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n\n`);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `stale purity-gate allowlist entries:\n  ${stale.join("\n  ")}\n\n`,
    );
  }

  if (violations.length > 0 || stale.length > 0) {
    const parts = [];
    if (violations.length > 0) parts.push(`${violations.length} violation(s)`);
    if (stale.length > 0)
      parts.push(`${stale.length} stale allowlist entry(ies)`);
    process.stderr.write(
      `purity gate failed: ${parts.join(", ")} in ${files.length} file(s)\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`purity gate passed: ${files.length} file(s) clean\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
