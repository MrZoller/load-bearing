import { describe, expect, it } from "vitest";

import incident from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import { deserialize, serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import {
  createMindCompactEvent,
  createMindPermissionChoiceEvent,
  createMindPermissionRequestEvent,
} from "../mind/module.js";
import { createTerminalModelEvent } from "../terminal/module.js";
import {
  createStoryBeatReachedEvent,
  createStoryFactRecordedEvent,
} from "./module.js";
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
      stage: 0,
      currentBeat: "incident-open",
      currentVariant: "",
      facts: [],
      counters: [],
      discoveredEndings: [],
    });
  });

  it("reaches authored beats and records endings once in first-discovery order", () => {
    let state = bootstrap();
    state = step(state, {
      type: "mind.belief-set",
      payload: {
        belief: {
          kind: "file-contents",
          path: "/production/load-balancer/config/routes.conf",
          contents: "health_status=500\neurope_attached=true\n",
        },
      },
    });
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
      stage: 0,
      currentBeat: "load-bearing-declaration",
      currentVariant: "preserved-load-bearing-response",
      facts: [{ id: "callback-load-bearing-response", kind: "callback" }],
      counters: [],
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
          stage: 0,
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          counters: [],
          discoveredEndings: [],
          extra: true,
        },
        /unexpected field\(s\) extra/,
      ],
      [
        {
          stage: 5,
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          counters: [],
          discoveredEndings: [],
        },
        /stage: must be an escalation stage from 0 through 4/,
      ],
      [
        {
          stage: 0,
          currentBeat: "invented-beat",
          currentVariant: "",
          facts: [],
          counters: [],
          discoveredEndings: [],
        },
        /currentBeat: unknown beat "invented-beat"/,
      ],
      [
        {
          stage: 0,
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          counters: [],
          discoveredEndings: ["load-bearing-response", "load-bearing-response"],
        },
        /discoveredEndings\[1\]: duplicate ending/,
      ],
      [
        {
          stage: 0,
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [],
          counters: [],
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
      stage: 0,
      currentBeat: "start",
      currentVariant: "first",
      facts: [{ id: "first-fact", kind: "callback" }],
      counters: [],
      discoveredEndings: ["first-ending"],
    });
    selected = step(selected, createStoryBeatReachedEvent("start"));
    selected = step(selected, createStoryBeatReachedEvent("fallback"));
    expect(readStorySlice(selected)).toEqual({
      stage: 0,
      currentBeat: "fallback",
      currentVariant: "",
      facts: [
        { id: "first-fact", kind: "callback" },
        { id: "base-fact", kind: "reveal" },
      ],
      counters: [],
      discoveredEndings: ["first-ending", "base-ending"],
    });
  });

  it("rejects snapshots that omit or contradict the new story state", () => {
    for (const [slice, message] of [
      [
        { stage: 0, currentBeat: "incident-open", discoveredEndings: [] },
        /currentVariant: must be empty or a story variant identifier/,
      ],
      [
        {
          stage: 0,
          currentBeat: "incident-open",
          currentVariant: "",
          facts: [{ id: "made-up", kind: "reveal" }],
          counters: [],
          discoveredEndings: [],
        },
        /unknown fact "made-up"/,
      ],
    ] as const)
      expect(() => restoreSnapshot(hostileStorySlice(slice))).toThrow(message);
  });

  it("requires snapshot counters to exactly preserve declaration order, count, and bounds", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      counters: [
        { id: "first", initial: 1, maximum: 2 },
        { id: "second", initial: 0, maximum: 3 },
      ],
      beats: [{ id: "start", ending: "" }],
      endings: [],
    };
    const cartridge = loadCartridge(source);
    const state = reduce({ cartridge, seed: SEED, events: [] });
    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const slices = recorded["slices"] as Record<
      string,
      Record<string, unknown>
    >;

    expect(readStorySlice(state).counters).toEqual([
      { id: "first", value: 1 },
      { id: "second", value: 0 },
    ]);
    for (const [counters, message] of [
      [[{ id: "first", value: 1 }], /expected exactly 2 declared counters/],
      [
        [
          { id: "second", value: 0 },
          { id: "first", value: 1 },
        ],
        /expected declared counter "first"/,
      ],
      [
        [
          { id: "first", value: 0 },
          { id: "second", value: 0 },
        ],
        /between initial 1 and maximum 2/,
      ],
      [
        [
          { id: "first", value: 1 },
          { id: "second", value: 4 },
        ],
        /between initial 0 and maximum 3/,
      ],
    ] as const) {
      slices["story"] = { ...slices["story"], counters };
      expect(() => restoreSnapshot(serialize(recorded))).toThrow(message);
    }
  });

  it("advances once per complete transaction for command, model, permission, compact and reveal triggers", () => {
    let state = bootstrap();
    state = step(
      state,
      createShellExecuteEvent("loadbearing --resume incident-001"),
    );
    expect(readStorySlice(state).stage).toBe(0);
    state = step(state, createShellExecuteEvent("pwd"));
    expect(readStorySlice(state).stage).toBe(1);
    expect(
      state.transcript.some((entry) => entry.type === "story.stage-advanced"),
    ).toBe(false);

    state = step(state, createShellExecuteEvent("pwd"));
    expect(readStorySlice(state).stage).toBe(1);
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    expect(readStorySlice(state).stage).toBe(2);
    state = step(state, createTerminalModelEvent("temporary-shoring"));
    expect(readStorySlice(state).stage).toBe(2);

    state = step(state, {
      type: "mind.permission-decision",
      payload: {
        decision: "grant",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      },
    });
    expect(readStorySlice(state).stage).toBe(3);
    state = step(state, createMindCompactEvent("summary", []));
    expect(readStorySlice(state).stage).toBe(4);

    expect(() =>
      step(state, {
        type: "story.stage-advanced",
        payload: { from: 4, to: 5 },
      }),
    ).toThrow(/cannot be logged or runtime-dispatched/);

    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      facts: [{ id: "new-evidence", kind: "reveal" }],
      beats: [{ id: "start", ending: "" }],
      endings: [],
      transitions: [
        {
          from: 0,
          to: 1,
          trigger: { kind: "reveal", fact: "new-evidence" },
        },
      ],
    };
    const revealCartridge = loadCartridge(source);
    let revealState = reduce({
      cartridge: revealCartridge,
      seed: SEED,
      events: [],
    });
    revealState = step(
      revealState,
      createStoryFactRecordedEvent("new-evidence"),
    );
    expect(readStorySlice(revealState).stage).toBe(1);
    revealState = step(
      revealState,
      createStoryFactRecordedEvent("new-evidence"),
    );
    expect(readStorySlice(revealState).stage).toBe(1);
  });

  it("publishes only one adjacent advance when one expansion records two matching facts", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    const story = source["story"] as Record<string, unknown>;
    story["intents"] = [
      {
        id: "ask",
        patterns: ["ask"],
        response: "fixture-response",
        actions: [
          {
            kind: "permission-request",
            id: "write-one",
            capability: { kind: "exact", action: "write", resource: "/one" },
            grant: [{ kind: "story-reach", beat: "revealing" }],
            deny: [],
            alwaysAllow: [],
          },
        ],
      },
    ];
    story["phase2"] = {
      initialBeat: "start",
      facts: [{ id: "new-evidence", kind: "reveal" }],
      beats: [
        { id: "start", ending: "" },
        { id: "revealing", ending: "", facts: ["new-evidence"] },
      ],
      endings: [],
      transitions: [
        {
          from: 0,
          to: 1,
          trigger: {
            kind: "permission",
            decision: "grant",
            capability: { kind: "exact", action: "write", resource: "/one" },
          },
        },
        {
          from: 1,
          to: 2,
          trigger: { kind: "reveal", fact: "new-evidence" },
        },
      ],
    };
    const cartridge = loadCartridge(source);
    let state = reduce({ cartridge, seed: SEED, events: [] });
    state = step(state, createMindPermissionRequestEvent("write-one"));
    state = step(state, createMindPermissionChoiceEvent("write-one", "grant"));

    expect(readStorySlice(state)).toMatchObject({
      stage: 1,
      currentBeat: "revealing",
      facts: [{ id: "new-evidence", kind: "reveal" }],
    });
  });
});
