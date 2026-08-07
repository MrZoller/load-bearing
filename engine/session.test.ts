import { describe, expect, it } from "vitest";

import { replaySession } from "./session.js";
import type { EngineEvent } from "./session.js";
import { parseTimestamp } from "./clock/civil.js";
import { loadCartridge } from "./cartridge/load.js";
import type { LoadedCartridge } from "./cartridge/types.js";

const SEED = "2026-08-05/0/deep-foundation";
const STARTED_AT = "2026-08-05T09:14:22.000Z";

/**
 * The smallest world that loads. `replaySession` takes a validated cartridge,
 * so these tests build one the same way production does rather than casting a
 * literal past the type.
 */
const CARTRIDGE: LoadedCartridge = loadCartridge({
  meta: {
    schemaVersion: 0,
    number: 1,
    date: "2026-08-05",
    title: "Session Fixture",
    assignment: "Exercise the fold.",
    startedAt: STARTED_AT,
  },
  repository: {
    cwd: "/srv/app",
    files: { "/srv/app/main.ts": { contents: "export const load = 1;\n" } },
  },
  models: [
    {
      id: "deep-foundation",
      name: "Deep Foundation",
      archetype: "paranoid",
      description: "Thorough.",
      costMultiplier: 1,
    },
  ],
});

function replay(cartridge: LoadedCartridge, events: readonly EngineEvent[]) {
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

    expect(replay(CARTRIDGE, events)).toEqual(replay(CARTRIDGE, events));
  });

  it("carries the clock and the PRNG into serialized state", () => {
    const output = replay(CARTRIDGE, [
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
    const output = replay(CARTRIDGE, [
      { type: "clock.tick", payload: { ms: 60000 } },
      { type: "session.end" },
    ]);

    expect(output.transcript[0]).toContain(STARTED_AT);
    expect(output.transcript[1]).toContain("2026-08-05T09:15:22.000Z");
  });
});

describe("the cartridge's declared start", () => {
  it("is where the clock starts", () => {
    expect(replay(CARTRIDGE, []).state.clock.startMs).toBe(
      parseTimestamp(STARTED_AT),
    );
  });

  it("carries the normalized cartridge into state", () => {
    // Not the JSON that was written: the loader filled `mode`, `owner`,
    // `group` and `mtime`, and a recording captures what the engine ran on.
    const file = replay(CARTRIDGE, []).state.cartridge.repository.files[
      "/srv/app/main.ts"
    ];
    expect(file).toEqual({
      contents: "export const load = 1;\n",
      mode: "0644",
      owner: "root",
      group: "root",
      mtime: STARTED_AT,
    });
  });
});

describe("probe events", () => {
  const cartridge = CARTRIDGE;

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
