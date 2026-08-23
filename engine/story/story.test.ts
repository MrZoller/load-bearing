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
const INCIDENT_COUNTERS = [
  { id: "flail", value: 0 },
  { id: "capitulation", value: 0 },
] as const;

function bootstrap() {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events: [] });
}

function hostileStorySlice(slice: unknown): string {
  const recorded = deserialize(snapshot(bootstrap())) as Record<
    string,
    unknown
  >;
  const slices = recorded["slices"] as Record<string, unknown>;
  slices["story"] = { rareEvents: [], ...(slice as Record<string, unknown>) };
  return serialize(recorded);
}

describe("shared story beats", () => {
  it("bootstraps at the cartridge initial beat", () => {
    expect(readStorySlice(bootstrap())).toEqual({
      stage: 0,
      currentBeat: "incident-open",
      currentVariant: "",
      facts: [],
      counters: INCIDENT_COUNTERS,
      rareEvents: [],
      discoveredEndings: [],
    });
  });

  it("initializes rare-event rows in declaration order and rejects altered recorded rows", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      rareEvents: [
        {
          id: "first",
          eligibility: { kind: "file-exists", path: "/etc/motd", exists: true },
          fireWeight: 1,
          missWeight: 1,
        },
        {
          id: "second",
          eligibility: { kind: "file-exists", path: "/missing", exists: true },
          fireWeight: 1,
          missWeight: 1,
        },
      ],
      beats: [{ id: "start", ending: "" }],
      endings: [],
    };
    const state = reduce({
      cartridge: loadCartridge(source),
      seed: SEED,
      events: [],
    });
    expect(readStorySlice(state).rareEvents).toEqual([
      { id: "first", evaluated: false, fired: false },
      { id: "second", evaluated: false, fired: false },
    ]);

    const recorded = deserialize(snapshot(state)) as Record<string, unknown>;
    const slices = recorded["slices"] as Record<
      string,
      Record<string, unknown>
    >;
    for (const [rareEvents, message] of [
      [
        [
          { id: "second", evaluated: false, fired: false },
          { id: "first", evaluated: false, fired: false },
        ],
        /expected declared rare event "first"/,
      ],
      [
        [
          { id: "first", evaluated: false, fired: true },
          { id: "second", evaluated: false, fired: false },
        ],
        /cannot be true before evaluation/,
      ],
    ] as const) {
      slices["story"] = { ...slices["story"], rareEvents };
      expect(() => restoreSnapshot(serialize(recorded))).toThrow(message);
    }
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
      counters: INCIDENT_COUNTERS,
      rareEvents: [],
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
          counters: INCIDENT_COUNTERS,
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
          counters: INCIDENT_COUNTERS,
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
          counters: INCIDENT_COUNTERS,
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
          counters: INCIDENT_COUNTERS,
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
          counters: INCIDENT_COUNTERS,
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
      rareEvents: [],
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
      rareEvents: [],
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
          counters: INCIDENT_COUNTERS,
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

  it("evaluates each newly eligible rare event once after an expansion has staged its final state", () => {
    const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
    (source["story"] as Record<string, unknown>)["phase2"] = {
      initialBeat: "start",
      rareEvents: [
        {
          id: "after-removal",
          eligibility: {
            kind: "file-exists",
            path: "/etc/motd",
            exists: false,
          },
          fireWeight: 1,
          missWeight: 1,
        },
      ],
      beats: [{ id: "start", ending: "" }],
      endings: [],
    };
    const cartridge = loadCartridge(source);
    const before = reduce({ cartridge, seed: SEED, events: [] });
    const afterRemoval = step(before, createShellExecuteEvent("rm /etc/motd"));

    expect(readStorySlice(afterRemoval).rareEvents).toMatchObject([
      { id: "after-removal", evaluated: true },
    ]);
    const cursor =
      afterRemoval.random.cursors["root/story/rare-events/after-removal"];
    const afterAnotherTransition = step(
      afterRemoval,
      createShellExecuteEvent("pwd"),
    );
    expect(readStorySlice(afterAnotherTransition).rareEvents).toEqual(
      readStorySlice(afterRemoval).rareEvents,
    );
    expect(
      afterAnotherTransition.random.cursors[
        "root/story/rare-events/after-removal"
      ],
    ).toBe(cursor);
  });

  it("keeps rare-event outcomes reproducible and isolated by id", () => {
    const build = (ids: readonly string[], modelsReversed = false) => {
      const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
      (source["story"] as Record<string, unknown>)["phase2"] = {
        initialBeat: "start",
        rareEvents: ids.map((id) => ({
          id,
          eligibility: { kind: "file-exists", path: "/etc/motd", exists: true },
          fireWeight: 1,
          missWeight: 2,
        })),
        beats: [{ id: "start", ending: "" }],
        endings: [],
      };
      if (modelsReversed) {
        const models = source["models"] as unknown[];
        source["models"] = [...models].reverse();
      }
      return loadCartridge(source);
    };
    const outcomes = (
      cartridge: ReturnType<typeof build>,
      unrelated = false,
      switchModel = false,
    ) => {
      let state = reduce({ cartridge, seed: SEED, events: [] });
      if (unrelated)
        state = step(state, {
          type: "probe.random",
          payload: { stream: "unrelated", count: 7, form: "uint32" },
        });
      // A real terminal transition is itself a completed top-level event. With
      // this condition already true it performs the first evaluation; its
      // outcome must match the otherwise unrelated clock transition below.
      if (switchModel)
        state = step(state, createTerminalModelEvent("quick-patch"));
      state = step(state, { type: "clock.tick", payload: { ms: 0 } });
      return Object.fromEntries(
        readStorySlice(state).rareEvents.map(({ id, fired }) => [id, fired]),
      );
    };

    const baseline = outcomes(build(["first", "second"]));
    expect(outcomes(build(["first", "second"]))).toEqual(baseline);
    expect(outcomes(build(["second", "first"]))).toEqual(baseline);
    expect(outcomes(build(["first", "second"]), true)).toEqual(baseline);
    expect(outcomes(build(["first", "second"]), false, true)).toEqual(baseline);
  });

  it("refuses forged rare-event owner events at the public reducer boundary", () => {
    expect(() =>
      step(bootstrap(), {
        type: "story.rare-event-evaluated",
        payload: { id: "anything", fired: true },
      }),
    ).toThrow(/cannot be logged or runtime-dispatched/);
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
