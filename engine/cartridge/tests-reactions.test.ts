import { describe, expect, it } from "vitest";

import { loadCartridgeFixture } from "../testing/fixtures.js";
import { CartridgeValidationError, loadCartridge } from "./load.js";

function source(): Record<string, unknown> {
  return loadCartridgeFixture("minimal") as Record<string, unknown>;
}

function repository(value: Record<string, unknown>): Record<string, unknown> {
  return value["repository"] as Record<string, unknown>;
}

function issues(value: Record<string, unknown>) {
  try {
    loadCartridge(value);
  } catch (error) {
    if (error instanceof CartridgeValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected cartridge validation to fail");
}

describe("test and reaction cartridge contracts", () => {
  it("normalizes omitted lists and preserves authored execution order", () => {
    const empty = loadCartridge(source());
    expect(empty.repository.tests).toEqual([]);
    expect(empty.repository.reactions).toEqual([]);

    const value = source();
    repository(value)["tests"] = [
      {
        id: "second-looking",
        name: "authored first",
        durationMs: 10,
        predicate: {
          kind: "file-exists",
          path: "/production/service/README.md",
          exists: true,
        },
      },
      {
        id: "first-looking",
        name: "authored second",
        durationMs: 20,
        predicate: {
          kind: "file-contents",
          path: "/production/service/README.md",
          equals: "# service\n",
        },
      },
    ];
    expect(
      loadCartridge(value).repository.tests.map((test) => test.id),
    ).toEqual(["second-looking", "first-looking"]);
  });

  it("rejects duplicate ids and every dangling reference at useful pointers", () => {
    const value = source();
    const repo = repository(value);
    repo["tests"] = [
      {
        id: "same",
        name: "one",
        durationMs: 0,
        predicate: { kind: "file-exists", path: "/missing", exists: false },
      },
      {
        id: "same",
        name: "two",
        durationMs: 0,
        predicate: {
          kind: "file-contents",
          path: "/production/service/README.md",
          equals: "x",
        },
      },
    ];
    repo["reactions"] = [
      {
        id: "dangling",
        on: "vfs.write",
        predicates: [
          {
            kind: "service-state",
            service: "missing-service",
            state: "running",
          },
          {
            kind: "process-state",
            process: "missing-process",
            state: "stopped",
          },
          {
            kind: "file-exists",
            path: "/missing-file",
            exists: true,
          },
        ],
        actions: [
          {
            kind: "service-state",
            service: "missing-service",
            state: "running",
          },
          {
            kind: "service-health",
            service: "missing-health-service",
            health: "healthy",
          },
          {
            kind: "process-state",
            process: "missing-action-process",
            state: "running",
          },
          { kind: "log-append", log: "missing-log", entry: "x" },
        ],
      },
    ];
    expect(issues(value).map((issue) => issue.pointer)).toEqual(
      expect.arrayContaining([
        "/repository/tests/0/predicate/path",
        "/repository/tests/1/id",
        "/repository/reactions/0/predicates/0/service",
        "/repository/reactions/0/predicates/1/process",
        "/repository/reactions/0/predicates/2/path",
        "/repository/reactions/0/actions/0/service",
        "/repository/reactions/0/actions/1/service",
        "/repository/reactions/0/actions/2/process",
        "/repository/reactions/0/actions/3/log",
      ]),
    );
  });

  it("accepts reaction story reaches and rejects an unknown target beat", () => {
    const value = source();
    repository(value)["reactions"] = [
      {
        id: "reach-story",
        on: "clock.tick",
        predicates: [],
        actions: [{ kind: "story-reach", beat: "start" }],
      },
    ];
    expect(loadCartridge(value).repository.reactions[0]?.actions).toEqual([
      { kind: "story-reach", beat: "start" },
    ]);

    (
      (repository(value)["reactions"] as Array<Record<string, unknown>>)[0]
        ?.actions as Array<Record<string, unknown>>
    )[0] = { kind: "story-reach", beat: "missing" };
    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/repository/reactions/0/actions/0/beat",
          expected: "the id of a declared story beat",
        }),
      ]),
    );
  });

  it("rejects conservative event-type cascade cycles", () => {
    const value = source();
    const repo = repository(value);
    repo["services"] = [
      {
        id: "api",
        state: "stopped",
        health: "unknown",
        ports: [],
        dependencies: [],
      },
    ];
    repo["reactions"] = [
      {
        id: "start-to-stop",
        on: "world.service-start",
        predicates: [],
        actions: [{ kind: "service-state", service: "api", state: "stopped" }],
      },
      {
        id: "stop-to-start",
        on: "world.service-stop",
        predicates: [],
        actions: [{ kind: "service-state", service: "api", state: "running" }],
      },
    ];
    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: expect.stringMatching(
            /^\/repository\/reactions\/\d+\/actions\/0\/kind$/,
          ),
          expected: expect.stringContaining("acyclic"),
        }),
      ]),
    );
  });

  it("rejects cycles that cross from reactions through story consequences", () => {
    const value = source();
    const story = value["story"] as Record<string, unknown>;
    story["phase2"] = {
      initialBeat: "start",
      beats: [
        {
          id: "start",
          ending: "",
          actions: [{ kind: "story-reach", beat: "nested" }],
        },
        {
          id: "nested",
          ending: "",
          variants: [
            {
              id: "selected-write",
              when: [
                {
                  kind: "file-exists",
                  path: "/production/service/README.md",
                  exists: true,
                },
              ],
              ending: "",
              actions: [
                {
                  kind: "file-write",
                  path: "/production/service/README.md",
                  contents: "changed\n",
                },
              ],
            },
          ],
        },
      ],
      endings: [],
    };
    repository(value)["reactions"] = [
      {
        id: "write-reaches-story",
        on: "vfs.write",
        predicates: [],
        actions: [{ kind: "story-reach", beat: "start" }],
      },
    ];

    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/repository/reactions/0/actions/0/kind",
          expected: expect.stringContaining("acyclic"),
        }),
      ]),
    );
  });

  it("rejects cycles that only close after several reaction event types", () => {
    const value = source();
    const repo = repository(value);
    repo["services"] = [
      {
        id: "api",
        state: "stopped",
        health: "unknown",
        ports: [],
        dependencies: [],
      },
    ];
    repo["processes"] = [
      {
        id: "worker",
        pid: 1200,
        user: "root",
        command: { binary: "/production/service/src/index.ts", args: [] },
        startedAt: "2026-08-05T09:00:00.000Z",
        state: "stopped",
      },
    ];
    repo["logs"] = [{ id: "events", kind: "stream", entries: [] }];
    repo["reactions"] = [
      {
        id: "start-worker",
        on: "world.service-start",
        predicates: [],
        actions: [
          { kind: "process-state", process: "worker", state: "running" },
        ],
      },
      {
        id: "worker-logs",
        on: "world.process-transition",
        predicates: [],
        actions: [{ kind: "log-append", log: "events", entry: "started" }],
      },
      {
        id: "log-restarts-service",
        on: "world.log-append",
        predicates: [],
        actions: [{ kind: "service-state", service: "api", state: "running" }],
      },
    ];

    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: expect.stringMatching(
            /^\/repository\/reactions\/\d+\/actions\/0\/kind$/,
          ),
          expected: expect.stringContaining("acyclic"),
        }),
      ]),
    );
  });

  it("uses closed discriminated interiors and duration bounds", () => {
    const value = source();
    repository(value)["tests"] = [
      {
        id: "bad",
        name: "bad",
        durationMs: 600001,
        predicate: {
          kind: "file-exists",
          path: "/production/service/README.md",
          exists: true,
          typo: true,
        },
      },
    ];
    expect(issues(value).map((issue) => issue.pointer)).toEqual(
      expect.arrayContaining([
        "/repository/tests/0/durationMs",
        "/repository/tests/0/predicate/typo",
      ]),
    );
  });

  it("bounds reaction rules, predicates, and actions before they can amplify a cascade", () => {
    const value = source();
    const reaction = {
      id: "bounded",
      on: "vfs.write",
      predicates: [],
      actions: [],
    };
    repository(value)["reactions"] = new Array(129).fill(reaction);
    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/repository/reactions" }),
      ]),
    );

    repository(value)["reactions"] = [
      { ...reaction, actions: new Array(33).fill({ kind: "log-append" }) },
    ];
    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/repository/reactions/0/actions" }),
      ]),
    );

    repository(value)["reactions"] = [
      { ...reaction, predicates: new Array(33).fill({ kind: "always" }) },
    ];
    expect(issues(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/repository/reactions/0/predicates",
        }),
      ]),
    );
  });
});
