import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { bootstrap } from "../events/reduce.js";
import { MAX_TRANSCRIPT_DETAIL_LINES } from "../events/transcript.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createCommandRegistry, executeCommand } from "./registry.js";
import type { CommandExecution } from "./types.js";

function state(commands?: Record<string, unknown>) {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  if (commands !== undefined) {
    (source["repository"] as Record<string, unknown>)["commands"] = commands;
  }
  return bootstrap({ cartridge: loadCartridge(source), seed: "commands" });
}

describe("the command registry", () => {
  it("rejects duplicate registration rather than choosing by list order", () => {
    const command = {
      name: "same",
      execute: () => ({ stdout: [], stderr: [], exitCode: 0, events: [] }),
    };
    expect(() => createCommandRegistry([command, command])).toThrow(
      /duplicate registration/,
    );
  });

  it("captures a definition so later replacement cannot change dispatch", () => {
    const command = {
      name: "stable",
      execute: () => ({
        stdout: ["first"],
        stderr: [],
        exitCode: 0,
        events: [],
      }),
    };
    const registry = createCommandRegistry([command]);
    command.execute = () => ({
      stdout: ["later"],
      stderr: [],
      exitCode: 0,
      events: [],
    });

    expect(executeCommand(state(), ["stable"], registry).stdout).toEqual([
      "first",
    ]);
  });

  it("gives a static cartridge record explicit precedence over a runtime builtin", () => {
    const registry = createCommandRegistry([
      {
        name: "same",
        execute: () => ({
          stdout: ["runtime"],
          stderr: [],
          exitCode: 0,
          events: [],
        }),
      },
    ]);
    const result = executeCommand(
      state({
        same: { stdout: ["cartridge"], stderr: ["warning"], exitCode: 7 },
      }),
      ["same"],
      registry,
    );

    expect(result).toMatchObject({
      stdout: ["cartridge"],
      stderr: ["warning"],
      exitCode: 7,
    });
  });

  it.each([
    ["a non-object execution", null, /must return an execution object/],
    ["an array execution", [], /must return an execution object/],
    [
      "non-array stdout",
      { stdout: "out", stderr: [], exitCode: 0, events: [] },
      /stdout must be an array of lines/,
    ],
    [
      "a sparse stdout array",
      { stdout: new Array(1), stderr: [], exitCode: 0, events: [] },
      /stdout\[0\] is a hole/,
    ],
    [
      "a non-string stderr line",
      { stdout: [], stderr: [1], exitCode: 0, events: [] },
      /stderr\[0\] must be a string/,
    ],
    [
      "a non-integer exit code",
      { stdout: [], stderr: [], exitCode: 0.5, events: [] },
      /exitCode must be an integer in \[0, 255\]/,
    ],
    [
      "an out-of-range exit code",
      { stdout: [], stderr: [], exitCode: 256, events: [] },
      /exitCode must be an integer in \[0, 255\]/,
    ],
    [
      "too many output lines",
      {
        stdout: Array.from(
          { length: MAX_TRANSCRIPT_DETAIL_LINES + 1 },
          () => "line",
        ),
        stderr: [],
        exitCode: 0,
        events: [],
      },
      /emits more than 4096 output lines/,
    ],
    [
      "non-array events",
      { stdout: [], stderr: [], exitCode: 0, events: {} },
      /events must be an array/,
    ],
    [
      "a sparse events array",
      { stdout: [], stderr: [], exitCode: 0, events: new Array(1) },
      /events\[0\] is a hole/,
    ],
    [
      "a malformed event",
      { stdout: [], stderr: [], exitCode: 0, events: [null] },
      /events\[0\] must be an event object/,
    ],
  ])("rejects %s from a command implementation", (_case, raw, expected) => {
    const registry = createCommandRegistry([
      {
        name: "malformed",
        execute: () => raw as CommandExecution,
      },
    ]);

    expect(() => executeCommand(state(), ["malformed"], registry)).toThrow(
      expected,
    );
  });
});
