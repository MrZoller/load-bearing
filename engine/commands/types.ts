import type { SessionState } from "../events/state.js";
import type { EngineEvent } from "../events/state.js";

export interface CommandResult {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
}

export interface CommandExecution extends CommandResult {
  /** Owning-subsystem events folded before the final `shell.result`. */
  readonly events: readonly EngineEvent[];
}

export interface CommandContext {
  readonly state: SessionState;
  /** The complete argument vector, including the command name at index zero. */
  readonly argv: readonly string[];
}

export interface CommandDefinition {
  readonly name: string;
  execute(context: CommandContext): CommandExecution;
}

export interface RegisteredCommand {
  readonly name: string;
  execute(context: CommandContext): CommandExecution;
}

export interface CommandRegistry {
  readonly names: readonly string[];
  command(name: string): RegisteredCommand | undefined;
}

export interface CommandOptionSpec {
  /** Stable key used in `ParsedCommandOptions.options`. */
  readonly key: string;
  readonly short?: string;
  readonly long?: string;
  readonly value?: "none" | "required";
}

export interface ParsedCommandOptions {
  /** Every occurrence in input order. `null` represents a flag. */
  readonly options: Readonly<Record<string, readonly (string | null)[]>>;
  readonly operands: readonly string[];
}
