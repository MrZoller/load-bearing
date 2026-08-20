import { COMMAND_NAME_PATTERN } from "../cartridge/schema.js";
import { MAX_TRANSCRIPT_DETAIL_LINES } from "../events/transcript.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import type {
  CommandDefinition,
  CommandExecution,
  CommandRegistry,
  RegisteredCommand,
} from "./types.js";

export class CommandRegistryError extends Error {
  constructor(detail: string) {
    super(`command registry: ${detail}`);
    this.name = "CommandRegistryError";
  }
}

export function createCommandRegistry(
  definitions: readonly CommandDefinition[],
): CommandRegistry {
  const listed = [...definitions];
  const commands = new Map<string, RegisteredCommand>();
  for (const candidate of listed) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new CommandRegistryError(
        "each command definition must be an object",
      );
    }
    const declared = candidate as CommandDefinition;
    const name: unknown = declared.name;
    const execute: unknown = declared.execute;
    if (typeof name !== "string") {
      throw new CommandRegistryError("a command name must be a string");
    }
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new CommandRegistryError(
        `name ${JSON.stringify(name)} must contain only shell command-name characters`,
      );
    }
    if (typeof execute !== "function") {
      throw new CommandRegistryError(
        `command ${JSON.stringify(name)} has no execute function`,
      );
    }
    if (commands.has(name)) {
      throw new CommandRegistryError(
        `duplicate registration for ${JSON.stringify(name)}; dispatch precedence must be explicit`,
      );
    }
    commands.set(
      name,
      Object.freeze({
        name,
        execute: (execute as CommandDefinition["execute"]).bind(declared),
      }),
    );
  }
  const names = Object.freeze([...commands.keys()].sort());
  return Object.freeze({
    names,
    command: (name: string): RegisteredCommand | undefined =>
      commands.get(name),
  });
}

function captureLines(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CommandRegistryError(`${label} must be an array of lines`);
  }
  const lines: string[] = [];
  const count = value.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in value)) {
      throw new CommandRegistryError(`${label}[${String(index)}] is a hole`);
    }
    const line: unknown = value[index];
    if (typeof line !== "string") {
      throw new CommandRegistryError(
        `${label}[${String(index)}] must be a string`,
      );
    }
    lines.push(line);
  }
  return Object.freeze(lines);
}

function captureExecution(raw: unknown, name: string): CommandExecution {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommandRegistryError(
      `command ${JSON.stringify(name)} must return an execution object`,
    );
  }
  const execution = raw as CommandExecution;
  const stdout = captureLines(execution.stdout, `${name}.stdout`);
  const stderr = captureLines(execution.stderr, `${name}.stderr`);
  const exitCode: unknown = execution.exitCode;
  const rawEvents: unknown = execution.events;
  if (
    typeof exitCode !== "number" ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  ) {
    throw new CommandRegistryError(
      `${name}.exitCode must be an integer in [0, 255]`,
    );
  }
  if (stdout.length + stderr.length > MAX_TRANSCRIPT_DETAIL_LINES) {
    throw new CommandRegistryError(
      `${name} emits more than ${String(MAX_TRANSCRIPT_DETAIL_LINES)} output lines`,
    );
  }
  if (!Array.isArray(rawEvents)) {
    throw new CommandRegistryError(`${name}.events must be an array`);
  }
  const events: EngineEvent[] = [];
  const count = rawEvents.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in rawEvents)) {
      throw new CommandRegistryError(
        `${name}.events[${String(index)}] is a hole`,
      );
    }
    const event: unknown = rawEvents[index];
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      throw new CommandRegistryError(
        `${name}.events[${String(index)}] must be an event object`,
      );
    }
    events.push(event as EngineEvent);
  }
  return Object.freeze({
    stdout,
    stderr,
    exitCode,
    events: Object.freeze(events),
  });
}

export function executeCommand(
  state: SessionState,
  argv: readonly string[],
  registry: CommandRegistry,
): CommandExecution {
  const name = argv[0];
  if (name === undefined) {
    return Object.freeze({
      stdout: Object.freeze([]),
      stderr: Object.freeze([]),
      exitCode: 0,
      events: Object.freeze([]),
    });
  }

  const authored = state.cartridge.repository.commands;
  if (Object.hasOwn(authored, name)) {
    const command = authored[name];
    if (command === undefined) {
      throw new CommandRegistryError(
        `cartridge command ${JSON.stringify(name)} disappeared after lookup`,
      );
    }
    return Object.freeze({
      stdout: command.stdout,
      stderr: command.stderr,
      exitCode: command.exitCode,
      events: Object.freeze([]),
    });
  }

  const command = registry.command(name);
  if (command === undefined) {
    return Object.freeze({
      stdout: Object.freeze([]),
      stderr: Object.freeze([`${name}: command not found`]),
      exitCode: 127,
      events: Object.freeze([]),
    });
  }
  return captureExecution(
    command.execute({ state, argv: Object.freeze([...argv]) }),
    name,
  );
}
