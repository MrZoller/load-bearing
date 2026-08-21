import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import type {
  EngineEvent,
  SessionState,
  TranscriptEntry,
} from "../events/state.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readWorldSlice } from "../world/module.js";

function cartridge() {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const repository = source["repository"] as Record<string, unknown>;
  repository["files"] = {
    ...(repository["files"] as Record<string, unknown>),
    "/usr/bin/api": { contents: "binary" },
  };
  repository["processes"] = [
    {
      id: "api-proc",
      pid: 1234,
      user: "deploy",
      command: { binary: "/usr/bin/api", args: ["--serve"] },
      startedAt: "2026-08-05T08:00:00.000Z",
      state: "running",
    },
  ];
  repository["services"] = [
    {
      id: "api",
      state: "running",
      health: "degraded",
      ports: [8080],
      dependencies: [],
    },
  ];
  repository["endpoints"] = {
    "https://api.example.test/health": {
      service: "api",
      running: {
        stdout: ["HTTP/1.1 200 OK", "tilted"],
        stderr: [],
        exitCode: 0,
      },
      unavailable: {
        stdout: [],
        stderr: ["curl: (7) api is unavailable"],
        exitCode: 7,
      },
    },
  };
  return loadCartridge(source);
}

function run(
  inputs: readonly string[],
  extra: readonly EngineEvent[] = [],
): SessionState {
  return reduce({
    cartridge: cartridge(),
    seed: "system-commands",
    events: [
      ...extra,
      ...inputs.map((input) => ({ type: "shell.execute", payload: { input } })),
    ],
  });
}

function results(state: SessionState): readonly TranscriptEntry[] {
  return state.transcript.filter((entry) => entry.type === "shell.result");
}

function output(entry: TranscriptEntry | undefined) {
  return {
    stdout: entry?.output
      ?.filter((line) => line.stream === "stdout")
      .map((line) => line.text),
    stderr: entry?.output
      ?.filter((line) => line.stream === "stderr")
      .map((line) => line.text),
    exitCode: entry?.exitCode,
  };
}

describe("system commands", () => {
  it.each([
    ["ps", ["  PID USER     STAT COMMAND", " 1234 deploy   R api --serve"]],
    ["env", ["PATH=/usr/local/bin:/usr/bin:/bin", "SERVICE_TIER=critical"]],
    ["man service", ["SERVICE(8)", "", "NAME", "     service - the service"]],
    ["man 8 service", ["SERVICE(8)", "", "NAME", "     service - the service"]],
    ["whoami", ["root"]],
    ["uname", ["Linux"]],
    ["uname -a", ["Linux production 6.1.0-load-bearing x86_64"]],
    ["uptime", [" 09:14:22 up 400 days, 03:04"]],
    ["date", ["Wed Aug  5 09:14:22 UTC 2026"]],
    ["curl https://api.example.test/health", ["HTTP/1.1 200 OK", "tilted"]],
    [
      "systemctl status api",
      [
        "● api.service - api",
        "   Active: active (running)",
        "   Health: degraded",
      ],
    ],
  ])("renders exact output for %s", (input, stdout) => {
    expect(output(results(run([input]))[0])).toEqual({
      stdout,
      stderr: [],
      exitCode: 0,
    });
  });

  it("lists only prior history while recording every nonblank raw input", () => {
    const state = run(["echo  first ", "echo '", "history"]);
    expect(output(results(state)[2])).toEqual({
      stdout: [
        "    1  cd /production/service",
        "    2  git status",
        "    3  npm test",
        "    4  echo  first ",
        "    5  echo '",
      ],
      stderr: [],
      exitCode: 0,
    });
    expect(readWorldSlice(state).shellHistory.at(-1)).toBe("history");
  });

  it("persists environment, service and process mutations through reducer events", () => {
    const state = run([
      "export BEAM=load=bearing",
      "env",
      "systemctl stop api",
      "systemctl status api",
      "curl https://api.example.test/health",
      "systemctl restart api",
      "kill 1234",
      "ps",
    ]);
    const shell = results(state);
    expect(output(shell[1]).stdout).toContain("BEAM=load=bearing");
    expect(output(shell[3])).toEqual({
      stdout: [
        "● api.service - api",
        "   Active: inactive (dead)",
        "   Health: degraded",
      ],
      stderr: [],
      exitCode: 3,
    });
    expect(output(shell[4])).toEqual({
      stdout: [],
      stderr: ["curl: (7) api is unavailable"],
      exitCode: 7,
    });
    expect(output(shell[7]).stdout).toEqual([
      "  PID USER     STAT COMMAND",
      " 1234 deploy   T api --serve",
    ]);
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });

  it("treats kill of a present stopped process as an event-free success", () => {
    const state = run(["kill 1234", "kill 1234", "ps"]);
    expect(output(results(state)[1])).toEqual({
      stdout: [],
      stderr: [],
      exitCode: 0,
    });
    expect(
      state.transcript.filter(
        (entry) => entry.type === "world.process-transition",
      ),
    ).toHaveLength(1);
    expect(output(results(state)[2]).stdout).toEqual([
      "  PID USER     STAT COMMAND",
      " 1234 deploy   T api --serve",
    ]);
  });

  it.each([
    ["start", "running"],
    ["stop", "stopped"],
    ["restart", "running"],
  ] as const)(
    "persists systemctl %s through its owning event",
    (action, state) => {
      const session = run([`systemctl ${action} api`]);
      expect(output(results(session)[0])).toEqual({
        stdout: [],
        stderr: [],
        exitCode: 0,
      });
      expect(readWorldSlice(session).services[0]?.state).toBe(state);
    },
  );

  it.each([
    ["man missing", "No manual entry for missing", 1],
    [
      "curl https://missing.example.test/",
      "curl: (6) Could not resolve endpoint: https://missing.example.test/",
      6,
    ],
    [
      "curl ftp://example.test/",
      "curl: (3) URL rejected: ftp://example.test/",
      3,
    ],
    ["curl", "curl: usage: curl URL", 2],
    ["systemctl status missing", "Unit missing.service could not be found.", 4],
    ["kill 9999", "kill: (9999): No such process", 1],
    ["export 1BAD=value", "export: 1BAD=value: not a valid assignment", 2],
  ])("returns exact required error for %s", (input, stderr, exitCode) => {
    expect(output(results(run([input]))[0])).toEqual({
      stdout: [],
      stderr: [stderr],
      exitCode,
    });
  });

  it.each([
    "ps -x",
    "env --null",
    "export -p",
    "man -a service",
    "history -c",
    "curl -I https://api.example.test/health",
    "systemctl --user status api",
    "kill -9",
    "whoami --help",
    "uname -s",
    "uptime -p",
    "date -u",
  ])("rejects unsupported options for %s", (input) => {
    const entry = results(run([input]))[0];
    expect(entry?.exitCode).toBe(2);
    expect(entry?.output?.[0]?.stream).toBe("stderr");
  });

  it("uses the advanced simulated clock for date and uptime", () => {
    const state = run(
      ["date", "uptime"],
      [{ type: "clock.tick", payload: { ms: 61000 } }],
    );
    expect(output(results(state)[0]).stdout).toEqual([
      "Wed Aug  5 09:15:23 UTC 2026",
    ]);
    expect(output(results(state)[1]).stdout).toEqual([
      " 09:15:23 up 400 days, 03:05",
    ]);
  });
});
