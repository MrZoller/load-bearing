import { describe, expect, it } from "vitest";

import { serialize } from "../serialize/canonical.js";
import { MAX_EPOCH_MS, MS_PER_HOUR, parseTimestamp } from "./civil.js";
import { createClock, restoreClock } from "./clock.js";

const START = "2026-08-05T09:14:22.000Z";

describe("createClock", () => {
  it("starts at the cartridge-declared time", () => {
    expect(createClock(START).timestamp()).toBe("2026-08-05T09:14:22.000Z");
    expect(createClock(START).now()).toBe(parseTimestamp(START));
    expect(createClock(START).elapsed()).toBe(0);
  });

  it("accepts epoch milliseconds directly", () => {
    expect(createClock(parseTimestamp(START)).now()).toBe(
      createClock(START).now(),
    );
  });

  it("rejects a start outside the representable range", () => {
    for (const start of [-1, MAX_EPOCH_MS + 1, 1.5]) {
      expect(() => createClock(start)).toThrow(/session start must be/);
    }
  });

  it("rejects a start that is not a UTC timestamp", () => {
    expect(() => createClock("2026-08-05 09:14:22")).toThrow(
      /must be YYYY-MM-DDTHH/,
    );
  });
});

describe("advance", () => {
  it("moves only when told to", () => {
    const clock = createClock(START);
    expect(clock.timestamp()).toBe("2026-08-05T09:14:22.000Z");
    expect(clock.timestamp()).toBe("2026-08-05T09:14:22.000Z");

    clock.advance(38000);
    expect(clock.timestamp()).toBe("2026-08-05T09:15:00.000Z");
    expect(clock.elapsed()).toBe(38000);
  });

  it("returns the new instant", () => {
    const clock = createClock(START);
    expect(clock.advance(1500)).toBe(parseTimestamp(START) + 1500);
  });

  it("accumulates across ticks and rolls the calendar", () => {
    const clock = createClock(START);
    for (let hour = 0; hour < 24; hour += 1) clock.advance(MS_PER_HOUR);
    expect(clock.timestamp()).toBe("2026-08-06T09:14:22.000Z");
  });

  it("allows a zero tick, for events that take no simulated time", () => {
    const clock = createClock(START);
    expect(clock.advance(0)).toBe(parseTimestamp(START));
  });

  it("refuses to run backwards", () => {
    const clock = createClock(START);
    expect(() => clock.advance(-1)).toThrow(/non-negative integer/);
    expect(clock.elapsed()).toBe(0);
  });

  it("refuses a fractional millisecond", () => {
    expect(() => createClock(START).advance(0.5)).toThrow(
      /non-negative integer/,
    );
  });

  it("refuses to pass the last representable instant", () => {
    const clock = createClock(MAX_EPOCH_MS - 10);
    expect(() => clock.advance(11)).toThrow(/last representable instant/);
    expect(clock.advance(10)).toBe(MAX_EPOCH_MS);
  });
});

describe("civil", () => {
  it("reports UTC calendar fields for the current instant", () => {
    const clock = createClock(START);
    clock.advance(MS_PER_HOUR * 3);
    expect(clock.civil()).toEqual({
      year: 2026,
      month: 8,
      day: 5,
      hour: 12,
      minute: 14,
      second: 22,
      millisecond: 0,
      weekday: 3,
    });
  });
});

describe("state", () => {
  it("round-trips byte-identically through the canonical serializer", () => {
    const clock = createClock(START);
    clock.advance(1234);
    clock.advance(5678);

    const recorded = serialize(clock.toState());
    expect(serialize(restoreClock(clock.toState()).toState())).toBe(recorded);
  });

  it("restores to the same instant, and keeps advancing from it", () => {
    const clock = createClock(START);
    clock.advance(90061001);

    const restored = restoreClock(clock.toState());
    expect(restored.now()).toBe(clock.now());
    expect(restored.timestamp()).toBe(clock.timestamp());

    expect(restored.advance(1000)).toBe(clock.advance(1000));
  });

  it("keeps start and elapsed apart, so session duration survives a reload", () => {
    const clock = createClock(START);
    clock.advance(4500);

    expect(clock.toState()).toEqual({
      startMs: parseTimestamp(START),
      elapsedMs: 4500,
    });
    expect(restoreClock(clock.toState()).elapsed()).toBe(4500);
  });

  it("rejects state that would replay differently than it was recorded", () => {
    const valid = createClock(START).toState();

    expect(() => restoreClock({ ...valid, startMs: -1 })).toThrow(
      /session start must be/,
    );
    expect(() => restoreClock({ ...valid, elapsedMs: -1 })).toThrow(
      /elapsed must be an integer/,
    );
    expect(() => restoreClock({ ...valid, elapsedMs: 0.5 })).toThrow(
      /elapsed must be an integer/,
    );
    expect(() => restoreClock({ ...valid, elapsedMs: MAX_EPOCH_MS })).toThrow(
      /elapsed must be an integer/,
    );
  });
});
