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
        actions: [{ kind: "log-append", log: "missing-log", entry: "x" }],
      },
    ];
    expect(issues(value).map((issue) => issue.pointer)).toEqual(
      expect.arrayContaining([
        "/repository/tests/0/predicate/path",
        "/repository/tests/1/id",
        "/repository/reactions/0/predicates/0/service",
        "/repository/reactions/0/predicates/1/process",
        "/repository/reactions/0/predicates/2/path",
        "/repository/reactions/0/actions/0/log",
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
});
