import { describe, expect, it } from "vitest";

import {
  MAX_EPOCH_MS,
  MONTH_NAMES,
  MS_PER_DAY,
  WEEKDAY_NAMES,
  civilFromEpochMs,
  daysInMonth,
  epochMsFromCivil,
  formatTimestamp,
  isLeapYear,
  parseTimestamp,
} from "./civil.js";

describe("civilFromEpochMs", () => {
  it("decomposes the epoch itself", () => {
    expect(civilFromEpochMs(0)).toEqual({
      year: 1970,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
      weekday: 4,
    });
  });

  it("decomposes the last representable instant", () => {
    expect(civilFromEpochMs(MAX_EPOCH_MS)).toEqual({
      year: 9999,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
      weekday: 5,
    });
  });

  it("decomposes a leap day", () => {
    const leapDay = civilFromEpochMs(
      parseTimestamp("2024-02-29T12:34:56.789Z"),
    );
    expect(leapDay).toEqual({
      year: 2024,
      month: 2,
      day: 29,
      hour: 12,
      minute: 34,
      second: 56,
      millisecond: 789,
      weekday: 4,
    });
  });

  it("names weekdays consistently with the epoch being a Thursday", () => {
    for (let offset = 0; offset < 14; offset += 1) {
      const civil = civilFromEpochMs(offset * MS_PER_DAY);
      expect(WEEKDAY_NAMES[civil.weekday]).toBe(
        WEEKDAY_NAMES[(4 + offset) % 7],
      );
    }
  });

  it("rejects instants outside the representable range", () => {
    for (const epochMs of [-1, MAX_EPOCH_MS + 1, 1.5, Number.NaN]) {
      expect(() => civilFromEpochMs(epochMs)).toThrow(
        /timestamp must be an integer/,
      );
    }
  });
});

describe("epochMsFromCivil", () => {
  it("inverts civilFromEpochMs across century and leap boundaries", () => {
    const probes = [
      0,
      MAX_EPOCH_MS,
      parseTimestamp("1999-12-31T23:59:59.999Z"),
      parseTimestamp("2000-02-29T00:00:00.000Z"),
      parseTimestamp("2100-03-01T00:00:00.000Z"),
      parseTimestamp("2026-08-05T09:14:22.500Z"),
    ];

    for (const epochMs of probes) {
      expect(epochMsFromCivil(civilFromEpochMs(epochMs))).toBe(epochMs);
    }
  });

  it("inverts civilFromEpochMs for every day of a four-year window", () => {
    const start = parseTimestamp("2024-01-01T00:00:00.000Z");
    for (let day = 0; day < 366 * 4; day += 1) {
      const epochMs = start + day * MS_PER_DAY;
      expect(epochMsFromCivil(civilFromEpochMs(epochMs))).toBe(epochMs);
    }
  });

  it("defaults the time of day to midnight", () => {
    expect(epochMsFromCivil({ year: 2026, month: 8, day: 5 })).toBe(
      parseTimestamp("2026-08-05T00:00:00.000Z"),
    );
  });

  it("rejects an out-of-range field rather than normalizing it", () => {
    expect(() => epochMsFromCivil({ year: 2026, month: 13, day: 1 })).toThrow(
      /month must be an integer in \[1, 12\]/,
    );
    expect(() => epochMsFromCivil({ year: 1969, month: 1, day: 1 })).toThrow(
      /year must be an integer in \[1970, 9999\]/,
    );
    expect(() =>
      epochMsFromCivil({ year: 2026, month: 1, day: 1, hour: 24 }),
    ).toThrow(/hour must be an integer in \[0, 23\]/);
  });

  it("rejects a day the month does not have", () => {
    expect(() => epochMsFromCivil({ year: 2025, month: 2, day: 29 })).toThrow(
      /2025-02 has 28 days/,
    );
    expect(() =>
      epochMsFromCivil({ year: 2024, month: 2, day: 29 }),
    ).not.toThrow();
  });
});

describe("isLeapYear and daysInMonth", () => {
  it("follows the Gregorian century rule", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2025)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("agrees with the calendar", () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    lengths.forEach((length, index) => {
      expect(daysInMonth(2025, index + 1)).toBe(length);
    });
    expect(daysInMonth(2024, 2)).toBe(29);
  });
});

describe("formatTimestamp", () => {
  it("always renders milliseconds, so every stamp is one width", () => {
    expect(formatTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(formatTimestamp(MAX_EPOCH_MS)).toBe("9999-12-31T23:59:59.999Z");
  });

  it("zero-pads every field", () => {
    expect(
      formatTimestamp(epochMsFromCivil({ year: 2026, month: 1, day: 2 })),
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("round-trips through parseTimestamp", () => {
    for (const epochMs of [0, 1, MAX_EPOCH_MS, 1754385262500]) {
      expect(parseTimestamp(formatTimestamp(epochMs))).toBe(epochMs);
    }
  });

  it("does not depend on the host timezone", () => {
    // The suite runs twice, under TZ=UTC and TZ=Asia/Tokyo
    // (`npm run test:timezones`). Nothing in this module reads a host
    // timezone — there is no `Date` to read one with — and this is the
    // assertion that would fail if that stopped being true.
    expect(formatTimestamp(1754385262500)).toBe("2025-08-05T09:14:22.500Z");
  });

  it("is actually being run under the timezone it was given", () => {
    // Guards the harness rather than the engine. A typo in `test:timezones`
    // would silently degrade it to running UTC twice, and every assertion
    // above would still pass — so when the suite is told to run somewhere
    // other than UTC, check the host agreed. `Date` is available here because
    // this is a test file; engine sources are gated.
    const zone = process.env.TZ;
    if (zone === undefined || zone === "UTC") return;
    expect(new Date(1754385262500).getTimezoneOffset()).not.toBe(0);
  });
});

describe("parseTimestamp", () => {
  it("accepts a fractional part of one to three digits, padding it", () => {
    expect(parseTimestamp("2026-08-05T00:00:00.5Z")).toBe(
      parseTimestamp("2026-08-05T00:00:00.500Z"),
    );
    expect(parseTimestamp("2026-08-05T00:00:00.05Z")).toBe(
      parseTimestamp("2026-08-05T00:00:00.050Z"),
    );
  });

  it("accepts an omitted fractional part", () => {
    expect(parseTimestamp("2026-08-05T09:14:22Z")).toBe(
      parseTimestamp("2026-08-05T09:14:22.000Z"),
    );
  });

  it("rejects any offset other than Z", () => {
    for (const text of [
      "2026-08-05T09:14:22+00:00",
      "2026-08-05T09:14:22+09:00",
      "2026-08-05T09:14:22",
    ]) {
      expect(() => parseTimestamp(text)).toThrow(/must be YYYY-MM-DDTHH/);
    }
  });

  it("rejects precision it would have to drop", () => {
    expect(() => parseTimestamp("2026-08-05T09:14:22.123456Z")).toThrow(
      /must be YYYY-MM-DDTHH/,
    );
  });

  it("rejects a leap second, which does not divide into milliseconds", () => {
    expect(() => parseTimestamp("2016-12-31T23:59:60Z")).toThrow(
      /second must be an integer in \[0, 59\]/,
    );
  });

  it("rejects a date that does not exist", () => {
    expect(() => parseTimestamp("2025-02-29T00:00:00Z")).toThrow(
      /2025-02 has 28 days/,
    );
  });
});

describe("name tables", () => {
  it("are the C-locale abbreviations the simulated shell prints", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("Jan");
    expect(MONTH_NAMES[11]).toBe("Dec");
    expect(WEEKDAY_NAMES).toHaveLength(7);
    expect(WEEKDAY_NAMES[0]).toBe("Sun");
  });

  it("index directly from CivilTime", () => {
    const civil = civilFromEpochMs(parseTimestamp("2026-08-05T00:00:00Z"));
    expect(MONTH_NAMES[civil.month - 1]).toBe("Aug");
    expect(WEEKDAY_NAMES[civil.weekday]).toBe("Wed");
  });
});

describe("caller-supplied civil time", () => {
  it("uses the day it bounds-checked, not a later read of it", () => {
    // `day` was validated against the range and against `daysInMonth`, then
    // read again for `dayOfYear`. A getter could satisfy both checks and shift
    // the arithmetic — and this function is what confines the year to
    // 1970–9999, which the 24-character instant and the transcript's
    // rendered-line bound both rest on.
    let reads = 0;
    const shifty = {
      year: 2026,
      month: 2,
      get day(): number {
        reads += 1;
        // `> 1`, like every sibling getter here. The site has exactly two
        // possible reads, so a `> 2` threshold never diverges: the test then
        // passes under a reverted capture and is held up by its read counter
        // alone. The same off-by-one was found in `registry.test.ts`.
        return reads > 1 ? 99 : 28;
      },
    };

    expect(epochMsFromCivil(shifty)).toBe(
      epochMsFromCivil({ year: 2026, month: 2, day: 28 }),
    );
    expect(reads).toBe(1);
  });

  it("uses the year and month it bounds-checked, not later reads", () => {
    // Each of the three is a separate capture; pinning `day` alone left the
    // other two revertible in silence.
    const expected = epochMsFromCivil({ year: 2026, month: 2, day: 28 });

    let yearReads = 0;
    expect(
      epochMsFromCivil({
        get year(): number {
          yearReads += 1;
          return yearReads > 1 ? 2027 : 2026;
        },
        month: 2,
        day: 28,
      }),
    ).toBe(expected);
    expect(yearReads).toBe(1);

    let monthReads = 0;
    expect(
      epochMsFromCivil({
        year: 2026,
        get month(): number {
          monthReads += 1;
          return monthReads > 1 ? 11 : 2;
        },
        day: 28,
      }),
    ).toBe(expected);
    expect(monthReads).toBe(1);
  });

  it("uses the time-of-day fields it bounds-checked, not later reads", () => {
    // The four the comment above the captures calls "already captured". Each
    // is read once through `?? 0`, bounds-checked as that capture, and then
    // used only in the closing sum — so a second read there satisfies every
    // check and still moves the instant, silently. `parseTimestamp` composes
    // through here, so this is what every cartridge `startedAt` and every
    // restored transcript stamp is built on.
    const expected = epochMsFromCivil({
      year: 2026,
      month: 8,
      day: 5,
      hour: 9,
      minute: 14,
      second: 22,
      millisecond: 500,
    });

    // Each second read is itself in range, which is the point: nothing
    // downstream re-validates, so the divergence is a wrong instant rather
    // than a refusal.
    let hourReads = 0;
    expect(
      epochMsFromCivil({
        year: 2026,
        month: 8,
        day: 5,
        get hour(): number {
          hourReads += 1;
          return hourReads > 1 ? 23 : 9;
        },
        minute: 14,
        second: 22,
        millisecond: 500,
      }),
    ).toBe(expected);
    expect(hourReads).toBe(1);

    let minuteReads = 0;
    expect(
      epochMsFromCivil({
        year: 2026,
        month: 8,
        day: 5,
        hour: 9,
        get minute(): number {
          minuteReads += 1;
          return minuteReads > 1 ? 59 : 14;
        },
        second: 22,
        millisecond: 500,
      }),
    ).toBe(expected);
    expect(minuteReads).toBe(1);

    let secondReads = 0;
    expect(
      epochMsFromCivil({
        year: 2026,
        month: 8,
        day: 5,
        hour: 9,
        minute: 14,
        get second(): number {
          secondReads += 1;
          return secondReads > 1 ? 59 : 22;
        },
        millisecond: 500,
      }),
    ).toBe(expected);
    expect(secondReads).toBe(1);

    let millisecondReads = 0;
    expect(
      epochMsFromCivil({
        year: 2026,
        month: 8,
        day: 5,
        hour: 9,
        minute: 14,
        second: 22,
        get millisecond(): number {
          millisecondReads += 1;
          return millisecondReads > 1 ? 999 : 500;
        },
      }),
    ).toBe(expected);
    expect(millisecondReads).toBe(1);
  });
});
