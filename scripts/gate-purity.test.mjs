import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  applyAllowlist,
  collectFiles,
  collectViolations,
  findStaleAllowlistEntries,
  prepareSource,
  runGate,
  scanSource,
  TEST_FILE_PATTERN,
} from "./gate-purity.mjs";
import vitestConfig from "../vitest.config.js";

const SAMPLES = "scripts/gate-purity-samples";

/** `[file, line, rule]` for each violation, which is the contract worth locking. */
function locations(violations) {
  return violations.map((violation) => [
    violation.file,
    violation.line,
    violation.rule,
  ]);
}

describe("purity gate", () => {
  it("reports every planted violation with its file and line", () => {
    const { violations } = collectViolations([SAMPLES]);

    expect(locations(violations)).toEqual([
      [`${SAMPLES}/planted-after-url.ts`, 5, "math-nondeterministic"],
      [`${SAMPLES}/planted-aliased-globals.ts`, 5, "wall-clock-timer"],
      [`${SAMPLES}/planted-aliased-globals.ts`, 6, "wall-clock-performance"],
      [`${SAMPLES}/planted-aliased-globals.ts`, 7, "crypto-random"],
      [`${SAMPLES}/planted-aliased-globals.ts`, 8, "node-global"],
      [`${SAMPLES}/planted-aliased-globals.ts`, 9, "node-global"],
      [`${SAMPLES}/planted-ambient.ts`, 4, "crypto-random"],
      [`${SAMPLES}/planted-ambient.ts`, 5, "ambient-process"],
      [`${SAMPLES}/planted-ambient.ts`, 5, "wall-clock-timer"],
      [`${SAMPLES}/planted-brace-in-comment.ts`, 6, "math-nondeterministic"],
      [`${SAMPLES}/planted-brace-in-comment.ts`, 7, "wall-clock-date"],
      [`${SAMPLES}/planted-builtin-subpath.ts`, 4, "node-builtin-import"],
      [`${SAMPLES}/planted-builtin-subpath.ts`, 5, "node-builtin-import"],
      [`${SAMPLES}/planted-clock.ts`, 3, "wall-clock-date"],
      [`${SAMPLES}/planted-clock.ts`, 4, "wall-clock-date"],
      [`${SAMPLES}/planted-clock.ts`, 5, "wall-clock-performance"],
      [`${SAMPLES}/planted-dom.ts`, 3, "dom-global"],
      [`${SAMPLES}/planted-dom.ts`, 4, "dom-global"],
      [`${SAMPLES}/planted-dom.ts`, 5, "dom-global"],
      [`${SAMPLES}/planted-eval-and-stack.ts`, 6, "dynamic-eval"],
      [`${SAMPLES}/planted-eval-and-stack.ts`, 7, "dynamic-eval"],
      [`${SAMPLES}/planted-eval-and-stack.ts`, 8, "error-stack"],
      [`${SAMPLES}/planted-extension.tsx`, 5, "math-nondeterministic"],
      [`${SAMPLES}/planted-global-object.ts`, 5, "global-object"],
      [`${SAMPLES}/planted-global-object.ts`, 6, "dynamic-eval"],
      [`${SAMPLES}/planted-interpolation.ts`, 5, "wall-clock-date"],
      [`${SAMPLES}/planted-locale-and-gc.ts`, 4, "gc-timing"],
      [`${SAMPLES}/planted-locale-and-gc.ts`, 5, "locale-sensitive"],
      [`${SAMPLES}/planted-locale-and-gc.ts`, 6, "locale-sensitive"],
      [`${SAMPLES}/planted-locale-and-gc.ts`, 7, "locale-sensitive"],
      [`${SAMPLES}/planted-math.ts`, 4, "math-alias"],
      [`${SAMPLES}/planted-math.ts`, 5, "math-alias"],
      [`${SAMPLES}/planted-math.ts`, 6, "math-nondeterministic"],
      [`${SAMPLES}/planted-network.ts`, 3, "network"],
      [`${SAMPLES}/planted-node-import.ts`, 2, "node-builtin-import"],
      [`${SAMPLES}/planted-node-import.ts`, 3, "node-builtin-import"],
      [`${SAMPLES}/planted-random.ts`, 3, "math-nondeterministic"],
      [`${SAMPLES}/planted-template-specifier.ts`, 6, "node-builtin-import"],
    ]);
  });

  it("catches banned globals reached through an alias or an unlisted member", () => {
    // The gate bans whole globals, so indirection is not an escape hatch.
    const violations = scanSource(
      "sample.ts",
      [
        "const schedule = setTimeout;",
        "const origin = performance.timeOrigin;",
        "const key = crypto.subtle;",
        "const alias = crypto;",
        "",
      ].join("\n"),
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "wall-clock-timer"],
      ["sample.ts", 2, "wall-clock-performance"],
      ["sample.ts", 3, "crypto-random"],
      ["sample.ts", 4, "crypto-random"],
    ]);
  });

  it("allows the exact Math members and rejects the rest", () => {
    // The allowlist is what ECMA-262 pins exactly. `sqrt` is deliberately not
    // on it: IEEE 754 requires correct rounding and every engine defers to the
    // hardware, but the spec still calls it implementation-approximated — the
    // same sentence that disqualifies `cbrt`.
    expect(
      scanSource(
        "sample.ts",
        "const a = Math.floor(Math.max(x, Math.imul(y, 2)));\nconst b = Math.PI * Math.abs(r);\n",
      ),
    ).toEqual([]);

    expect(
      locations(
        scanSource(
          "sample.ts",
          "const a = Math.tan(x);\nconst b = Math.pow(x, 2);\nconst c = Math.sqrt(x);\n",
        ),
      ),
    ).toEqual([
      ["sample.ts", 1, "math-nondeterministic"],
      ["sample.ts", 2, "math-nondeterministic"],
      ["sample.ts", 3, "math-nondeterministic"],
    ]);
  });

  it("catches dynamic evaluation, which resurrects blanked string contents", () => {
    const violations = scanSource(
      "sample.ts",
      'const a = eval("Math.random()");\nconst b = new Function("return Date.now()")();\n',
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "dynamic-eval"],
      ["sample.ts", 2, "dynamic-eval"],
    ]);

    // Aliasing is not an escape, and `Function` as a bare type annotation is
    // banned too — a call signature says what the value actually is.
    expect(
      locations(
        scanSource(
          "sample.ts",
          "const Build = Function;\nexport function run(fn: Function): void {}\n",
        ),
      ),
    ).toEqual([
      ["sample.ts", 1, "dynamic-eval"],
      ["sample.ts", 2, "dynamic-eval"],
    ]);

    // `function` the keyword, and identifiers merely containing "Function",
    // are untouched.
    expect(
      scanSource(
        "sample.ts",
        "export function run(): void {}\nconst c: AsyncFunctionish = x;\n",
      ),
    ).toEqual([]);
  });

  it("catches an ambient reached through globalThis", () => {
    // The property name is a string, and string contents are blanked, so no
    // banned identifier appears in the code view at all.
    const violations = scanSource(
      "sample.ts",
      'const a = globalThis["Date"].now();\nconst b = globalThis["Math"]["random"]();\n',
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "global-object"],
      ["sample.ts", 2, "global-object"],
    ]);
  });

  it("catches error stacks, which carry host formatting and local paths", () => {
    const violations = scanSource(
      "sample.ts",
      "const a = new Error().stack;\ntry { f(); } catch (e) { log(e.stack); }\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "error-stack"],
      ["sample.ts", 2, "error-stack"],
    ]);
  });

  it("catches Math reached without a dotted access, however it is spelled", () => {
    // The spellings an enumeration of aliasing forms would have to chase.
    for (const source of [
      "const { random } = Math;",
      "const { random: draw } = Math;",
      'const n = Math["random"]();',
      "const n = Math?.random();",
      "const m = Math;",
      "const { ...m } = Math;",
    ]) {
      expect(locations(scanSource("sample.ts", `${source}\n`))).toEqual([
        ["sample.ts", 1, "math-alias"],
      ]);
    }
  });

  it("catches locale-sensitive formatting and comparison", () => {
    // `localeCompare` sorts å before z in Swedish and after it in German, so
    // an `ls` listing would differ between a laptop and CI.
    const violations = scanSource(
      "sample.ts",
      "const a = names.sort((x, y) => x.localeCompare(y));\nconst b = n.toLocaleString();\nconst c = new Intl.DateTimeFormat().format(0);\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "locale-sensitive"],
      ["sample.ts", 2, "locale-sensitive"],
      ["sample.ts", 3, "locale-sensitive"],
    ]);

    // A bare sort() is UTF-16 code-unit order and is fine.
    expect(scanSource("sample.ts", "const s = names.sort();\n")).toEqual([]);
  });

  it("catches references whose behaviour depends on garbage collection", () => {
    const violations = scanSource(
      "sample.ts",
      "const r = new WeakRef(obj);\nconst f = new FinalizationRegistry(cb);\nconst m = new WeakMap();\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "gc-timing"],
      ["sample.ts", 2, "gc-timing"],
    ]);
  });

  it("does not treat a triple-slash directive inside a string as a directive", () => {
    // Inverse of the specifier guard: a raw-source match counts only where
    // `withStrings` blanked it, which happens for comments and nothing else.
    const violations = scanSource(
      "sample.ts",
      "export const sample = '/// <reference types=\"node\" />';\n",
    );

    expect(violations).toEqual([]);
  });

  it("catches Node globals that arrive with no import line", () => {
    // require.resolve() is the sharp one: the specifier rule requires
    // `require(`, so even its literal "node:fs" argument went unnoticed.
    const violations = scanSource(
      "sample.ts",
      'const b = Buffer.from("x");\nconst d = __dirname;\nconst p = require.resolve("node:fs");\n',
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "node-global"],
      ["sample.ts", 2, "node-global"],
      ["sample.ts", 3, "node-global"],
    ]);
  });

  it("catches a built-in imported through a template literal", () => {
    // Valid syntax that prettier leaves alone, so a quote-only pattern let it
    // through format:check, the gate, and CI.
    const violations = scanSource(
      "sample.ts",
      "const fs = await import(`node:fs`);\nconst p = require(`path`);\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "node-builtin-import"],
      ["sample.ts", 2, "node-global"],
      ["sample.ts", 2, "node-builtin-import"],
    ]);
  });

  it("catches a triple-slash types reference, which lives in a comment", () => {
    // One directive anywhere re-poisons the whole engine program, because
    // TypeScript's global type scope is per-program, not per-file. It is
    // matched against raw source: the code view has comments blanked.
    const violations = scanSource(
      "sample.ts",
      '/// <reference types="node" />\nexport const x = 1;\n',
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "ambient-types-reference"],
    ]);
  });

  it("catches a violation inside a template interpolation", () => {
    // Blanking a template wholesale would hide the one thing inside it worth
    // catching.
    const violations = scanSource(
      "sample.ts",
      "const s = `at ${Date.now()}`;\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "wall-clock-date"],
    ]);
  });

  it("does not fire on a banned word inside string literal text", () => {
    // Simulated `git log` prints a "Date:" column and `curl` prints a "Date"
    // header. Those are mechanics, so they live in engine source.
    const violations = scanSource(
      "sample.ts",
      'const header = "Date:   ";\nconst hint = "fetch the manual";\n',
    );

    expect(violations).toEqual([]);
  });

  it("catches a Node built-in imported by subpath", () => {
    // `import { readFile } from "fs/promises"` is what autocomplete produces,
    // so the subpath form is the likely accident, not an exotic one.
    const violations = scanSource(
      "sample.ts",
      'import "fs/promises";\nimport "assert/strict";\nimport "node:timers/promises";\n',
    );

    expect(violations).toHaveLength(3);
  });

  it("does not fire on packages that merely start like a built-in", () => {
    const violations = scanSource(
      "sample.ts",
      'import "path-browserify";\nimport "fs-extra";\nimport "./fs/local.js";\n',
    );

    expect(violations).toEqual([]);
  });

  it("does not treat import-shaped text in a literal as an import", () => {
    // The specifier rule reads a view with strings intact, so it cross-checks
    // that the keyword itself is real code.
    const violations = scanSource(
      "sample.ts",
      'const a = \'import "node:fs"\';\nconst b = /import "node:fs"/;\n',
    );

    expect(violations).toEqual([]);
  });

  it("catches a violation hidden behind a stray brace in an interpolation", () => {
    // A `}` inside a comment or regex is not a brace. Counting it would end
    // the interpolation early and blank the real expression after it.
    const violations = scanSource(
      "sample.ts",
      "const a = `${/* } */ Math.random()}`;\nconst b = `${x.replace(/}/g, String(Date))}`;\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "math-nondeterministic"],
      ["sample.ts", 2, "wall-clock-date"],
    ]);
  });

  it("catches every use of the process global, not a list of members", () => {
    const violations = scanSource(
      "sample.ts",
      "const a = process.pid;\nconst b = process.uptime();\nconst c = process;\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "ambient-process"],
      ["sample.ts", 2, "ambient-process"],
      ["sample.ts", 3, "ambient-process"],
    ]);
  });

  it("catches a banned global that is aliased rather than called", () => {
    const violations = scanSource(
      "sample.ts",
      "const later = Date;\nconst f = fetch;\n",
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 1, "wall-clock-date"],
      ["sample.ts", 2, "network"],
    ]);
  });

  it("reports a column and the offending line, so a hit is findable", () => {
    const { violations } = collectViolations([SAMPLES]);
    const hit = violations.find((violation) =>
      violation.file.endsWith("planted-random.ts"),
    );

    expect(hit).toMatchObject({
      line: 3,
      column: 10,
      rule: "math-nondeterministic",
    });
    expect(hit.snippet).toBe("return Math.random();");
    expect(hit.invariant).toContain("2");
  });

  it("does not fire on banned constructs named in comments", () => {
    const { violations } = collectViolations([SAMPLES]);

    expect(
      violations.filter((violation) => violation.file.endsWith("clean.ts")),
    ).toEqual([]);
  });

  it("sees a violation that follows a URL on the same line", () => {
    // `//` inside a string must not be read as a comment start, or everything
    // after it on the line would be blanked and the violation missed.
    const violations = scanSource(
      "sample.ts",
      'const u = "https://x.test/a";\nconst n = Math.random();\n',
    );

    expect(locations(violations)).toEqual([
      ["sample.ts", 2, "math-nondeterministic"],
    ]);
  });

  it("catches both prefixed and bare Node built-in imports", () => {
    const violations = scanSource(
      "sample.ts",
      'import "node:https";\nimport { join } from "path";\nconst p = await import("node:fs");\n',
    );

    expect(violations).toHaveLength(3);
    expect(violations[0].message).toContain("node:https");
    expect(violations[1].message).toContain("path");
    expect(violations[2].message).toContain("node:fs");
  });

  it("skips test files, including .tsx ones", () => {
    const files = collectFiles(["scripts"]);

    expect(files).toContain("scripts/gate-purity.mjs");
    expect(files).not.toContain("scripts/gate-purity.test.mjs");
    expect(files).not.toContain(`${SAMPLES}/ignored.test.tsx`);
  });

  it("scans .tsx sources rather than reporting them clean unopened", () => {
    const files = collectFiles([SAMPLES]);

    expect(files).toContain(`${SAMPLES}/planted-extension.tsx`);
  });

  it("skips exactly the files Vitest is configured to run", async () => {
    // A name the gate skips but Vitest's include globs miss would be neither
    // purity-checked nor executed: a regression test that could be added and
    // silently never run. Matched with the same glob library Vitest itself
    // uses, so this compares the real configuration rather than a paraphrase.
    const picomatch = (await import("picomatch")).default;
    const runsInVitest = picomatch(vitestConfig.test.include);

    for (const name of [
      "engine/a.test.ts",
      "engine/a.spec.ts",
      "engine/a.test.tsx",
      "engine/nested/a.spec.mts",
      "scripts/a.test.mjs",
      "scripts/a.spec.js",
    ]) {
      expect(TEST_FILE_PATTERN.test(name), `${name}: gate skips it`).toBe(true);
      expect(runsInVitest(name), `${name}: vitest runs it`).toBe(true);
    }

    // And a plain source file is neither skipped by the gate nor run by Vitest.
    expect(TEST_FILE_PATTERN.test("engine/a.ts")).toBe(false);
    expect(runsInVitest("engine/a.ts")).toBe(false);
  });

  it("passes on the engine, with no stale allowlist entries", () => {
    const { files, violations, stale } = runGate();

    expect(violations).toEqual([]);
    expect(stale).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("purity gate allowlist", () => {
  it("suppresses only the named rule in the named file", () => {
    const allowlist = [
      { file: "a.ts", rules: ["math-nondeterministic"], reason: "sample" },
    ];
    const violations = [
      { file: "a.ts", rule: "math-nondeterministic" },
      { file: "a.ts", rule: "dom-global" },
      { file: "b.ts", rule: "math-nondeterministic" },
    ];

    const { kept } = applyAllowlist(violations, allowlist);

    expect(kept).toEqual([
      { file: "a.ts", rule: "dom-global" },
      { file: "b.ts", rule: "math-nondeterministic" },
    ]);
  });

  it("flags an entry whose file is gone", () => {
    const entry = {
      file: "engine/departed.ts",
      rules: ["math-random"],
      reason: "sample",
    };

    const stale = findStaleAllowlistEntries(new Map([[entry, 0]]), ["engine"]);

    expect(stale).toEqual([expect.stringContaining("does not exist")]);
  });

  it("flags an entry that no longer suppresses anything", () => {
    const entry = {
      file: "engine/index.ts",
      rules: ["math-random"],
      reason: "sample",
    };

    const stale = findStaleAllowlistEntries(new Map([[entry, 0]]), ["engine"]);

    expect(stale).toEqual([expect.stringContaining("no longer violates")]);
  });

  it("ignores entries outside the scanned roots", () => {
    const entry = {
      file: "engine/index.ts",
      rules: ["math-random"],
      reason: "sample",
    };

    expect(
      findStaleAllowlistEntries(new Map([[entry, 0]]), ["scripts"]),
    ).toEqual([]);
  });

  it("documents a reason for every entry", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.rules.length).toBeGreaterThan(0);
    }
  });
});

describe("prepareSource", () => {
  it("blanks comments in both views, preserving every offset and line break", () => {
    const source = "const a = 1; // Date.now\n/* document */ const b = 2;\n";

    const { code, withStrings } = prepareSource(source);

    for (const view of [code, withStrings]) {
      expect(view).toHaveLength(source.length);
      expect(view.split("\n")).toHaveLength(source.split("\n").length);
      expect(view).toBe(
        "const a = 1;            \n               const b = 2;\n",
      );
    }
  });

  it("blanks string literal text in the code view but keeps it for specifiers", () => {
    const source = 'import { x } from "node:fs";\nconst y = 1;\n';

    const { code, withStrings } = prepareSource(source);

    expect(code).toHaveLength(source.length);
    expect(code).not.toContain("node:fs");
    expect(code).toContain("import { x } from");
    expect(code).toContain("const y = 1;");
    expect(withStrings).toBe(source);
  });

  it("keeps template interpolations and blanks the literal text around them", () => {
    const source = "const s = `Date: ${Date.now()} end`;\n";

    const { code } = prepareSource(source);

    expect(code).toHaveLength(source.length);
    expect(code).toContain("${Date.now()}");
    expect(code).not.toContain("Date:");
    expect(code).not.toContain("end");
  });

  it("does not read a regex literal's slashes as a comment", () => {
    const source = "const re = /\\/{2,}/g;\nconst c = 3;\n";

    const { code } = prepareSource(source);

    // The regex is blanked as a literal, but the code after it survives — a
    // comment reading would have swallowed the rest of the line.
    expect(code).toHaveLength(source.length);
    expect(code).not.toContain("{2,}");
    expect(code).toContain("const re =");
    expect(code).toContain("const c = 3;");
  });

  it("does not read a string's slashes as a comment", () => {
    const source = 'const u = "https://x.test"; const n = 1;\n';

    const { code } = prepareSource(source);

    expect(code).toHaveLength(source.length);
    expect(code).not.toContain("x.test");
    expect(code).toContain("const n = 1;");
  });
});
