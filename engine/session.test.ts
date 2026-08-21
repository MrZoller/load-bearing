import { describe, expect, it } from "vitest";

import { replaySession } from "./session.js";
import type { EngineEvent } from "./session.js";
import { parseTimestamp } from "./clock/civil.js";
import { loadCartridge } from "./cartridge/load.js";
import type { LoadedCartridge } from "./cartridge/types.js";
import { renderTranscript } from "./events/transcript.js";

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
    identity: { user: "root", group: "root", home: "/root" },
    gitIdentity: { name: "Visitor", email: "visitor@example.test" },
    system: {
      hostname: "session",
      operatingSystem: "Linux",
      kernelRelease: "6.1.0",
      architecture: "x86_64",
      bootedAt: "2026-08-01T00:00:00.000Z",
    },
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
      { type: "clock.tick", payload: { ms: 1500 } },
      {
        type: "probe.random",
        payload: { stream: "spinner.verbs", count: 4, form: "uint32" },
      },
    ];

    expect(replay(CARTRIDGE, events)).toEqual(replay(CARTRIDGE, events));
  });

  it("carries the clock and the PRNG into serialized state", () => {
    const output = replay(CARTRIDGE, [
      { type: "clock.tick", payload: { ms: 2500 } },
      {
        type: "probe.random",
        payload: { stream: "pids", count: 2, form: "uint32" },
      },
    ]);

    expect(output.state.clock).toEqual({
      startMs: parseTimestamp(STARTED_AT),
      elapsedMs: 2500,
    });
    expect(Object.keys(output.state.random.cursors)).toEqual([
      "root/probe/pids",
    ]);
  });

  it("renders the transcript the reducer folded, rather than a second one", () => {
    // The transcript is state. This function is a view of it, so the two can
    // never disagree — which is what makes `transcript.txt` and `state.json`
    // one contract recorded twice rather than two contracts that might drift.
    const output = replay(CARTRIDGE, [
      { type: "clock.tick", payload: { ms: 60000 } },
      { type: "clock.tick", payload: { ms: 0 } },
    ]);

    expect(output.transcript).toEqual(
      renderTranscript(output.state.transcript),
    );
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
