import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import { serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readWorldSlice, validateWorldSlice } from "./module.js";
import {
  listEnv,
  listProcesses,
  listServices,
  listTickets,
  lookupManPage,
  readShellHistory,
  readWorldLog,
} from "./world.js";

const SEED = "2026-08-05/7/deep-foundation";

function source(): Record<string, unknown> {
  const value = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const repository = value["repository"] as Record<string, unknown>;
  repository["files"] = {
    ...(repository["files"] as Record<string, unknown>),
    "/usr/bin/worker": { contents: "binary" },
    "/var/log/api.log": { contents: "booted\n" },
  };
  repository["processes"] = [
    {
      id: "z-auto",
      pid: 0,
      user: "root",
      command: { binary: "/usr/bin/worker", args: ["--serve"] },
      startedAt: "2026-08-05T09:00:00.000Z",
      state: "running",
    },
    {
      id: "fixed",
      pid: 1200,
      user: "root",
      command: { binary: "/usr/bin/worker", args: [] },
      startedAt: "2026-08-05T08:00:00.000Z",
      state: "stopped",
    },
    {
      id: "a-auto",
      pid: 0,
      user: "deploy",
      command: { binary: "/usr/bin/worker", args: [] },
      startedAt: "2026-08-05T09:01:00.000Z",
      state: "running",
    },
  ];
  repository["services"] = [
    {
      id: "worker",
      state: "stopped",
      health: "degraded",
      ports: [0],
      dependencies: ["api"],
    },
    {
      id: "api",
      state: "running",
      health: "healthy",
      ports: [443, 0],
      dependencies: [],
    },
  ];
  repository["logs"] = [
    { id: "api-file", kind: "file", path: "/var/log/api.log" },
    { id: "events", kind: "stream", entries: ["seeded"] },
  ];
  repository["manPages"] = [
    { name: "service", section: "8", contents: "eight" },
    { name: "service", section: "1", contents: "one" },
  ];
  repository["tickets"] = [
    { id: "T-2", status: "closed", title: "Second", body: "done", service: "" },
    { id: "T-1", status: "open", title: "First", body: "help", service: "api" },
  ];
  return value;
}

function cartridge(): LoadedCartridge {
  return loadCartridge(source());
}

describe("world state", () => {
  it("assigns reserved collision-free values reproducibly on isolated streams", () => {
    const first = readWorldSlice(
      reduce({ cartridge: cartridge(), seed: SEED, events: [] }),
    );
    const again = readWorldSlice(
      reduce({ cartridge: cartridge(), seed: SEED, events: [] }),
    );
    expect(serialize(first)).toBe(serialize(again));
    expect(new Set(first.processes.map((entry) => entry.pid)).size).toBe(3);
    expect(first.processes.every((entry) => entry.pid >= 1000)).toBe(true);
    expect(new Set(first.services.flatMap((entry) => entry.ports)).size).toBe(
      3,
    );

    const extra = source();
    const repository = extra["repository"] as Record<string, unknown>;
    (repository["processes"] as unknown[]).push({
      id: "extra",
      pid: 0,
      user: "root",
      command: { binary: "/usr/bin/worker", args: [] },
      startedAt: "2026-08-05T09:02:00.000Z",
      state: "running",
    });
    const withExtra = readWorldSlice(
      reduce({ cartridge: loadCartridge(extra), seed: SEED, events: [] }),
    );
    expect(withExtra.services).toEqual(first.services);
  });

  it("applies explicit locale-free listing and lookup rules", () => {
    const state = reduce({ cartridge: cartridge(), seed: SEED, events: [] });
    const world = readWorldSlice(state);
    expect(listProcesses(world).map((entry) => entry.pid)).toEqual(
      [...world.processes.map((entry) => entry.pid)].sort((a, b) => a - b),
    );
    expect(listServices(world).map((entry) => entry.id)).toEqual([
      "api",
      "worker",
    ]);
    expect(
      listTickets(world, { status: "open" }).map((entry) => entry.id),
    ).toEqual(["T-1"]);
    expect(lookupManPage(world, "service")?.section).toBe("1");
    expect(lookupManPage(world, "service", "8")?.contents).toBe("eight");
    expect(listEnv(world).map(([name]) => name)).toEqual([
      "PATH",
      "SERVICE_TIER",
    ]);
    expect(readShellHistory(world)).toEqual([
      "cd /production/service",
      "git status",
      "npm test",
    ]);
    expect(readWorldLog(world, readVfsSlice(state), "api-file")).toEqual({
      ok: true,
      entries: ["booted"],
    });
    expect(readWorldLog(world, readVfsSlice(state), "events")).toEqual({
      ok: true,
      entries: ["seeded"],
    });
  });

  it("folds every required mutation and keeps file logs only in VFS", () => {
    const state = reduce({
      cartridge: cartridge(),
      seed: SEED,
      events: [
        { type: "world.env-set", payload: { name: "NEW", value: "yes" } },
        { type: "world.env-unset", payload: { name: "SERVICE_TIER" } },
        { type: "world.log-append", payload: { id: "events", entry: "later" } },
        {
          type: "world.log-append",
          payload: { id: "api-file", entry: "failed" },
        },
        { type: "world.service-start", payload: { id: "worker" } },
        { type: "world.service-stop", payload: { id: "api" } },
        { type: "world.service-restart", payload: { id: "api" } },
        {
          type: "world.history-append",
          payload: { command: "systemctl status api" },
        },
        {
          type: "world.process-transition",
          payload: { id: "fixed", state: "running" },
        },
      ],
    });
    const world = readWorldSlice(state);
    expect(world.env).toMatchObject({ NEW: "yes" });
    expect(world.env).not.toHaveProperty("SERVICE_TIER");
    expect(
      world.logs.find((entry) => entry.id === "api-file")?.entries,
    ).toEqual([]);
    expect(world.logs.find((entry) => entry.id === "events")?.entries).toEqual([
      "seeded",
      "later",
    ]);
    expect(world.services.find((entry) => entry.id === "api")).toMatchObject({
      state: "running",
      health: "healthy",
    });
    expect(world.services.find((entry) => entry.id === "worker")).toMatchObject(
      { state: "running", health: "degraded" },
    );
    expect(world.shellHistory.at(-1)).toBe("systemctl status api");
    expect(world.processes.find((entry) => entry.id === "fixed")?.state).toBe(
      "running",
    );
    expect(readVfs(readVfsSlice(state), "/var/log/api.log")).toMatchObject({
      ok: true,
      value: { contents: "booted\nfailed\n" },
    });
  });

  it("closes payloads and validates snapshots deeply", () => {
    expect(() =>
      reduce({
        cartridge: cartridge(),
        seed: SEED,
        events: [
          {
            type: "world.env-set",
            payload: { name: "A", value: "b", typo: true },
          },
        ],
      }),
    ).toThrow(/unexpected payload field/);
    expect(() =>
      validateWorldSlice(
        {
          processes: [],
          services: [],
          logs: [],
          env: {},
          manPages: [],
          shellHistory: [],
          tickets: [],
          extra: true,
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/unexpected field/);
    const sparse: unknown[] = [];
    sparse.length = 1;
    Object.assign(sparse, { extra: "substitute" });
    expect(() =>
      validateWorldSlice(
        {
          processes: sparse,
          services: [],
          logs: [],
          env: {},
          manPages: [],
          shellHistory: [],
          tickets: [],
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/dense array/);
    const state = reduce({
      cartridge: cartridge(),
      seed: SEED,
      events: [{ type: "world.history-append", payload: { command: "pwd" } }],
    });
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });
});
