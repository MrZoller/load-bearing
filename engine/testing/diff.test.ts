import { describe, expect, it } from "vitest";

import { formatTextDiff } from "./diff.js";

describe("formatTextDiff", () => {
  it("returns nothing for identical text", () => {
    expect(formatTextDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("locates the first differing line", () => {
    const diff = formatTextDiff("a\nb\nc\n", "a\nB\nc\n");

    expect(diff).toContain("first difference at line 2");
    expect(diff).toContain("- 2 | b");
    expect(diff).toContain("+ 2 | B");
  });

  it("shows only the divergent region, not the whole artifact", () => {
    const shared = Array.from({ length: 50 }, (_, index) => `line ${index}`);
    const changed = [...shared];
    changed[25] = "line twenty-five";

    const diff = formatTextDiff(
      `${shared.join("\n")}\n`,
      `${changed.join("\n")}\n`,
    );

    expect(diff).toContain("- 26 | line 25");
    expect(diff).not.toContain("line 10");
    expect(diff).not.toContain("line 40");
  });

  it("reports byte and line counts for both sides", () => {
    const diff = formatTextDiff("a\n", "ab\n");

    expect(diff).toContain("expected: 2 bytes, 2 lines");
    expect(diff).toContain("actual: 3 bytes, 2 lines");
  });

  it("says so when one side has extra lines and the other has none", () => {
    const diff = formatTextDiff("a\n", "a\nb\n");

    expect(diff).toContain("- expected: (nothing");
    expect(diff).toContain("+ 2 | b");
  });

  it("truncates a very large divergent region", () => {
    const expectedText = `${Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n")}\n`;
    const actualText = `${Array.from({ length: 100 }, (_, i) => `y${i}`).join("\n")}\n`;

    const diff = formatTextDiff(expectedText, actualText);

    expect(diff).toContain("more line(s)");
  });

  it("honours custom labels", () => {
    const diff = formatTextDiff("a\n", "b\n", {
      expectedLabel: "recorded",
      actualLabel: "replayed",
    });

    expect(diff).toContain("- 1 | a");
    expect(diff).toContain("+ 1 | b");
  });
});
