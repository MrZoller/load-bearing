import { createCommandRegistry } from "./registry.js";
import { CommandOptionError, parseCommandOptions } from "./options.js";
import type { CommandContext, CommandDefinition } from "./types.js";
import { readVfsSlice } from "../vfs/module.js";
import { FILESYSTEM_COMMANDS } from "./filesystem.js";
import { GIT_COMMANDS } from "./git.js";

const PWD: CommandDefinition = Object.freeze({
  name: "pwd",
  execute(context: CommandContext) {
    let operands: readonly string[];
    try {
      operands = parseCommandOptions(context.argv.slice(1), [
        { key: "logical", short: "L" },
        { key: "physical", short: "P" },
      ]).operands;
    } catch (error) {
      if (!(error instanceof CommandOptionError)) throw error;
      const token = error.token;
      return {
        stdout: [],
        stderr: [`pwd: invalid option: ${token}`],
        exitCode: 2,
        events: [],
      };
    }
    if (operands.length > 0) {
      return {
        stdout: [],
        stderr: ["pwd: too many arguments"],
        exitCode: 2,
        events: [],
      };
    }
    return {
      stdout: [readVfsSlice(context.state).cwd],
      stderr: [],
      exitCode: 0,
      events: [],
    };
  },
});

const ECHO: CommandDefinition = Object.freeze({
  name: "echo",
  execute(context: CommandContext) {
    return {
      stdout: [context.argv.slice(1).join(" ")],
      stderr: [],
      exitCode: 0,
      events: [],
    };
  },
});

const TRUE: CommandDefinition = Object.freeze({
  name: "true",
  execute() {
    return { stdout: [], stderr: [], exitCode: 0, events: [] };
  },
});

export const BUILTIN_COMMANDS = Object.freeze([
  PWD,
  ECHO,
  TRUE,
  ...FILESYSTEM_COMMANDS,
  ...GIT_COMMANDS,
]);
export const BUILTIN_COMMAND_REGISTRY = createCommandRegistry(BUILTIN_COMMANDS);
