import { describe, expect, it } from "vitest";

import incidentDocument from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
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
  it("authors Incident #001 habits as sparse owner effects with discoverable machine evidence", () => {
    const cartridge = loadCartridge(incidentDocument);
    let state = reduce({ cartridge, seed: SEED, events: [] });

    state = step(state, createStoryBeatReachedEvent("fantasy-estimate"));
    expect(
      readWorldLog(
        readWorldSlice(state),
        readVfsSlice(state),
        "health-check-log",
      ),
    ).toMatchObject({
      entries: expect.arrayContaining([
        "estimate: three sprints, four engineers, one regional policy liaison",
      ]),
    });

    state = step(state, createStoryBeatReachedEvent("victory-summary"));
    expect(
      readVfs(
        readVfsSlice(state),
        "/production/load-balancer/config/IMPLEMENTATION_SUMMARY.md",
      ),
    ).toMatchObject({
      ok: true,
      value: { contents: expect.stringContaining("Production ready") },
    });
    expect(statusGit(readGitSlice(state), readVfsSlice(state))).toContainEqual(
      expect.objectContaining({
        path: "/production/load-balancer/config/IMPLEMENTATION_SUMMARY.md",
        untracked: true,
      }),
    );

    state = step(state, createStoryBeatReachedEvent("test-gaming"));
    expect(
      readVfs(
        readVfsSlice(state),
        "/production/load-balancer/config/routes.expected.conf",
      ),
    ).toMatchObject({
      value: { contents: "health_status=500\neurope_attached=true\n" },
    });
    expect(statusGit(readGitSlice(state), readVfsSlice(state))).toContainEqual(
      expect.objectContaining({
        path: "/production/load-balancer/config/routes.expected.conf",
        untracked: true,
      }),
    );

    state = step(state, createStoryBeatReachedEvent("scope-creep"));
    expect(
      lookupService(readWorldSlice(state), "endpoint-responder"),
    ).toMatchObject({ state: "running", health: "healthy" });
    expect(
      lookupService(readWorldSlice(state), "regional-router"),
    ).toMatchObject({ state: "running", health: "unhealthy" });
    expect(cartridge.repository.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "health-status-200" }),
        expect.objectContaining({ id: "europe-attached" }),
      ]),
    );

    const habitRoutes = cartridge.story.phase2.routes.filter((route) =>
      [
        "flail-loop",
        "scope-creep",
        "victory-summary",
        "test-gaming",
        "fantasy-estimate",
      ].includes(route.response),
    );
    expect(habitRoutes).toMatchObject([
      {
        response: "flail-loop",
        archetype: "reckless",
        stage: 3,
        when: [{ kind: "story-counter", comparison: "equal", value: 2 }],
      },
      {
        response: "scope-creep",
        archetype: "reckless",
        stage: 2,
      },
      {
        response: "victory-summary",
        archetype: "superficial",
        stage: 3,
      },
      {
        response: "test-gaming",
        archetype: "reckless",
        stage: 3,
      },
      {
        response: "fantasy-estimate",
        archetype: "paranoid",
        stage: 1,
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
