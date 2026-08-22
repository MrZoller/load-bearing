import { createTerminalModeEvent } from "../../engine/index.js";
import type { EngineEvent } from "../../engine/index.js";

/** Render the Phase 1 agent prompt without inventing the T17 intent parser. */
export function renderTuiView(
  document: Document,
  dispatch: (event: EngineEvent) => void,
): HTMLFormElement {
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
    dispatch(createTerminalModeEvent("bash"));
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.value === "/exit") enterBash();
  });
  input.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      enterBash();
    }
  });
  form.append(label, input);
  return form;
}
