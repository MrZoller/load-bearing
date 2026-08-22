import { createShellExecuteEvent, readVfsSlice } from "../../engine/index.js";
import type { EngineEvent, SessionState } from "../../engine/index.js";

/** Render the shell as a thin dispatcher over the shared engine command path. */
export function renderBashView(
  document: Document,
  state: SessionState,
  dispatch: (event: EngineEvent) => void,
): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "prompt prompt--bash";

  const label = document.createElement("label");
  label.className = "prompt__label prompt__label--bash";
  label.htmlFor = "bash-input";
  const vfs = readVfsSlice(state);
  label.textContent = `${vfs.identity.user}@${state.cartridge.repository.system.hostname}:${vfs.cwd}$`;

  const input = document.createElement("input");
  input.id = "bash-input";
  input.name = "command";
  input.type = "text";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Bash command");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatch(createShellExecuteEvent(input.value));
  });
  form.append(label, input);
  return form;
}
