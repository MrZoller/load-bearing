import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  deriveEngineMetrics,
  loadCartridge,
  readAgentSlice,
  readMindSlice,
  readTerminalSlice,
  reduce,
} from "../../engine/index.js";
import { discoverSlashCommands, executeSlashCommand } from "./slash.js";

const CARTRIDGE = loadCartridge(cartridgeDocument);
const SEED = "2026-08-22/0/structural-audit";

function stateFor(events: Parameters<typeof reduce>[0]["events"] = []) {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

describe("the slash command registry", () => {
  it("discovers the typed command register case-insensitively, without completing arguments", () => {
    expect(discoverSlashCommands("/c")).toEqual([
      {
        name: "/compact",
        description: "Replace context with its authored summary",
      },
      {
        name: "/cost",
        description: "Report replay-derived session metrics",
      },
    ]);
    expect(discoverSlashCommands("/MO")).toMatchObject([{ name: "/model" }]);
    expect(discoverSlashCommands("/model temporary")).toEqual([]);
    expect(discoverSlashCommands("help")).toEqual([]);
  });

  it("executes authored help and compaction through replayable engine events", () => {
    const initial = stateFor();
    const help = executeSlashCommand(CARTRIDGE, initial, "/help");
    expect(help).toMatchObject({ kind: "dispatch" });
    if (help.kind !== "dispatch") throw new Error("Expected help events");

    const afterHelp = stateFor(help.events);
    expect(readAgentSlice(afterHelp).responses).toMatchObject([
      { responseId: "help" },
    ]);
    expect(executeSlashCommand(CARTRIDGE, initial, "/HELP")).toMatchObject({
      kind: "dispatch",
    });

    const compact = executeSlashCommand(CARTRIDGE, afterHelp, "/compact");
    expect(compact).toMatchObject({ kind: "dispatch" });
    if (compact.kind !== "dispatch") throw new Error("Expected compact events");

    const afterCompact = stateFor([...help.events, ...compact.events]);
    expect(readMindSlice(afterCompact).compactHistory).toMatchObject([
      { summary: CARTRIDGE.story.compact.summary },
    ]);
    expect(readAgentSlice(afterCompact).responses).toMatchObject([
      { responseId: "help" },
      { responseId: "compact" },
    ]);
  });

  it("returns model selection, metrics, exit, and bounded errors from the same register", () => {
    const initial = stateFor();

    expect(executeSlashCommand(CARTRIDGE, initial, "/model")).toEqual({
      kind: "model-selector",
    });
    expect(executeSlashCommand(CARTRIDGE, initial, "/cost")).toEqual({
      kind: "metrics",
      metrics: deriveEngineMetrics(initial),
    });

    const exit = executeSlashCommand(CARTRIDGE, initial, " /exit ");
    expect(exit).toMatchObject({ kind: "dispatch" });
    if (exit.kind !== "dispatch") throw new Error("Expected exit events");
    expect(readTerminalSlice(stateFor(exit.events)).mode).toBe("bash");

    expect(executeSlashCommand(CARTRIDGE, initial, "/missing")).toEqual({
      kind: "error",
      message: "Unknown command: /missing",
    });
    expect(executeSlashCommand(CARTRIDGE, initial, "/help extra")).toEqual({
      kind: "error",
      message: "Usage: /help",
    });
  });
});
