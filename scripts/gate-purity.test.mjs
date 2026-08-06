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
} from "./gate-purity.mjs";

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
      [`${SAMPLES}/planted-after-url.ts`, 5, "math-random"],
      [`${SAMPLES}/planted-ambient.ts`, 4, "crypto-random"],
      [`${SAMPLES}/planted-ambient.ts`, 5, "ambient-process"],
      [`${SAMPLES}/planted-ambient.ts`, 5, "wall-clock-timer"],
      [`${SAMPLES}/planted-clock.ts`, 3, "wall-clock-date"],
      [`${SAMPLES}/planted-clock.ts`, 4, "wall-clock-date"],
      [`${SAMPLES}/planted-clock.ts`, 5, "wall-clock-performance"],
      [`${SAMPLES}/planted-dom.ts`, 3, "dom-global"],
      [`${SAMPLES}/planted-dom.ts`, 4, "dom-global"],
      [`${SAMPLES}/planted-dom.ts`, 5, "dom-global"],
      [`${SAMPLES}/planted-interpolation.ts`, 5, "wall-clock-date"],
      [`${SAMPLES}/planted-network.ts`, 3, "network"],
      [`${SAMPLES}/planted-node-import.ts`, 2, "node-builtin-import"],
      [`${SAMPLES}/planted-node-import.ts`, 3, "node-builtin-import"],
      [`${SAMPLES}/planted-random.ts`, 3, "math-random"],
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

    expect(hit).toMatchObject({ line: 3, column: 10, rule: "math-random" });
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

    expect(locations(violations)).toEqual([["sample.ts", 2, "math-random"]]);
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

  it("skips test files", () => {
    const files = collectFiles(["scripts"]);

    expect(files).toContain("scripts/gate-purity.mjs");
    expect(files).not.toContain("scripts/gate-purity.test.mjs");
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
      { file: "a.ts", rules: ["math-random"], reason: "sample" },
    ];
    const violations = [
      { file: "a.ts", rule: "math-random" },
      { file: "a.ts", rule: "dom-global" },
      { file: "b.ts", rule: "math-random" },
    ];

    const { kept } = applyAllowlist(violations, allowlist);

    expect(kept).toEqual([
      { file: "a.ts", rule: "dom-global" },
      { file: "b.ts", rule: "math-random" },
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
