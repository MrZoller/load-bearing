import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_START_MS, replaySession } from "./session.js";
import type { EngineEvent } from "./session.js";
import { formatTimestamp, parseTimestamp } from "./clock/civil.js";

const SEED = "2026-08-05/0/deep-foundation";
const STARTED_AT = "2026-08-05T09:14:22.000Z";

function replay(cartridge: unknown, events: readonly EngineEvent[]) {
  return replaySession({ cartridge, seed: SEED, events });
}

describe("replaySession", () => {
  it("is pure: the same input folds to the same output", () => {
    const events: readonly EngineEvent[] = [
      { type: "session.start" },
      { type: "clock.tick", payload: { ms: 1500 } },
      {
        type: "random.draw",
        payload: { stream: "spinner.verbs", count: 4, form: "uint32" },
      },
    ];
    const cartridge = { meta: { startedAt: STARTED_AT } };

    expect(replay(cartridge, events)).toEqual(replay(cartridge, events));
  });

  it("carries the clock and the PRNG into serialized state", () => {
    const output = replay({ meta: { startedAt: STARTED_AT } }, [
      { type: "clock.tick", payload: { ms: 2500 } },
      {
        type: "random.draw",
        payload: { stream: "pids", count: 2, form: "uint32" },
      },
    ]);

    expect(output.state.clock).toEqual({
      startMs: parseTimestamp(STARTED_AT),
      elapsedMs: 2500,
    });
    expect(Object.keys(output.state.random.cursors)).toEqual(["root/pids"]);
  });

  it("stamps each event with the instant it was issued, not the one it ended at", () => {
    const output = replay({ meta: { startedAt: STARTED_AT } }, [
      { type: "clock.tick", payload: { ms: 60000 } },
      { type: "session.end" },
    ]);

    expect(output.transcript[0]).toContain(STARTED_AT);
    expect(output.transcript[1]).toContain("2026-08-05T09:15:22.000Z");
  });
});

describe("meta.startedAt", () => {
  it("starts the clock where the cartridge says", () => {
    const output = replay({ meta: { startedAt: STARTED_AT } }, []);
    expect(output.state.clock.startMs).toBe(parseTimestamp(STARTED_AT));
  });

  it("falls back to a visibly wrong default when the cartridge is silent", () => {
    for (const cartridge of [{}, { meta: {} }, null, "not a cartridge", []]) {
      expect(replay(cartridge, []).state.clock.startMs).toBe(
        DEFAULT_SESSION_START_MS,
      );
    }
    expect(formatTimestamp(DEFAULT_SESSION_START_MS)).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("rejects a declared start that is not a UTC timestamp", () => {
    expect(() => replay({ meta: { startedAt: 12345 } }, [])).toThrow(
      /meta.startedAt must be a UTC timestamp string/,
    );
    expect(() => replay({ meta: { startedAt: "2026-08-05" } }, [])).toThrow(
      /must be YYYY-MM-DDTHH/,
    );
  });
});

describe("probe events", () => {
  const cartridge = { meta: { startedAt: STARTED_AT } };

  it("names the resolved stream path, so a fixture says which stream moved", () => {
    const output = replay(cartridge, [
      {
        type: "random.draw",
        payload: { stream: "spinner/verbs", count: 1, form: "uint32" },
      },
      { type: "random.draw", payload: { stream: "", count: 1, form: "float" } },
    ]);

    expect(output.transcript[0]).toContain("stream=root/spinner/verbs");
    expect(output.transcript[3]).toContain("stream=root ");
  });

  it("tallies a weighted distribution, zero-weight entries included", () => {
    const output = replay(cartridge, [
      {
        type: "random.weighted",
        payload: {
          stream: "rare-events",
          count: 100,
          entries: [
            { value: "off", weight: 0 },
            { value: "on", weight: 1 },
          ],
        },
      },
    ]);

    expect(output.transcript[1]).toMatch(/off\s+weight=\s+0\s+picks=\s+0/);
    expect(output.transcript[2]).toMatch(/on\s+weight=\s+1\s+picks=\s+100/);
  });

  it("records a snapshot whose picks sum to the count", () => {
    // The property the duplicate-value rejection exists to keep true: rows are
    // labelled by value, so a snapshot whose column does not sum to `count` is
    // reporting one arm's draws against two labels.
    const count = 4000;
    const output = replay(cartridge, [
      {
        type: "random.weighted",
        payload: {
          stream: "rare-events",
          count,
          entries: [
            { value: "off", weight: 0 },
            { value: "rare", weight: 1 },
            { value: "common", weight: 9 },
          ],
        },
      },
    ]);

    const picks = output.transcript
      .slice(1, 4)
      .map((line) => Number(/picks=\s*(\d+)/.exec(line)?.[1]));

    expect(picks[0]).toBe(0);
    expect(picks.reduce((sum, hits) => sum + hits, 0)).toBe(count);
  });

  it("ignores event types it does not know, rather than failing on them", () => {
    const output = replay(cartridge, [
      { type: "shell.exec", payload: { input: "ls -la" } },
    ]);
    expect(output.transcript).toEqual([`0000  ${STARTED_AT}  shell.exec`]);
  });

  it("rejects a probe payload it cannot trust", () => {
    const cases: readonly (readonly [EngineEvent, RegExp])[] = [
      [{ type: "clock.tick" }, /requires a payload/],
      [{ type: "clock.tick", payload: { ms: -1 } }, /ms must be an integer/],
      [
        { type: "random.draw", payload: { stream: "a", count: 1 } },
        /form must be a string/,
      ],
      [
        {
          type: "random.draw",
          payload: { stream: "a", count: 1, form: "double" },
        },
        /form must be "uint32" or "float"/,
      ],
      [
        { type: "random.int", payload: { stream: "a", count: 1, max: 0 } },
        /max must be an integer/,
      ],
      [
        { type: "random.weighted", payload: { stream: "a", count: 1 } },
        /entries must be an array/,
      ],
      [
        {
          type: "random.weighted",
          payload: { stream: "a", count: 1, entries: [{ weight: 1 }] },
        },
        /value must be a string/,
      ],
      [
        {
          type: "random.weighted",
          payload: {
            stream: "a",
            count: 1,
            entries: [
              { value: "same", weight: 0 },
              { value: "same", weight: 1 },
            ],
          },
        },
        /already appears in this snapshot/,
      ],
    ];

    for (const [event, expected] of cases) {
      expect(() => replay(cartridge, [event])).toThrow(expected);
    }
  });

  it("names the offending event, since a fixture has many", () => {
    expect(() =>
      replay(cartridge, [{ type: "session.start" }, { type: "clock.tick" }]),
    ).toThrow(/event 1 \(clock\.tick\)/);
  });
});
