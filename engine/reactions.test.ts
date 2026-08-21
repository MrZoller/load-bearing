import { describe, expect, it } from "vitest";

import { loadCartridge } from "./cartridge/load.js";
import { bootstrap, reduce, snapshot, step } from "./events/reduce.js";
import { createShellExecuteEvent } from "./commands/shell.js";
import { loadCartridgeFixture } from "./testing/fixtures.js";
import { readVfsSlice } from "./vfs/module.js";
import { readVfs } from "./vfs/vfs.js";
import { readWorldSlice } from "./world/module.js";
import { lookupProcess, lookupService, readWorldLog } from "./world/world.js";

function source(): Record<string, unknown> {
  const value = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const repository = value["repository"] as Record<string, unknown>;
  repository["files"] = {
    ...(repository["files"] as Record<string, unknown>),
    "/var/log/reactions.log": { contents: "seed\n" },
  };
  repository["services"] = [
    {
      id: "api",
      state: "stopped",
      health: "unknown",
      ports: [],
      dependencies: [],
    },
  ];
  repository["processes"] = [
    {
      id: "worker",
      pid: 1200,
      user: "root",
      command: { binary: "/production/service/src/index.ts", args: [] },
      startedAt: "2026-08-05T09:00:00.000Z",
      state: "stopped",
    },
  ];
  repository["logs"] = [
    { id: "events", kind: "stream", entries: [] },
    { id: "file", kind: "file", path: "/var/log/reactions.log" },
  ];
  return value;
}

function repository(value: Record<string, unknown>): Record<string, unknown> {
  return value["repository"] as Record<string, unknown>;
}

describe("service health", () => {
  it("is an owned event and immutable world transition", () => {
    const cartridge = loadCartridge(source());
    const before = bootstrap({ cartridge, seed: "health" });
    const after = step(before, {
      type: "world.service-health",
      payload: { id: "api", health: "degraded" },
    });
    expect(lookupService(readWorldSlice(before), "api")?.health).toBe(
      "unknown",
    );
    expect(lookupService(readWorldSlice(after), "api")?.health).toBe(
      "degraded",
    );
    expect(after.transcript[0]?.summary).toBe('id="api" health=degraded');
  });
});

describe("post-event reactions", () => {
  it("uses authored rule/action order, staged predicates and FIFO cascades", () => {
    const value = source();
    repository(value)["reactions"] = [
      {
        id: "bring-up",
        on: "vfs.write",
        predicates: [
          {
            kind: "file-contents",
            path: "/production/service/README.md",
            equals: "fixed\n",
          },
        ],
        actions: [
          { kind: "service-state", service: "api", state: "running" },
          { kind: "process-state", process: "worker", state: "running" },
        ],
      },
      {
        id: "healthy-after-start",
        on: "vfs.write",
        predicates: [
          { kind: "service-state", service: "api", state: "running" },
        ],
        actions: [
          { kind: "service-health", service: "api", health: "healthy" },
        ],
      },
      {
        id: "service-cascade",
        on: "world.service-start",
        predicates: [],
        actions: [{ kind: "log-append", log: "events", entry: "service" }],
      },
      {
        id: "process-cascade",
        on: "world.process-transition",
        predicates: [],
        actions: [{ kind: "log-append", log: "events", entry: "process" }],
      },
      {
        id: "health-cascade",
        on: "world.service-health",
        predicates: [],
        actions: [{ kind: "log-append", log: "file", entry: "healthy" }],
      },
    ];
    const state = reduce({
      cartridge: loadCartridge(value),
      seed: "reaction-order",
      events: [
        {
          type: "vfs.write",
          payload: {
            path: "/production/service/README.md",
            contents: "fixed\n",
          },
        },
      ],
    });
    const world = readWorldSlice(state);
    expect(lookupService(world, "api")).toMatchObject({
      state: "running",
      health: "healthy",
    });
    expect(lookupProcess(world, "worker")?.state).toBe("running");
    expect(readWorldLog(world, readVfsSlice(state), "events")).toEqual({
      ok: true,
      entries: ["service", "process"],
    });
    expect(
      readVfs(readVfsSlice(state), "/var/log/reactions.log"),
    ).toMatchObject({
      ok: true,
      value: { contents: "seed\nhealthy\n" },
    });
    expect(state.eventCount).toBe(1);
    expect(state.transcript).toHaveLength(1);
  });

  it("evaluates child triggers only after the whole shell expansion is staged", () => {
    const value = source();
    repository(value)["reactions"] = [
      {
        id: "history-sees-start",
        on: "world.history-append",
        predicates: [
          { kind: "service-state", service: "api", state: "running" },
        ],
        actions: [
          { kind: "service-health", service: "api", health: "healthy" },
        ],
      },
    ];
    const state = reduce({
      cartridge: loadCartridge(value),
      seed: "post-expansion",
      events: [createShellExecuteEvent("systemctl start api")],
    });
    expect(lookupService(readWorldSlice(state), "api")).toMatchObject({
      state: "running",
      health: "healthy",
    });
    expect(state.transcript.map((entry) => entry.type)).toEqual([
      "world.history-append",
      "world.service-start",
      "shell.result",
    ]);
    expect(state.eventCount).toBe(3);
  });

  it("evaluates the shell trigger itself against post-expansion state", () => {
    const value = source();
    repository(value)["reactions"] = [
      {
        id: "shell-sees-start",
        on: "shell.execute",
        predicates: [
          { kind: "service-state", service: "api", state: "running" },
        ],
        actions: [
          { kind: "service-health", service: "api", health: "healthy" },
        ],
      },
    ];

    const state = reduce({
      cartridge: loadCartridge(value),
      seed: "shell-post-expansion",
      events: [createShellExecuteEvent("systemctl start api")],
    });

    // A shell command is one visitor event even though it expands into owned
    // events. Its rule must therefore see the completed command, not the
    // pre-start world that existed when expansion began.
    expect(lookupService(readWorldSlice(state), "api")).toMatchObject({
      state: "running",
      health: "healthy",
    });
    expect(state.eventCount).toBe(3);
    expect(state.transcript).toHaveLength(3);
  });

  it("keeps unrelated owners unchanged while a reaction applies its owned action", () => {
    const value = source();
    repository(value)["reactions"] = [
      {
        id: "degrade-api",
        on: "clock.tick",
        predicates: [],
        actions: [
          { kind: "service-health", service: "api", health: "degraded" },
        ],
      },
    ];
    const before = bootstrap({
      cartridge: loadCartridge(value),
      seed: "reaction-owner-isolation",
    });
    const after = step(before, { type: "clock.tick", payload: { ms: 1 } });

    expect(lookupService(readWorldSlice(after), "api")?.health).toBe(
      "degraded",
    );
    // The generic phase selects owner events; it cannot write the VFS or a
    // process while applying a service-health action.
    expect(readVfsSlice(after)).toEqual(readVfsSlice(before));
    expect(lookupProcess(readWorldSlice(after), "worker")).toEqual(
      lookupProcess(readWorldSlice(before), "worker"),
    );
  });

  it("publishes none of a logged trigger when a later reaction action fails", () => {
    const value = source();
    const repo = repository(value);
    repo["identity"] = {
      user: "deploy",
      group: "deploy",
      home: "/home/deploy",
    };
    (repo["logs"] as unknown[]).push({
      id: "locked",
      kind: "file",
      path: "/etc/motd",
    });
    repo["reactions"] = [
      {
        id: "cannot-write",
        on: "clock.tick",
        predicates: [],
        actions: [{ kind: "log-append", log: "locked", entry: "nope" }],
      },
    ];
    const before = bootstrap({
      cartridge: loadCartridge(value),
      seed: "atomic",
    });
    const bytes = snapshot(before);
    expect(() =>
      step(before, { type: "clock.tick", payload: { ms: 25 } }),
    ).toThrow(/cannot append file log|VFS mutation failed/);
    expect(snapshot(before)).toBe(bytes);
    expect(before.clock.elapsedMs).toBe(0);
    expect(before.eventCount).toBe(0);
  });

  it("rejects a wide acyclic cascade before it monopolizes the reducer", () => {
    const value = source();
    const repo = repository(value);
    repo["reactions"] = [
      {
        id: "fan-out",
        on: "clock.tick",
        predicates: [],
        actions: new Array(32).fill(undefined).map(() => ({
          kind: "service-state",
          service: "api",
          state: "running",
        })),
      },
      ...new Array(32).fill(undefined).map((_, index) => ({
        id: `record-${String(index)}`,
        on: "world.service-start",
        predicates: [],
        actions: [{ kind: "log-append", log: "events", entry: "started" }],
      })),
    ];
    const before = bootstrap({
      cartridge: loadCartridge(value),
      seed: "reaction-fan-out",
    });
    const bytes = snapshot(before);

    expect(() =>
      step(before, { type: "clock.tick", payload: { ms: 1 } }),
    ).toThrow(/reaction cascade exceeds the 1024 derived-event limit/);
    expect(snapshot(before)).toBe(bytes);
  });

  it("does not count shell expansion source events against the cascade limit", () => {
    const value = source();
    const repo = repository(value);
    repo["reactions"] = [
      {
        id: "one-result-reaction",
        on: "shell.result",
        predicates: [],
        actions: [{ kind: "log-append", log: "events", entry: "complete" }],
      },
    ];
    const before = bootstrap({
      cartridge: loadCartridge(value),
      seed: "reaction-source-events",
    });
    const after = step(
      before,
      createShellExecuteEvent(`touch ${"a ".repeat(1024)}`),
    );
    expect(
      readWorldSlice(after).logs.find((log) => log.id === "events")?.entries,
    ).toContain("complete");
  });
});
