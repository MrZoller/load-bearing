import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import {
  bootstrap,
  reduce,
  restoreSnapshot,
  snapshot,
  step,
} from "../events/reduce.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { executeCommand } from "../commands/registry.js";
import { BUILTIN_COMMAND_REGISTRY } from "../commands/builtins.js";
import { readTestsSlice } from "./module.js";

function cartridge(override = false) {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  const repository = source["repository"] as Record<string, unknown>;
  repository["tests"] = [
    {
      id: "source",
      name: "source has repaired load",
      durationMs: 1250,
      predicate: {
        kind: "file-contents",
        path: "/production/service/src/index.ts",
        equals: "export const load = 2;\n",
      },
    },
    {
      id: "readme",
      name: "readme exists",
      durationMs: 250,
      predicate: {
        kind: "file-exists",
        path: "/production/service/README.md",
        exists: true,
      },
    },
  ];
  if (override)
    repository["commands"] = {
      npm: { stdout: ["cartridge npm"], stderr: [], exitCode: 9 },
    };
  return loadCartridge(source);
}

describe("simulated tests", () => {
  it("records pass/fail history around a VFS edit and advances exact authored time", () => {
    const state = reduce({
      cartridge: cartridge(),
      seed: "tests",
      events: [
        { type: "tests.run", payload: {} },
        {
          type: "vfs.write",
          payload: {
            path: "/production/service/src/index.ts",
            contents: "export const load = 2;\n",
          },
        },
        { type: "tests.run", payload: {} },
      ],
    });
    const runs = readTestsSlice(state).runs;
    expect(runs.map((run) => run.cases.map((test) => test.passed))).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(runs).toMatchObject([
      {
        startedAt: "2026-08-05T09:14:22.000Z",
        finishedAt: "2026-08-05T09:14:23.500Z",
        durationMs: 1500,
        exitCode: 1,
      },
      {
        startedAt: "2026-08-05T09:14:23.500Z",
        finishedAt: "2026-08-05T09:14:25.000Z",
        durationMs: 1500,
        exitCode: 0,
      },
    ]);
    expect(state.clock.elapsedMs).toBe(3000);
    expect(state.transcript[0]).toMatchObject({
      output: [
        { stream: "stdout", text: "FAIL source has repaired load (1250ms)" },
        { stream: "stdout", text: "PASS readme exists (250ms)" },
        { stream: "stdout", text: "Tests: 1 passed, 1 failed, 2 total" },
        { stream: "stdout", text: "Time: 1500ms" },
      ],
      exitCode: 1,
    });
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });

  it("treats an empty suite as a successful zero-duration run", () => {
    const source = loadCartridgeFixture("minimal");
    const state = step(
      bootstrap({ cartridge: loadCartridge(source), seed: "empty" }),
      {
        type: "tests.run",
        payload: {},
      },
    );
    expect(readTestsSlice(state).runs[0]).toMatchObject({
      durationMs: 0,
      cases: [],
      exitCode: 0,
    });
  });

  it("checks file existence without requiring permission to read its contents", () => {
    const state = reduce({
      cartridge: cartridge(),
      seed: "unreadable-exists",
      events: [
        {
          type: "vfs.chmod",
          payload: { path: "/production/service/README.md", mode: "0000" },
        },
        { type: "tests.run", payload: {} },
      ],
    });
    const run = readTestsSlice(state).runs[0];
    if (run === undefined) throw new Error("test run was not recorded");
    expect(run.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "readme", passed: true }),
      ]),
    );
  });

  it("rejects test history snapshots whose derived timing is incoherent", () => {
    const state = step(
      bootstrap({ cartridge: cartridge(), seed: "snapshot" }),
      { type: "tests.run", payload: {} },
    );
    const parsed = JSON.parse(snapshot(state)) as Record<string, unknown>;
    const slices = parsed["slices"] as Record<string, unknown>;
    const tests = slices["tests"] as { runs: Record<string, unknown>[] };
    const first = tests.runs[0];
    if (first === undefined) throw new Error("test run was not recorded");
    first["finishedAt"] = first["startedAt"];
    expect(() => restoreSnapshot(JSON.stringify(parsed))).toThrow(
      /timestamps must span durationMs exactly/,
    );
  });

  it("supports exactly npm test and leaves cartridge override precedence intact", () => {
    const state = bootstrap({ cartridge: cartridge(), seed: "npm" });
    expect(
      executeCommand(state, ["npm", "test"], BUILTIN_COMMAND_REGISTRY),
    ).toMatchObject({
      stdout: expect.arrayContaining([
        "FAIL source has repaired load (1250ms)",
      ]),
      stderr: [],
      exitCode: 1,
      events: [{ type: "tests.run", payload: {}, version: 0 }],
    });
    for (const argv of [
      ["npm"],
      ["npm", "run", "test"],
      ["npm", "test", "--watch"],
    ]) {
      expect(
        executeCommand(state, argv, BUILTIN_COMMAND_REGISTRY),
      ).toMatchObject({
        stdout: [],
        stderr: ["npm: only `npm test` is supported"],
        exitCode: 2,
        events: [],
      });
    }
    const overridden = bootstrap({ cartridge: cartridge(true), seed: "npm" });
    expect(
      executeCommand(overridden, ["npm", "test"], BUILTIN_COMMAND_REGISTRY),
    ).toMatchObject({
      stdout: ["cartridge npm"],
      exitCode: 9,
      events: [],
    });
  });
});
