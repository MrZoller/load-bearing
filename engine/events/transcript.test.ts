import { describe, expect, it } from "vitest";

import type { TranscriptEntry } from "./state.js";
import { DETAIL_INDENT, renderEntry, renderTranscript } from "./transcript.js";

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    index: 0,
    at: "2026-08-05T09:14:22.000Z",
    type: "clock.tick",
    summary: "",
    detail: [],
    ...overrides,
  };
}

describe("renderEntry", () => {
  it("puts the index, the instant, and the type in fixed columns", () => {
    expect(renderEntry(entry({ index: 7 }))).toEqual([
      "0007  2026-08-05T09:14:22.000Z  clock.tick",
    ]);
  });

  it("appends a summary with a single space, and nothing at all when empty", () => {
    expect(renderEntry(entry({ summary: "ms=1500" }))[0]).toBe(
      "0000  2026-08-05T09:14:22.000Z  clock.tick ms=1500",
    );
    // No trailing space when there is no summary: a recorded artifact with
    // invisible trailing whitespace is one a formatter will eventually "fix",
    // and the fixture would fail for a reason nobody can see in the diff.
    expect(renderEntry(entry())[0]).toBe(
      "0000  2026-08-05T09:14:22.000Z  clock.tick",
    );
  });

  it("indents detail lines under their entry", () => {
    expect(renderEntry(entry({ detail: ["a", "b"] }))).toEqual([
      "0000  2026-08-05T09:14:22.000Z  clock.tick",
      `${DETAIL_INDENT}a`,
      `${DETAIL_INDENT}b`,
    ]);
  });
});

describe("a caller-owned transcript entry", () => {
  it("renders the summary it branched on", () => {
    // `renderEntry` is exported and takes a caller-owned entry, and `summary`
    // was read to choose the branch and again to interpolate.
    let reads = 0;
    const shifty = {
      ...entry(),
      get summary(): string {
        reads += 1;
        return reads > 1 ? "swapped" : "original";
      },
    };

    expect(renderEntry(shifty)[0]).toContain("original");
    expect(reads).toBe(1);
  });
});

describe("renderTranscript", () => {
  it("renders nothing for a session that folded nothing", () => {
    expect(renderTranscript([])).toEqual([]);
  });

  it("keeps entries in log order", () => {
    const rendered = renderTranscript([
      entry({ index: 0, detail: ["x"] }),
      entry({ index: 1, type: "probe.int" }),
    ]);

    expect(rendered).toHaveLength(3);
    expect(rendered[2]).toContain("probe.int");
  });
});
