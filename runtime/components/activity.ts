import { deriveEngineMetrics, readAgentSlice } from "../../engine/index.js";
import type { SessionState } from "../../engine/index.js";
import { groupedInteger } from "./status.js";

function elapsedSeconds(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / 1_000);
}

/**
 * Project replay state plus wall-time interpolation into text only. Frame
 * cadence can change the timer spelling, but never the selected verb or state.
 */
export function formatAgentActivity(
  state: SessionState,
  elapsedMs: number,
): string | null {
  const activity = readAgentSlice(state).activity;
  if (activity.status === "idle") return null;
  const tokens = deriveEngineMetrics(state).tokenCount;
  const suffix = activity.suffix
    .split("{seconds}")
    .join(String(elapsedSeconds(elapsedMs)))
    .split("{tokens}")
    .join(groupedInteger(tokens));
  return `${activity.verb}… ${suffix}`;
}

export function updateAgentActivity(
  element: HTMLElement,
  state: SessionState,
  elapsedMs: number,
): void {
  const text = formatAgentActivity(state, elapsedMs);
  if (text === null)
    throw new Error("Cannot update an activity element from idle agent state.");
  element.textContent = text;
}

export function renderAgentActivity(
  document: Document,
  state: SessionState,
  elapsedMs: number,
): HTMLElement | null {
  const text = formatAgentActivity(state, elapsedMs);
  if (text === null) return null;
  const element = document.createElement("p");
  element.className = "agent-activity";
  element.dataset.agentActivity = "true";
  element.setAttribute("aria-label", "Agent activity");
  element.textContent = text;
  return element;
}
