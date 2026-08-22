import {
  createAgentCompactEvents,
  createAgentHelpEvents,
  createTerminalModeEvent,
  deriveEngineMetrics,
} from "../../engine/index.js";
import type {
  EngineEvent,
  EngineMetrics,
  LoadedCartridge,
  SessionState,
} from "../../engine/index.js";

export type SlashCommandName =
  "/help" | "/model" | "/compact" | "/cost" | "/exit";

export interface SlashCommandDefinition {
  readonly name: SlashCommandName;
  readonly description: string;
}

export const SLASH_COMMAND_NAMES: readonly SlashCommandName[] = Object.freeze([
  "/help",
  "/model",
  "/compact",
  "/cost",
  "/exit",
]);

function slashCommands(
  cartridge: LoadedCartridge,
): readonly SlashCommandDefinition[] {
  const copy = cartridge.presentation.autocomplete;
  return [
    { name: "/help", description: copy.help },
    { name: "/model", description: copy.model },
    { name: "/compact", description: copy.compact },
    { name: "/cost", description: copy.cost },
    { name: "/exit", description: copy.exit },
  ];
}

export type SlashCommandResult =
  | { readonly kind: "dispatch"; readonly events: readonly EngineEvent[] }
  | { readonly kind: "model-selector" }
  | { readonly kind: "metrics"; readonly metrics: EngineMetrics }
  | { readonly kind: "error"; readonly message: string };

/** Discover only the command token; argument completion belongs to T24. */
export function discoverSlashCommands(
  cartridge: LoadedCartridge,
  input: string,
): readonly SlashCommandDefinition[] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const prefix = input.toLowerCase();
  return slashCommands(cartridge).filter(({ name }) => name.startsWith(prefix));
}

/** Execute the complete bounded slash register without a parallel state store. */
export function executeSlashCommand(
  cartridge: LoadedCartridge,
  state: SessionState,
  input: string,
): SlashCommandResult {
  const normalized = input.trim();
  const commandName = normalized.toLowerCase();
  const definition = SLASH_COMMAND_NAMES.find((name) => name === commandName);
  if (definition === undefined) {
    return {
      kind: "error",
      message: normalized.includes(" ")
        ? `Usage: ${normalized.split(/\s/u, 1)[0] ?? "/command"}`
        : `Unknown command: ${normalized || "/"}`,
    };
  }

  switch (definition) {
    case "/help":
      return {
        kind: "dispatch",
        events: createAgentHelpEvents(cartridge, state),
      };
    case "/model":
      return { kind: "model-selector" };
    case "/compact":
      return {
        kind: "dispatch",
        events: createAgentCompactEvents(cartridge, state),
      };
    case "/cost":
      return { kind: "metrics", metrics: deriveEngineMetrics(state) };
    case "/exit":
      return { kind: "dispatch", events: [createTerminalModeEvent("bash")] };
  }
}
