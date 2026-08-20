import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { reduce, restoreSnapshot, snapshot } from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { renderTranscript } from "../events/transcript.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { MAX_SHELL_INPUT_LENGTH, createShellExecuteEvent } from "./shell.js";

function fold(input: string, commands?: Record<string, unknown>): SessionState {
  const source = loadCartridgeFixture("minimal") as Record<string, unknown>;
  if (commands !== undefined) {
    (source["repository"] as Record<string, unknown>)["commands"] = commands;
  }
  return reduce({
    cartridge: loadCartridge(source),
    seed: "shell",
    events: [createShellExecuteEvent(input)],
  });
}

describe("shell execution", () => {
  it.each([
    ["pwd", ["/production/service"]],
    ["echo one 'two three'", ["one two three"]],
    ["true", []],
  ])("runs the %s builtin through an unlogged expansion", (input, stdout) => {
    const state = fold(input);
    expect(state.eventCount).toBe(1);
    expect(state.transcript.map((entry) => entry.type)).toEqual([
      "shell.result",
    ]);
    expect(state.transcript[0]).toMatchObject({
      output: stdout.map((text) => ({ stream: "stdout", text })),
      exitCode: 0,
    });
  });

  it("returns a successful empty result for blank input", () => {
    expect(fold("  \t ").transcript[0]).toMatchObject({
      output: [],
      exitCode: 0,
    });
  });

  it("returns plausible exit-127 stderr for an unknown command", () => {
    expect(fold("missing").transcript[0]).toMatchObject({
      output: [{ stream: "stderr", text: "missing: command not found" }],
      exitCode: 127,
    });
  });

  it("uses the generic option parser at builtin dispatch", () => {
    expect(fold("pwd -LP --").transcript[0]).toMatchObject({
      output: [{ stream: "stdout", text: "/production/service" }],
      exitCode: 0,
    });
    expect(fold("pwd -z").transcript[0]).toMatchObject({
      output: [{ stream: "stderr", text: "pwd: invalid option: -z" }],
      exitCode: 2,
    });
  });

  it("records stdout before stderr for a static cartridge override", () => {
    const entry = fold("pwd ignored", {
      pwd: { stdout: ["authored out"], stderr: ["authored err"], exitCode: 9 },
    }).transcript[0];
    expect(entry).toMatchObject({
      output: [
        { stream: "stdout", text: "authored out" },
        { stream: "stderr", text: "authored err" },
      ],
      exitCode: 9,
    });
  });

  it("turns tokenizer errors into deterministic shell results", () => {
    expect(fold("echo '").transcript[0]).toMatchObject({
      output: [{ stream: "stderr", text: "shell: unterminated single quote" }],
      exitCode: 2,
    });
  });

  it("accepts the shell input limit exactly and throws its bare limit error over it", () => {
    expect(
      fold("x".repeat(MAX_SHELL_INPUT_LENGTH)).transcript[0],
    ).toMatchObject({
      exitCode: 127,
    });
    expect(() => fold("x".repeat(MAX_SHELL_INPUT_LENGTH + 1))).toThrow(
      `shell input is ${String(MAX_SHELL_INPUT_LENGTH + 1)} characters, over the ${String(MAX_SHELL_INPUT_LENGTH)} command limit`,
    );
  });

  it.each([
    ["a string", "0"],
    ["a fraction", 0.5],
    ["a negative integer", -1],
    ["an integer above 255", 256],
  ])(
    "rejects a direct shell.result replay payload with exitCode %s",
    (_case, exitCode) => {
      expect(() =>
        reduce({
          cartridge: loadCartridge(loadCartridgeFixture("minimal")),
          seed: "shell-result-payload",
          events: [
            {
              type: "shell.result",
              payload: { stdout: [], stderr: [], exitCode },
            },
          ],
        }),
      ).toThrow(/exitCode must be an integer in \[0, 255\]/);
    },
  );

  it("renders stream tags and the exit status from structured state", () => {
    expect(
      renderTranscript(
        fold("both", {
          both: { stdout: ["out"], stderr: ["err"], exitCode: 4 },
        }).transcript,
      ),
    ).toEqual([
      "0000  2026-08-05T09:14:22.000Z  shell.result exit=4",
      "      stdout> out",
      "      stderr> err",
    ]);
  });

  it("restores structured command output without changing it", () => {
    const state = fold("echo stable");
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });
});
