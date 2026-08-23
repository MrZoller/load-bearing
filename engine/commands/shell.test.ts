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

function shellResult(state: SessionState) {
  return state.transcript.at(-1);
}

describe("shell execution", () => {
  it.each([
    ["pwd", ["/production/service"]],
    ["echo one 'two three'", ["one two three"]],
    ["true", []],
  ])("runs the %s builtin through an unlogged expansion", (input, stdout) => {
    const state = fold(input);
    expect(state.eventCount).toBe(2);
    expect(state.transcript.map((entry) => entry.type)).toEqual([
      "world.history-append",
      "shell.result",
    ]);
    expect(shellResult(state)).toMatchObject({
      output: stdout.map((text) => ({ stream: "stdout", text })),
      exitCode: 0,
    });
  });

  it("returns a successful empty result for blank input", () => {
    const state = fold("  \t ");
    expect(state.eventCount).toBe(1);
    expect(shellResult(state)).toMatchObject({
      output: [],
      exitCode: 0,
    });
  });

  it("stamps the shell envelope and its expanded result", () => {
    expect(createShellExecuteEvent("true")).toMatchObject({ version: 0 });
    expect(fold("true").transcript).toHaveLength(2);
  });

  it("returns plausible exit-127 stderr for an unknown command", () => {
    expect(shellResult(fold("missing"))).toMatchObject({
      output: [{ stream: "stderr", text: "missing: command not found" }],
      exitCode: 127,
    });
  });

  it.each([
    ["echo first | echo second", "stdout", "first | echo second", 0],
    ["echo first > redirected.txt", "stdout", "first > redirected.txt", 0],
    ["vi README.md", "stderr", "vi: command not found", 127],
    ["script", "stderr", "script: command not found", 127],
    ["ssh production", "stderr", "ssh: command not found", 127],
  ])(
    "does not turn %s into a pipeline, redirection, editor, PTY, or host-command capability",
    (input, stream, text, exitCode) => {
      const state = fold(input);

      expect(shellResult(state)).toMatchObject({
        output: [{ stream, text }],
        exitCode,
      });
      expect(state.slices["vfs"]).toMatchObject({
        entries: expect.not.objectContaining({
          "/production/service/redirected.txt": expect.anything(),
        }),
      });
    },
  );

  it("uses the generic option parser at builtin dispatch", () => {
    expect(shellResult(fold("pwd -LP --"))).toMatchObject({
      output: [{ stream: "stdout", text: "/production/service" }],
      exitCode: 0,
    });
    expect(shellResult(fold("pwd -z"))).toMatchObject({
      output: [{ stream: "stderr", text: "pwd: invalid option: -z" }],
      exitCode: 2,
    });
  });

  it("records stdout before stderr for a static cartridge override", () => {
    const entry = fold("pwd ignored", {
      pwd: { stdout: ["authored out"], stderr: ["authored err"], exitCode: 9 },
    }).transcript.at(-1);
    expect(entry).toMatchObject({
      output: [
        { stream: "stdout", text: "authored out" },
        { stream: "stderr", text: "authored err" },
      ],
      exitCode: 9,
    });
  });

  it("turns tokenizer errors into deterministic shell results", () => {
    const state = fold("echo '");
    expect(shellResult(state)).toMatchObject({
      output: [{ stream: "stderr", text: "shell: unterminated single quote" }],
      exitCode: 2,
    });
    expect(state.slices["world"]).toMatchObject({
      shellHistory: [
        "cd /production/service",
        "git status",
        "npm test",
        "echo '",
      ],
    });
  });

  it("accepts the shell input limit exactly and returns an error result over it", () => {
    expect(shellResult(fold("x".repeat(MAX_SHELL_INPUT_LENGTH)))).toMatchObject(
      {
        exitCode: 127,
      },
    );
    expect(
      shellResult(fold("x".repeat(MAX_SHELL_INPUT_LENGTH + 1))),
    ).toMatchObject({
      output: [
        {
          stream: "stderr",
          text: `shell: command exceeds the ${String(MAX_SHELL_INPUT_LENGTH)} character limit`,
        },
      ],
      exitCode: 2,
    });
    expect(
      shellResult(fold("🧱".repeat(MAX_SHELL_INPUT_LENGTH))),
    ).toMatchObject({ exitCode: 127 });
    expect(
      shellResult(fold("🧱".repeat(MAX_SHELL_INPUT_LENGTH + 1))),
    ).toMatchObject({
      exitCode: 2,
    });
  });

  it.each(["echo bad\u0000input", "echo \ud800"])(
    "returns an error result for unrenderable input %j",
    (input) => {
      expect(shellResult(fold(input))).toMatchObject({
        output: [
          {
            stream: "stderr",
            text: "shell: command contains unrenderable input",
          },
        ],
        exitCode: 2,
      });
    },
  );

  it.each([
    ["an unterminated quote containing a control character", "echo '\u0000"],
    ["a dangling escape after a lone surrogate", "echo \ud800\\"],
    ["surrogate halves separated by shell whitespace", "echo \ud800\n\udc00"],
    [
      "surrogate halves separated by quoted shell whitespace",
      "echo '\ud800\n\udc00'",
    ],
  ])("rejects %s before tokenization or history", (_case, input) => {
    const before = reduce({
      cartridge: loadCartridge(loadCartridgeFixture("minimal")),
      seed: "shell",
      events: [],
    });
    const after = fold(input);

    expect(shellResult(after)).toMatchObject({
      output: [
        {
          stream: "stderr",
          text: "shell: command contains unrenderable input",
        },
      ],
      exitCode: 2,
    });
    expect(after.slices).toEqual(before.slices);
    expect(after.transcript).toHaveLength(1);
  });

  it.each([
    [
      "an oversized command",
      `touch /production/service/should-not-exist ${"x".repeat(MAX_SHELL_INPUT_LENGTH)}`,
    ],
    ["a control character", "touch /production/service/should-not-exist\u0000"],
    ["a lone surrogate", "touch /production/service/should-not-exist\ud800"],
  ])("does not mutate state or history for %s", (_case, input) => {
    const before = reduce({
      cartridge: loadCartridge(loadCartridgeFixture("minimal")),
      seed: "shell",
      events: [],
    });
    const after = fold(input);

    // Rejected input gets its result event but must not become history or run
    // even a valid-looking command prefix before the invalid bytes.
    expect(after.slices).toEqual(before.slices);
    expect(after.transcript).toHaveLength(1);
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

  it.each([
    ["non-array stdout", "stdout", "bad", /stdout must be an array/],
    ["non-string stderr", "stderr", [1], /stderr\[0\] must be a string/],
  ])("rejects shell.result with %s", (_case, key, value, expected) => {
    expect(() =>
      reduce({
        cartridge: loadCartridge(loadCartridgeFixture("minimal")),
        seed: "shell-result-stream-payload",
        events: [
          {
            type: "shell.result",
            payload: { stdout: [], stderr: [], exitCode: 0, [key]: value },
          },
        ],
      }),
    ).toThrow(expected);
  });

  it("renders stream tags and the exit status from structured state", () => {
    expect(
      renderTranscript(
        fold("both", {
          both: { stdout: ["out"], stderr: ["err"], exitCode: 4 },
        }).transcript,
      ),
    ).toEqual([
      "0000  2026-08-05T09:14:22.000Z  world.history-append length=4",
      "0001  2026-08-05T09:14:22.000Z  shell.result exit=4",
      "      stdout> out",
      "      stderr> err",
    ]);
  });

  it("restores structured command output without changing it", () => {
    const state = fold("echo stable");
    expect(restoreSnapshot(snapshot(state))).toEqual(state);
  });
});
