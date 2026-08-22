import {
  createAgentInputEvents,
  createShellExecuteEvent,
  createTerminalModeEvent,
  readMindSlice,
} from "../../engine/index.js";
import type {
  EngineEvent,
  LoadedCartridge,
  SessionState,
} from "../../engine/index.js";
import { renderPermission } from "../components/permission.js";
import { renderAgentActivity } from "../components/activity.js";

export function createTuiInputEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
  input: string,
): readonly EngineEvent[] {
  if (input === "/exit") return [createTerminalModeEvent("bash")];
  if (input.startsWith("!")) return [createShellExecuteEvent(input.slice(1))];
  return createAgentInputEvents(cartridge, state, input);
}

/** Render the agent prompt as a thin dispatcher over replayable engine events. */
export function renderTuiView(
  document: Document,
  cartridge: LoadedCartridge,
  state: SessionState,
  dispatch: (events: readonly EngineEvent[]) => void,
  activityElapsedMs = 0,
): HTMLElement {
  const pending = readMindSlice(state).pendingPermission;
  if (pending !== null)
    return renderPermission(document, pending, (event) => dispatch([event]));

  const form = document.createElement("form");
  form.className = "prompt prompt--tui";

  const label = document.createElement("label");
  label.className = "prompt__label";
  label.htmlFor = "agent-input";
  label.textContent = "❯";

  const input = document.createElement("input");
  input.id = "agent-input";
  input.name = "message";
  input.type = "text";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Agent prompt");

  function enterBash(): void {
    dispatch([createTerminalModeEvent("bash")]);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatch(createTuiInputEvents(cartridge, state, input.value));
  });
  input.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      enterBash();
    }
  });
  form.append(label, input);

  const view = document.createElement("div");
  view.className = "tui-view";
  const activity = renderAgentActivity(document, state, activityElapsedMs);
  if (activity !== null) view.append(activity);
  view.append(form);
  return view;
}
