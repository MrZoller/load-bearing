import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
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
      currentVariant: "",
      facts: [],
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
      currentVariant: "",
      facts: [],
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
        {
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          discoveredEndings: [],
          extra: true,
        },
        /unexpected field\(s\) extra/,
      ],
      [
        {
          currentBeat: "invented-beat",
          currentVariant: "",
          facts: [],
          discoveredEndings: [],
        },
        /currentBeat: unknown beat "invented-beat"/,
      ],
      [
        {
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          discoveredEndings: ["load-bearing-response", "load-bearing-response"],
        },
        /discoveredEndings\[1\]: duplicate ending/,
      ],
      [
        {
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          discoveredEndings: ["invented-ending"],
        },
        /discoveredEndings\[0\]: unknown ending "invented-ending"/,
      ],
    ] as const) {
      expect(() => restoreSnapshot(hostileStorySlice(slice))).toThrow(message);
    }
  });

  it("uses the first pre-event matching variant as a complete outcome replacement", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      facts: [
        { id: "base-fact", kind: "reveal" },
        { id: "first-fact", kind: "callback" },
        { id: "second-fact", kind: "reveal" },
      ],
      beats: [
        {
          id: "start",
          ending: "base-ending",
          facts: ["base-fact"],
          variants: [
            {
              id: "first",
              when: [{ kind: "file-exists", path: "/etc/motd", exists: true }],
              ending: "first-ending",
              facts: ["first-fact"],
            },
            {
              id: "second",
              when: [{ kind: "file-exists", path: "/etc/motd", exists: true }],
              ending: "second-ending",
              facts: ["second-fact"],
            },
          ],
        },
        {
          id: "fallback",
          ending: "base-ending",
          facts: ["base-fact"],
          variants: [
            {
              id: "never",
              when: [{ kind: "file-exists", path: "/missing", exists: true }],
              ending: "second-ending",
              facts: ["second-fact"],
            },
          ],
        },
      ],
      endings: [
        { id: "base-ending", name: "Base" },
        { id: "first-ending", name: "First" },
        { id: "second-ending", name: "Second" },
      ],
    };
    const cartridge = loadCartridge(source);
    let selected = step(
      reduce({ cartridge, seed: SEED, events: [] }),
      createStoryBeatReachedEvent("start"),
    );

    expect(readStorySlice(selected)).toEqual({
      currentBeat: "start",
      currentVariant: "first",
      facts: [{ id: "first-fact", kind: "callback" }],
      discoveredEndings: ["first-ending"],
    });
    selected = step(selected, createStoryBeatReachedEvent("start"));
    selected = step(selected, createStoryBeatReachedEvent("fallback"));
    expect(readStorySlice(selected)).toEqual({
      currentBeat: "fallback",
      currentVariant: "",
      facts: [
        { id: "first-fact", kind: "callback" },
        { id: "base-fact", kind: "reveal" },
      ],
      discoveredEndings: ["first-ending", "base-ending"],
    });
  });

  it("rejects snapshots that omit or contradict the new story state", () => {
    for (const [slice, message] of [
      [
        { currentBeat: "incident-open", discoveredEndings: [] },
        /currentVariant: must be empty or a story variant identifier/,
      ],
      [
        {
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [{ id: "made-up", kind: "reveal" }],
          discoveredEndings: [],
        },
        /unknown fact "made-up"/,
      ],
    ] as const)
      expect(() => restoreSnapshot(hostileStorySlice(slice))).toThrow(message);
  });
});
