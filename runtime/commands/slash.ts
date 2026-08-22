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

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = Object.freeze([
  { name: "/help", description: "Show the authored command reference" },
  { name: "/model", description: "Choose the active agent model" },
  {
    name: "/compact",
    description: "Replace context with its authored summary",
  },
  { name: "/cost", description: "Report replay-derived session metrics" },
  { name: "/exit", description: "Return to the incident shell" },
]);

export type SlashCommandResult =
  | { readonly kind: "dispatch"; readonly events: readonly EngineEvent[] }
  | { readonly kind: "model-selector" }
  | { readonly kind: "metrics"; readonly metrics: EngineMetrics }
  | { readonly kind: "error"; readonly message: string };

/** Discover only the command token; argument completion belongs to T24. */
export function discoverSlashCommands(
  input: string,
): readonly SlashCommandDefinition[] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const prefix = input.toLowerCase();
  return SLASH_COMMANDS.filter(({ name }) => name.startsWith(prefix));
}

/** Execute the complete bounded slash register without a parallel state store. */
export function executeSlashCommand(
  cartridge: LoadedCartridge,
  state: SessionState,
  input: string,
): SlashCommandResult {
  const normalized = input.trim();
  const definition = SLASH_COMMANDS.find(({ name }) => name === normalized);
  if (definition === undefined) {
    return {
      kind: "error",
      message: normalized.includes(" ")
        ? `Usage: ${normalized.split(/\s/u, 1)[0] ?? "/command"}`
        : `Unknown command: ${normalized || "/"}`,
    };
  }

  switch (definition.name) {
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
