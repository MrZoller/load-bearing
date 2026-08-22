import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readTerminalSlice } from "../terminal/terminal.js";
import { BUILTIN_COMMANDS } from "./builtins.js";
import { createShellExecuteEvent } from "./shell.js";

function fold(input: string): SessionState {
  return reduce({
    cartridge: loadCartridge(loadCartridgeFixture("minimal")),
    seed: "terminal-commands",
    events: [createShellExecuteEvent(input)],
  });
}

function shellResult(state: SessionState) {
  return state.transcript.at(-1);
}

describe("terminal commands", () => {
  it("registers the terminal commands among builtins", () => {
    expect(BUILTIN_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(["loadbearing", "exit"]),
    );
  });

  it("resumes only the current incident and enters TUI through the terminal event", () => {
    for (const input of [
      "loadbearing --resume",
      "loadbearing --resume incident-000",
    ]) {
      const state = fold(input);
      expect(readTerminalSlice(state).mode).toBe("tui");
      expect(state.transcript.map((entry) => entry.type)).toEqual([
        "world.history-append",
        "terminal.mode-set",
        "shell.result",
      ]);
      expect(shellResult(state)).toMatchObject({ output: [], exitCode: 0 });
    }

    for (const input of [
      "loadbearing",
      "loadbearing --resume incident-001",
      "loadbearing --resume incident-000 extra",
    ]) {
      expect(shellResult(fold(input))).toMatchObject({
        output: [
          {
            stream: "stderr",
            text: "usage: loadbearing --resume [incident-NNN]",
          },
        ],
        exitCode: 2,
      });
    }
  });

  it("refuses bare exit while preserving the command transcript ordering", () => {
    const state = fold("exit");

    expect(readTerminalSlice(state).mode).toBe("bash");
    expect(state.transcript.map((entry) => entry.type)).toEqual([
      "world.history-append",
      "shell.result",
    ]);
    expect(shellResult(state)).toMatchObject({
      output: [{ stream: "stdout", text: "exit is load-bearing" }],
      exitCode: 1,
    });
  });
});
