import type { EngineEvent, SessionState } from "../events/state.js";
import { stampEvent } from "../events/log.js";
import { BUILTIN_COMMAND_REGISTRY } from "./builtins.js";
import { executeCommand } from "./registry.js";
import { ShellSyntaxError, tokenizeShell } from "./tokenize.js";
import type { CommandExecution, CommandRegistry } from "./types.js";

/** Leaves room for the fixed suffix on unknown-command stderr. */
export const MAX_SHELL_INPUT_LENGTH = 4000;

function resultEvent(result: CommandExecution): EngineEvent {
  return stampEvent(
    {
      type: "shell.result",
      payload: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    },
    "shell result",
  );
}

/** Expand one visitor command into ordinary logged subsystem events. */
export function executeShell(
  state: SessionState,
  input: string,
  registry: CommandRegistry = BUILTIN_COMMAND_REGISTRY,
): readonly EngineEvent[] {
  if (input.length > MAX_SHELL_INPUT_LENGTH) {
    throw new Error(
      `shell input is ${String(input.length)} characters, over the ${String(MAX_SHELL_INPUT_LENGTH)} command limit`,
    );
  }
  const history =
    input.trim() === ""
      ? []
      : [
          stampEvent(
            { type: "world.history-append", payload: { command: input } },
            "shell history",
          ),
        ];
  let argv: readonly string[];
  try {
    argv = tokenizeShell(input);
  } catch (error) {
    if (!(error instanceof ShellSyntaxError)) throw error;
    const reason = error.reason;
    const result: CommandExecution = {
      stdout: [],
      stderr: [`shell: ${reason}`],
      exitCode: 2,
      events: [],
    };
    return Object.freeze([...history, resultEvent(result)]);
  }
  const execution = executeCommand(state, argv, registry);
  return Object.freeze([
    ...history,
    ...execution.events,
    resultEvent(execution),
  ]);
}

/** The event Phase 1 views append for a visitor shell command. */
export function createShellExecuteEvent(input: string): EngineEvent {
  return stampEvent(
    { type: "shell.execute", payload: { input } },
    "shell execute",
  );
}
