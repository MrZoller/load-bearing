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
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

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
    id: "math-random",
    pattern: /\bMath\s*\.\s*random\b/g,
    invariant: "2 — determinism is non-negotiable",
    message:
      "Math.random() is unseeded. Draw from the engine's seeded PRNG instead.",
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
    pattern: /\/\/\/\s*<reference\s+types\s*=/g,
    invariant: "3 — the engine stays headless",
    message:
      "A triple-slash types reference loads ambient globals for the whole program, " +
      "undoing tsconfig.engine.json's `types: []` isolation for every engine file at " +
      "once. Move the code that needs them out of the engine program.",
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
    rules: ["node-builtin-import"],
    reason:
      "Test infrastructure: reads committed golden-replay fixtures from disk for the " +
      "CI replay suite and the deliberate `npm run fixtures:update` re-record. It is " +
      "never imported by simulation code and never reaches the browser bundle. The " +
      "pure half of the harness lives in engine/testing/replay.ts.",
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

  while (index < length) {
    const skipped = skipLiteralOrComment(source, index, previous, blanks);
    if (skipped !== null) {
      // A comment is whitespace and leaves `previous` alone; a literal is a
      // value, so a `/` after it is division rather than a regex.
      if (!skipped.isComment) previous = ")";
      index = skipped.end;
      continue;
    }

    const current = source[index];
    if (!/\s/.test(current)) previous = current;
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
function skipLiteralOrComment(source, index, previous, blanks) {
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

  if (current === "/" && startsRegexLiteral(previous)) {
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

  while (index < length && depth > 0) {
    const skipped = skipLiteralOrComment(source, index, previous, blanks);
    if (skipped !== null) {
      if (!skipped.isComment) previous = ")";
      index = skipped.end;
      continue;
    }

    const current = source[index];
    if (current === "{") depth += 1;
    else if (current === "}") depth -= 1;
    if (!/\s/.test(current)) previous = current;
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

function startsRegexLiteral(previous) {
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
export function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  const [head] = specifier.split("/");
  return NODE_BUILTINS.has(head);
}

/** Every violation in one file's source. */
export function scanSource(file, source) {
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
  for (const rule of RAW_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern))
      record(rule, match.index);
  }

  for (const { specifier, index } of extractModuleSpecifiers(
    withStrings,
    code,
  )) {
    if (isNodeBuiltin(specifier)) {
      record(
        {
          ...SPECIFIER_RULE,
          message: `${specifier}: ${SPECIFIER_RULE.message}`,
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
  const files = [];

  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
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
      files.push(relative(repoRoot, child).split(sep).join("/"));
    }
  };

  for (const root of roots) {
    const absolute = resolve(repoRoot, root);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) walk(absolute);
  }

  return files.sort();
}

/**
 * Scan `roots` and return every violation, with the allowlist NOT applied.
 * Tests use this to assert what the rules actually see.
 */
export function collectViolations(roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT) {
  const files = collectFiles(roots, repoRoot);
  const violations = files.flatMap((file) =>
    scanSource(file, readFileSync(resolve(repoRoot, file), "utf8")),
  );
  return { files, violations };
}

/** Split violations into those the allowlist covers and those it does not. */
export function applyAllowlist(violations, allowlist = ALLOWLIST) {
  const kept = [];
  const suppressedBy = new Map(allowlist.map((entry) => [entry, 0]));

  for (const violation of violations) {
    const entry = allowlist.find(
      (candidate) =>
        candidate.file === violation.file &&
        candidate.rules.includes(violation.rule),
    );
    if (entry) suppressedBy.set(entry, suppressedBy.get(entry) + 1);
    else kept.push(violation);
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
  for (const [entry, count] of suppressedBy) {
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
    } else if (count === 0) {
      stale.push(
        `${entry.file}: allowlisted for [${entry.rules.join(", ")}] but no longer violates ` +
          `any of them — remove the entry.`,
      );
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
