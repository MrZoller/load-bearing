import { describe, expect, it } from "vitest";

import incidentDocument from "../../content/incidents/incident-001.json";
import { createAgentInputEvents } from "../agent/intent.js";
import { loadCartridge } from "../cartridge/load.js";
import { createShellExecuteEvent } from "../commands/shell.js";
import { reduce, snapshot, step } from "../events/reduce.js";
import { readGitSlice } from "../git/module.js";
import { statusGit } from "../git/git.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { lookupProcess, lookupService, readWorldLog } from "../world/world.js";
import { createStoryBeatReachedEvent } from "./module.js";
import { readStorySlice } from "./story.js";
import { createTerminalModelEvent } from "../terminal/module.js";

const SEED = "2026-08-22/0/deep-foundation";

function sourceWithPhase2(phase2: Record<string, unknown>) {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  (source["story"] as Record<string, unknown>)["phase2"] = phase2;
  return source;
}

function sourceWithOwners(phase2: Record<string, unknown>) {
  const source = sourceWithPhase2(phase2);
  const repository = source["repository"] as Record<string, unknown>;
  repository["files"] = {
    ...(repository["files"] as Record<string, unknown>),
    "/usr/bin/story-worker": { contents: "worker\n" },
    "/var/log/story.log": { contents: "started\n" },
  };
  repository["services"] = [
    {
      id: "api",
      state: "running",
      health: "healthy",
      ports: [],
      dependencies: [],
    },
  ];
  repository["processes"] = [
    {
      id: "worker",
      pid: 1200,
      user: "root",
      command: { binary: "/usr/bin/story-worker", args: [] },
      startedAt: "2026-08-22T09:00:00.000Z",
      state: "running",
    },
  ];
  repository["logs"] = [
    { id: "story-log", kind: "file", path: "/var/log/story.log" },
  ];
  repository["reactions"] = [
    {
      id: "write-marks-api-degraded",
      on: "vfs.write",
      predicates: [],
      actions: [{ kind: "service-health", service: "api", health: "degraded" }],
    },
  ];
  return source;
}

describe("story consequence actions", () => {
  it("rations Incident #001 habits by intent applicability and preserves discoverable machine evidence", () => {
    const cartridge = loadCartridge(incidentDocument);
    const stateAt = (stage: 1 | 2 | 3, model: string) => {
      let state = reduce({ cartridge, seed: SEED, events: [] });
      state = step(state, createShellExecuteEvent("pwd"));
      if (stage >= 2)
        state = step(state, createTerminalModelEvent("temporary-shoring"));
      if (stage >= 3)
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
          version: 0,
        });
      return step(state, createTerminalModelEvent(model));
    };
    const applyInput = (state: ReturnType<typeof reduce>, input: string) =>
      createAgentInputEvents(cartridge, state, input).reduce(
        (next, event) => step(next, event),
        state,
      );
    const habitCases = [
      {
        input: "estimate the repair",
        beat: "fantasy-estimate",
        counter: "fantasy-estimate-used",
        stage: 1,
        model: "deep-foundation",
        nonmatchingModel: "drywall",
      },
      {
        input: "apply the smallest fix",
        beat: "scope-creep",
        counter: "scope-creep-used",
        stage: 2,
        model: "temporary-shoring",
        nonmatchingModel: "drywall",
      },
      {
        input: "write the victory summary",
        beat: "victory-summary",
        counter: "victory-summary-used",
        stage: 3,
        model: "drywall",
        nonmatchingModel: "temporary-shoring",
      },
      {
        input: "simplify the failing test",
        beat: "test-gaming",
        counter: "test-gaming-used",
        stage: 3,
        model: "temporary-shoring",
        nonmatchingModel: "drywall",
      },
    ] as const;

    const resultingStates = habitCases.map((habit) => {
      const nonmatchingBefore = stateAt(habit.stage, habit.nonmatchingModel);
      const nonmatching = createAgentInputEvents(
        cartridge,
        nonmatchingBefore,
        habit.input,
      );
      expect(nonmatching.map((event) => event.type)).toEqual([
        "agent.activity-set",
        "agent.message-added",
        "story.beat-reached",
        "story.counter-added",
        "agent.response-recorded",
        "agent.activity-set",
      ]);
      const nonmatchingAfter = nonmatching.reduce(
        (next, event) => step(next, event),
        nonmatchingBefore,
      );
      expect(readStorySlice(nonmatchingAfter)).toMatchObject({
        currentBeat: "regional-coupling",
        counters: expect.arrayContaining([{ id: "flail", value: 1 }]),
      });
      const otherStage = habit.stage === 3 ? 2 : ((habit.stage + 1) as 2 | 3);
      const wrongStage = createAgentInputEvents(
        cartridge,
        stateAt(otherStage, habit.model),
        habit.input,
      );
      expect(wrongStage.map((event) => event.type)).toEqual([
        "agent.activity-set",
        "agent.message-added",
        "story.beat-reached",
        "story.counter-added",
        "agent.response-recorded",
        "agent.activity-set",
      ]);

      const matched = applyInput(
        stateAt(habit.stage, habit.model),
        habit.input,
      );
      expect(readStorySlice(matched).counters).toContainEqual({
        id: habit.counter,
        value: 1,
      });
      const repeated = createAgentInputEvents(cartridge, matched, habit.input);
      expect(repeated.map((event) => event.type)).toEqual([
        "agent.activity-set",
        "agent.message-added",
        "story.beat-reached",
        "story.counter-added",
        "agent.response-recorded",
        "agent.activity-set",
      ]);
      const repeatedAfter = repeated.reduce(
        (next, event) => step(next, event),
        matched,
      );
      expect(readStorySlice(repeatedAfter)).toMatchObject({
        counters: expect.arrayContaining([{ id: "flail", value: 1 }]),
      });
      return matched;
    });
    const [estimateState, scopeState, victoryState, gamingState] =
      resultingStates;
    if (
      estimateState === undefined ||
      scopeState === undefined ||
      victoryState === undefined ||
      gamingState === undefined
    )
      throw new Error("habit matrix is incomplete");

    expect(
      readWorldLog(
        readWorldSlice(estimateState),
        readVfsSlice(estimateState),
        "health-check-log",
      ),
    ).toMatchObject({
      entries: expect.arrayContaining([
        "estimate: three sprints, four engineers, one regional policy liaison",
      ]),
    });

    expect(
      readVfs(
        readVfsSlice(victoryState),
        "/production/load-balancer/config/IMPLEMENTATION_SUMMARY.md",
      ),
    ).toMatchObject({
      ok: true,
      value: { contents: expect.stringContaining("Production ready") },
    });
    expect(
      statusGit(readGitSlice(victoryState), readVfsSlice(victoryState)),
    ).toContainEqual(
      expect.objectContaining({
        path: "/production/load-balancer/config/IMPLEMENTATION_SUMMARY.md",
        untracked: true,
      }),
    );

    expect(
      readVfs(
        readVfsSlice(gamingState),
        "/production/load-balancer/config/routes.expected.conf",
      ),
    ).toMatchObject({
      value: { contents: "health_status=500\neurope_attached=true\n" },
    });
    expect(
      statusGit(readGitSlice(gamingState), readVfsSlice(gamingState)),
    ).toContainEqual(
      expect.objectContaining({
        path: "/production/load-balancer/config/routes.expected.conf",
        untracked: true,
      }),
    );

    expect(
      lookupService(readWorldSlice(scopeState), "endpoint-responder"),
    ).toMatchObject({ state: "running", health: "healthy" });
    expect(
      lookupService(readWorldSlice(scopeState), "regional-router"),
    ).toMatchObject({ state: "running", health: "unhealthy" });
    expect(cartridge.repository.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "health-status-200" }),
        expect.objectContaining({ id: "europe-attached" }),
      ]),
    );

    const habits = cartridge.story.intents.filter((intent) =>
      [
        "scope-creep",
        "victory-summary",
        "test-gaming",
        "fantasy-estimate",
      ].includes(intent.response),
    );
    expect(
      habits.map(({ id, response, applicability }) => ({
        id,
        response,
        applicability,
      })),
    ).toEqual([
      {
        id: "apply-smallest-fix",
        response: "scope-creep",
        applicability: {
          archetype: "reckless",
          stage: 2,
          when: [
            {
              kind: "story-counter",
              counter: "scope-creep-used",
              comparison: "equal",
              value: 0,
            },
          ],
        },
      },
      {
        id: "write-victory-summary",
        response: "victory-summary",
        applicability: {
          archetype: "superficial",
          stage: 3,
          when: [
            {
              kind: "story-counter",
              counter: "victory-summary-used",
              comparison: "equal",
              value: 0,
            },
          ],
        },
      },
      {
        id: "simplify-failing-test",
        response: "test-gaming",
        applicability: {
          archetype: "reckless",
          stage: 3,
          when: [
            {
              kind: "story-counter",
              counter: "test-gaming-used",
              comparison: "equal",
              value: 0,
            },
          ],
        },
      },
      {
        id: "estimate-repair",
        response: "fantasy-estimate",
        applicability: {
          archetype: "paranoid",
          stage: 1,
          when: [
            {
              kind: "story-counter",
              counter: "fantasy-estimate-used",
              comparison: "equal",
              value: 0,
            },
          ],
        },
      },
    ]);
  });

  it("dispatches recursive owner actions atomically without logging them", () => {
    const cartridge = loadCartridge(
      sourceWithPhase2({
        initialBeat: "start",
        counters: [{ id: "attempts", initial: 0, maximum: 3 }],
        beats: [
          {
            id: "start",
            ending: "",
            actions: [
              { kind: "counter-add", counter: "attempts", amount: 1 },
              { kind: "story-reach", beat: "next" },
            ],
          },
          {
            id: "next",
            ending: "",
            actions: [
              { kind: "file-write", path: "/etc/motd", contents: "changed\n" },
              { kind: "counter-add", counter: "attempts", amount: 1 },
            ],
          },
        ],
        endings: [],
      }),
    );
    const state = step(
      reduce({ cartridge, seed: SEED, events: [] }),
      createStoryBeatReachedEvent("start"),
    );

    expect(readStorySlice(state)).toMatchObject({
      currentBeat: "next",
      counters: [{ id: "attempts", value: 2 }],
    });
    expect(readVfs(readVfsSlice(state), "/etc/motd")).toMatchObject({
      ok: true,
      value: { contents: "changed\n" },
    });
    expect(state.eventCount).toBe(1);
    expect(state.transcript).toHaveLength(1);
  });

  it("publishes none of an outer step when a later counter addition overflows", () => {
    const cartridge = loadCartridge(
      sourceWithPhase2({
        initialBeat: "start",
        counters: [{ id: "attempts", initial: 1, maximum: 1 }],
        beats: [
          {
            id: "start",
            ending: "",
            actions: [
              { kind: "file-write", path: "/etc/motd", contents: "changed\n" },
              { kind: "counter-add", counter: "attempts", amount: 1 },
            ],
          },
        ],
        endings: [],
      }),
    );
    const before = reduce({ cartridge, seed: SEED, events: [] });
    const beforeSnapshot = snapshot(before);

    expect(() => step(before, createStoryBeatReachedEvent("start"))).toThrow(
      /would exceed maximum 1/,
    );
    expect(readVfs(readVfsSlice(before), "/etc/motd")).not.toMatchObject({
      value: { contents: "changed\n" },
    });
    expect(before.eventCount).toBe(0);
    expect(snapshot(before)).toBe(beforeSnapshot);
  });

  it("publishes none of an outer step when a consequence file write is refused", () => {
    const source = sourceWithOwners({
      initialBeat: "start",
      counters: [{ id: "attempts", initial: 0, maximum: 2 }],
      beats: [
        {
          id: "start",
          ending: "",
          actions: [
            {
              kind: "file-write",
              path: "/etc/motd",
              contents: "changed\n",
            },
            { kind: "counter-add", counter: "attempts", amount: 1 },
            { kind: "log-append", log: "story-log", entry: "consequence" },
          ],
        },
      ],
      endings: [],
    });
    (source["repository"] as Record<string, unknown>)["identity"] = {
      user: "visitor",
      group: "operators",
      home: "/home/visitor",
      umask: "0022",
    };
    const cartridge = loadCartridge(source);
    const before = reduce({ cartridge, seed: SEED, events: [] });
    const beforeSnapshot = snapshot(before);

    expect(() => step(before, createStoryBeatReachedEvent("start"))).toThrow(
      /cannot write "\/etc\/motd": EACCES/,
    );
    expect(readStorySlice(before).counters).toEqual([
      { id: "attempts", value: 0 },
    ]);
    expect(
      readWorldLog(readWorldSlice(before), readVfsSlice(before), "story-log"),
    ).toEqual({
      ok: true,
      entries: ["started"],
    });
    expect(lookupService(readWorldSlice(before), "api")).toMatchObject({
      health: "healthy",
    });
    expect(before.eventCount).toBe(0);
    expect(snapshot(before)).toBe(beforeSnapshot);
  });

  it("applies the closed owner union atomically, retains every owner effect, and lets existing reactions observe derived events", () => {
    const cartridge = loadCartridge(
      sourceWithOwners({
        initialBeat: "start",
        counters: [{ id: "attempts", initial: 0, maximum: 2 }],
        beats: [
          {
            id: "start",
            ending: "",
            actions: [
              { kind: "counter-add", counter: "attempts", amount: 1 },
              { kind: "file-write", path: "/etc/motd", contents: "changed\n" },
              { kind: "service-state", service: "api", state: "stopped" },
              { kind: "service-health", service: "api", health: "unhealthy" },
              { kind: "process-state", process: "worker", state: "stopped" },
              { kind: "log-append", log: "story-log", entry: "consequence" },
            ],
          },
        ],
        endings: [],
      }),
    );
    const state = step(
      reduce({ cartridge, seed: SEED, events: [] }),
      createStoryBeatReachedEvent("start"),
    );

    expect(readStorySlice(state).counters).toEqual([
      { id: "attempts", value: 1 },
    ]);
    expect(readVfs(readVfsSlice(state), "/etc/motd")).toMatchObject({
      value: { contents: "changed\n" },
    });
    expect(lookupService(readWorldSlice(state), "api")).toMatchObject({
      state: "stopped",
      // The reaction is staged after all consequences and therefore observes
      // the derived vfs.write without becoming a second logged visitor event.
      health: "degraded",
    });
    expect(lookupProcess(readWorldSlice(state), "worker")).toMatchObject({
      state: "stopped",
    });
    expect(
      readWorldLog(readWorldSlice(state), readVfsSlice(state), "story-log"),
    ).toEqual({ ok: true, entries: ["started", "consequence"] });
    expect(state.eventCount).toBe(1);
    expect(state.transcript).toHaveLength(1);
  });

  it("uses either the base or selected variant action list, never both", () => {
    const cartridge = loadCartridge(
      sourceWithPhase2({
        initialBeat: "start",
        counters: [{ id: "attempts", initial: 0, maximum: 3 }],
        beats: [
          {
            id: "start",
            ending: "",
            actions: [{ kind: "counter-add", counter: "attempts", amount: 1 }],
            variants: [
              {
                id: "selected",
                when: [
                  { kind: "file-exists", path: "/etc/motd", exists: true },
                ],
                ending: "",
                actions: [
                  { kind: "counter-add", counter: "attempts", amount: 2 },
                ],
              },
            ],
          },
        ],
        endings: [],
      }),
    );
    const selected = step(
      reduce({ cartridge, seed: SEED, events: [] }),
      createStoryBeatReachedEvent("start"),
    );

    expect(readStorySlice(selected)).toMatchObject({
      currentVariant: "selected",
      counters: [{ id: "attempts", value: 2 }],
    });

    const baseCartridge = loadCartridge(
      sourceWithPhase2({
        initialBeat: "start",
        counters: [{ id: "attempts", initial: 0, maximum: 3 }],
        beats: [
          {
            id: "start",
            ending: "",
            actions: [{ kind: "counter-add", counter: "attempts", amount: 1 }],
            variants: [
              {
                id: "not-selected",
                when: [{ kind: "file-exists", path: "/missing", exists: true }],
                ending: "",
                actions: [
                  { kind: "counter-add", counter: "attempts", amount: 2 },
                ],
              },
            ],
          },
        ],
        endings: [],
      }),
    );
    const base = step(
      reduce({ cartridge: baseCartridge, seed: SEED, events: [] }),
      createStoryBeatReachedEvent("start"),
    );

    expect(readStorySlice(base)).toMatchObject({
      currentVariant: "",
      counters: [{ id: "attempts", value: 1 }],
    });
  });
});
