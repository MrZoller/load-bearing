/** Commands that cross between the Bash and agent-TUI views. */

import type { CommandContext, CommandDefinition } from "./types.js";
import { createAgentResumeEvents } from "../agent/awareness.js";

const RESUME_USAGE = "usage: loadbearing --resume [incident-NNN]";

const LOADBEARING: CommandDefinition = Object.freeze({
  name: "loadbearing",
  execute(context: CommandContext) {
    const args = context.argv.slice(1);
    const incident = `incident-${String(context.state.cartridge.meta.number).padStart(3, "0")}`;
    if (
      (args.length !== 1 && args.length !== 2) ||
      args[0] !== "--resume" ||
      (args.length === 2 && args[1] !== incident)
    )
      return { stdout: [], stderr: [RESUME_USAGE], exitCode: 2, events: [] };
    return {
      stdout: [],
      stderr: [],
      exitCode: 0,
      events: createAgentResumeEvents(context.state.cartridge, context.state),
    };
  },
});

const EXIT: CommandDefinition = Object.freeze({
  name: "exit",
  execute(context: CommandContext) {
    if (context.argv.length !== 1)
      return {
        stdout: [],
        stderr: ["exit: too many arguments"],
        exitCode: 2,
        events: [],
      };
    return {
      stdout: ["exit is load-bearing"],
      stderr: [],
      exitCode: 1,
      events: [],
    };
  },
});

export const TERMINAL_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  LOADBEARING,
  EXIT,
]);
