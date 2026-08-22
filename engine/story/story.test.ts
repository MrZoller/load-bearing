import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { createStoryBeatReachedEvent } from "./module.js";
import { readStorySlice } from "./story.js";

const CARTRIDGE = loadCartridge(incident);
const SEED = "2026-08-22/0/deep-foundation";

function bootstrap() {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });
}

function hostileStorySlice(slice: unknown): string {
  const recorded = deserialize(snapshot(bootstrap())) as Record<
    string,
    unknown
  >;
  const slices = recorded["slices"] as Record<string, unknown>;
  slices["story"] = slice;
  return serialize(recorded);
}

describe("shared story beats", () => {
  it("bootstraps at the cartridge initial beat", () => {
    expect(readStorySlice(bootstrap())).toEqual({
      currentBeat: "incident-open",
      discoveredEndings: [],
    });
  });

  it("reaches authored beats and records endings once in first-discovery order", () => {
    let state = bootstrap();
    state = step(state, createStoryBeatReachedEvent("regional-coupling"));
    state = step(
      state,
      createStoryBeatReachedEvent("load-bearing-declaration"),
    );
    state = step(
      state,
      createStoryBeatReachedEvent("load-bearing-declaration"),
    );

    expect(readStorySlice(state)).toEqual({
      currentBeat: "load-bearing-declaration",
      discoveredEndings: ["load-bearing-response"],
    });
  });

  it("refuses an event that reaches no authored beat", () => {
    expect(() =>
      step(bootstrap(), createStoryBeatReachedEvent("invented-beat")),
    ).toThrow(/story: unknown beat "invented-beat"/);
  });

  it("rejects hostile snapshots rather than accepting impossible story state", () => {
    for (const [slice, message] of [
      [
        { currentBeat: "incident-open", discoveredEndings: [], extra: true },
        /unexpected field\(s\) extra/,
      ],
      [
        { currentBeat: "invented-beat", discoveredEndings: [] },
        /currentBeat: unknown beat "invented-beat"/,
      ],
      [
        {
          currentBeat: "incident-open",
          discoveredEndings: ["load-bearing-response", "load-bearing-response"],
        },
        /discoveredEndings\[1\]: duplicate ending/,
      ],
      [
        {
          currentBeat: "incident-open",
          discoveredEndings: ["invented-ending"],
        },
        /discoveredEndings\[0\]: unknown ending "invented-ending"/,
      ],
    ] as const) {
      expect(() => restoreSnapshot(hostileStorySlice(slice))).toThrow(message);
    }
  });
});
