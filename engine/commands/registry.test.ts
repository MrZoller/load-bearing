import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { bootstrap } from "../events/reduce.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { createCommandRegistry, executeCommand } from "./registry.js";

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
});
