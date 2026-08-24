import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import { serialize } from "../serialize/canonical.js";
import {
  loadCartridgeFixture,
  loadReplayFixture,
} from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readWorldSlice, validateWorldSlice } from "./module.js";
import {
  listEnv,
  listProcesses,
  listServices,
  listTickets,
  lookupManPage,
  lookupEnv,
  lookupProcess,
  lookupService,
  lookupProcessByPid,
  lookupTicket,
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
  it.each([
    [
      "copy",
      [
        {
          type: "vfs.delete",
          payload: { path: "/production/load-balancer/config/routes.conf" },
        },
        {
          type: "vfs.copy",
          payload: {
            source: "/production/load-balancer/config/routes.200.conf",
            destination: "/production/load-balancer/config/routes.conf",
            preserve: true,
          },
        },
      ],
      [
        {
          type: "vfs.delete",
          payload: { path: "/production/load-balancer/config/routes.conf" },
        },
        {
          type: "vfs.copy",
          payload: {
            source: "/production/load-balancer/config/routes.500.conf",
            destination: "/production/load-balancer/config/routes.conf",
            preserve: true,
          },
        },
      ],
    ],
    [
      "write",
      [
        {
          type: "vfs.write",
          payload: {
            path: "/production/load-balancer/config/routes.conf",
            contents: "health_status=200\neurope_attached=false\n",
          },
        },
      ],
      [
        {
          type: "vfs.write",
          payload: {
            path: "/production/load-balancer/config/routes.conf",
            contents: "health_status=500\neurope_attached=true\n",
          },
        },
      ],
    ],
    [
      "replacement",
      [
        {
          type: "shell.execute",
          payload: {
            input: "git checkout greg/healthcheck-repair",
          },
        },
      ],
      [
        {
          type: "shell.execute",
          payload: {
            input: "git checkout main",
          },
        },
      ],
    ],
  ] as const)(
    "keeps Incident #001's repair evidence coherent through %s mutations",
    (_kind, repairEvents, undoEvents) => {
      const incident = loadCartridge(
        loadReplayFixture("020-incident-001-story").cartridge,
      );
      const routes = "/production/load-balancer/config/routes.conf";
      const state = reduce({
        cartridge: incident,
        seed: SEED,
        events: repairEvents,
      });
      const world = readWorldSlice(state);
      expect(lookupService(world, "endpoint-responder")).toMatchObject({
        state: "running",
        health: "healthy",
      });
      expect(lookupService(world, "regional-router")).toMatchObject({
        state: "running",
        health: "unhealthy",
      });
      expect(lookupProcess(world, "endpoint-responder")).toMatchObject({
        state: "running",
      });
      expect(
        readWorldLog(world, readVfsSlice(state), "health-check-log"),
      ).toEqual({
        ok: true,
        entries: [
          "health endpoint serving 500; Europe remains attached",
          "regional router healthy",
          "health endpoint serving 200; Europe detached",
        ],
      });
      expect(
        readWorldLog(world, readVfsSlice(state), "regional-routing-events"),
      ).toEqual({
        ok: true,
        entries: [
          "health status 500 retained; Europe attached",
          "regional router healthy",
          "regional router unhealthy after Europe detached",
        ],
      });

      const repeated = reduce({
        cartridge: incident,
        seed: SEED,
        events: [
          ...repairEvents,
          { type: "vfs.touch", payload: { path: "/tmp/unrelated" } },
          ...repairEvents,
          // Service management can reset endpoint health without changing the
          // routes configuration; undo must still reconcile the router state.
          {
            type: "shell.execute",
            payload: { input: "systemctl stop endpoint-responder" },
          },
          ...undoEvents,
        ],
      });
      const undone = readWorldSlice(repeated);
      expect(lookupService(undone, "endpoint-responder")).toMatchObject({
        state: "stopped",
        health: "unknown",
      });
      expect(lookupService(undone, "regional-router")).toMatchObject({
        health: "healthy",
      });
      expect(lookupProcess(undone, "endpoint-responder")).toMatchObject({
        state: "stopped",
      });
      expect(
        readWorldLog(undone, readVfsSlice(repeated), "health-check-log"),
      ).toEqual({
        ok: true,
        entries: [
          "health endpoint serving 500; Europe remains attached",
          "regional router healthy",
          "health endpoint serving 200; Europe detached",
          "health endpoint serving 500; Europe reattached",
        ],
      });
    },
  );

  it("derives repair state from routes.conf rather than a visitor-mutated router health latch", () => {
    const incident = loadCartridge(
      loadReplayFixture("020-incident-001-story").cartridge,
    );
    const state = reduce({
      cartridge: incident,
      seed: SEED,
      events: [
        {
          type: "world.service-health",
          payload: { id: "regional-router", health: "degraded" },
        },
        { type: "shell.execute", payload: { input: "rm config/routes.conf" } },
        {
          type: "shell.execute",
          payload: { input: "cp -p config/routes.200.conf config/routes.conf" },
        },
      ],
    });

    expect(
      lookupService(readWorldSlice(state), "endpoint-responder"),
    ).toMatchObject({
      state: "running",
      health: "healthy",
    });
    expect(
      lookupService(readWorldSlice(state), "regional-router"),
    ).toMatchObject({
      health: "unhealthy",
    });
  });

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
    const process = world.processes[0];
    if (process === undefined)
      throw new Error("fixture must provide a process");
    expect(lookupProcessByPid(world, process.pid)).toBe(process);
    expect(lookupProcessByPid(world, 99999)).toBeUndefined();
    expect(lookupTicket(world, "T-1")?.title).toBe("First");
    expect(lookupTicket(world, "T-404")).toBeUndefined();
    expect(lookupEnv(world, "PATH")).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(lookupEnv(world, "MISSING")).toBeUndefined();
    expect(lookupEnv(world, "constructor")).toBeUndefined();
  });

  it("reports unavailable world logs without hiding VFS failures", () => {
    const state = reduce({ cartridge: cartridge(), seed: SEED, events: [] });
    const world = readWorldSlice(state);
    expect(readWorldLog(world, readVfsSlice(state), "missing")).toEqual({
      ok: false,
      reason: "missing-log",
    });

    const deleted = reduce({
      cartridge: cartridge(),
      seed: SEED,
      events: [{ type: "vfs.delete", payload: { path: "/var/log/api.log" } }],
    });
    expect(
      readWorldLog(readWorldSlice(deleted), readVfsSlice(deleted), "api-file"),
    ).toEqual({ ok: false, reason: "missing-file" });

    const unreadableSource = source();
    const repository = unreadableSource["repository"] as Record<
      string,
      unknown
    >;
    const files = repository["files"] as Record<string, unknown>;
    repository["identity"] = {
      user: "deploy",
      group: "deploy",
      home: "/home/deploy",
    };
    files["/var/log/api.log"] = { contents: "booted\n", mode: "0000" };
    const unreadable = reduce({
      cartridge: loadCartridge(unreadableSource),
      seed: SEED,
      events: [],
    });
    expect(
      readWorldLog(
        readWorldSlice(unreadable),
        readVfsSlice(unreadable),
        "api-file",
      ),
    ).toEqual({ ok: false, reason: "vfs-error", code: "EACCES" });
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

  it("rejects world events for unknown targets and deleted file logs", () => {
    for (const event of [
      { type: "world.log-append", payload: { id: "missing", entry: "x" } },
      { type: "world.service-start", payload: { id: "missing" } },
      {
        type: "world.process-transition",
        payload: { id: "missing", state: "running" },
      },
    ] as const) {
      expect(() =>
        reduce({ cartridge: cartridge(), seed: SEED, events: [event] }),
      ).toThrow(/unknown (log|service|process)/);
    }
    expect(() =>
      reduce({
        cartridge: cartridge(),
        seed: SEED,
        events: [
          { type: "vfs.delete", payload: { path: "/var/log/api.log" } },
          {
            type: "world.log-append",
            payload: { id: "api-file", entry: "after deletion" },
          },
        ],
      }),
    ).toThrow(/cannot read file log "api-file": ENOENT/);
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

  it("rejects broken world cross-references at the direct snapshot boundary", () => {
    const world = readWorldSlice(
      reduce({ cartridge: cartridge(), seed: SEED, events: [] }),
    );
    const firstProcess = world.processes[0];
    const secondProcess = world.processes[1];
    const firstService = world.services[0];
    const fileLog = world.logs.find((entry) => entry.kind === "file");
    if (
      firstProcess === undefined ||
      secondProcess === undefined ||
      firstService === undefined ||
      fileLog === undefined
    )
      throw new Error("fixture must provide world entries for validation");

    expect(() =>
      validateWorldSlice(
        {
          ...world,
          processes: [
            firstProcess,
            { ...secondProcess, pid: firstProcess.pid },
            ...world.processes.slice(2),
          ],
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/pid: must be a unique integer/);
    expect(() =>
      validateWorldSlice(
        {
          ...world,
          services: [
            { ...firstService, dependencies: ["missing"] },
            ...world.services.slice(1),
          ],
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/dependencies\[0\]: must name a service/);
    expect(() =>
      validateWorldSlice(
        {
          ...world,
          logs: world.logs.map((entry) =>
            entry.id === fileLog.id ? { ...entry, entries: ["seeded"] } : entry,
          ),
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/file logs require an absolute path and no entries/);
  });

  it("rejects noncanonical process timestamp spellings in snapshots", () => {
    const world = readWorldSlice(
      reduce({ cartridge: cartridge(), seed: SEED, events: [] }),
    );
    const first = world.processes[0];
    if (first === undefined) throw new Error("fixture must provide a process");
    expect(() =>
      validateWorldSlice(
        {
          ...world,
          processes: [
            { ...first, startedAt: "2026-08-05T09:00:00Z" },
            ...world.processes.slice(1),
          ],
        },
        "snapshot: slices.world",
      ),
    ).toThrow(/startedAt: must be a real UTC instant/);
  });
});
