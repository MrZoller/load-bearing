import { describe, expect, it } from "vitest";

import {
  FNV_OFFSET_BASIS_32,
  SEED_FIELD_SEPARATOR,
  UINT32_RANGE,
  formatSeed,
  hashString,
} from "./seed.js";

describe("formatSeed", () => {
  it("renders the canonical wire form", () => {
    expect(
      formatSeed({
        incidentDate: "2026-08-05",
        dailySeed: 0,
        model: "deep-foundation",
      }),
    ).toBe("2026-08-05/0/deep-foundation");
  });

  it("keeps distinct material distinct", () => {
    const base = {
      incidentDate: "2026-08-05",
      dailySeed: 1,
      model: "deep-foundation",
    };
    const seeds = new Set([
      formatSeed(base),
      formatSeed({ ...base, dailySeed: 2 }),
      formatSeed({ ...base, incidentDate: "2026-08-06" }),
      formatSeed({ ...base, model: "quick-patch" }),
    ]);

    expect(seeds.size).toBe(4);
  });

  it("rejects a separator inside a field, which would make two materials collide", () => {
    // Without the model slug rule these two would both render
    // "2026-08-05/1/a/b" and share a stream.
    expect(() =>
      formatSeed({
        incidentDate: "2026-08-05",
        dailySeed: 1,
        model: `a${SEED_FIELD_SEPARATOR}b`,
      }),
    ).toThrow(/model must be a lowercase slug/);
  });

  it("rejects a malformed date", () => {
    for (const incidentDate of ["2026-8-5", "20260805", "2026-08-05T00:00Z"]) {
      expect(() =>
        formatSeed({ incidentDate, dailySeed: 0, model: "deep-foundation" }),
      ).toThrow(/incidentDate must be YYYY-MM-DD/);
    }
  });

  it("rejects a daily seed that is not a non-negative integer", () => {
    for (const dailySeed of [
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() =>
        formatSeed({
          incidentDate: "2026-08-05",
          dailySeed,
          model: "deep-foundation",
        }),
      ).toThrow(/dailySeed must be a non-negative integer/);
    }
  });

  it("rejects model identifiers that would need escaping downstream", () => {
    for (const model of ["", "Deep Foundation", "deep_foundation", "-lead"]) {
      expect(() =>
        formatSeed({ incidentDate: "2026-08-05", dailySeed: 0, model }),
      ).toThrow(/model must be a lowercase slug/);
    }
  });
});

describe("hashString", () => {
  it("is pinned to specific values, because every fixture depends on them", () => {
    // FNV-1a over UTF-16LE bytes. If these change, every recorded fixture and
    // every shared replay permalink refers to a different session.
    expect(hashString("")).toBe(FNV_OFFSET_BASIS_32);
    expect(hashString("2026-08-05/0/deep-foundation")).toBe(1023437636);
    expect(hashString("root")).toBe(2184104203);
  });

  it("always returns a uint32", () => {
    for (const text of ["", "a", "load-bearing", "\u{1f600}", "\ud800"]) {
      const hash = hashString(text);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(UINT32_RANGE);
    }
  });

  it("separates adjacent inputs", () => {
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("ab")).not.toBe(hashString("ba"));
  });

  it("hashes a lone surrogate rather than failing on it", () => {
    // Seed strings arrive from a URL, so an unpaired surrogate is reachable.
    expect(() => hashString("\ud800")).not.toThrow();
    expect(hashString("\ud800")).not.toBe(hashString("\udc00"));
  });

  it("uses the basis, so the same path under two seeds diverges", () => {
    expect(hashString("root/spinner", 1)).not.toBe(
      hashString("root/spinner", 2),
    );
    expect(hashString("", 12345)).toBe(12345);
  });
});
