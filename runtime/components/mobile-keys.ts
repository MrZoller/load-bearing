import type { TerminalInputController } from "../terminal/input.js";

interface MobileKey {
  readonly label: string;
  readonly accessibleName: string;
  readonly action: () => void;
}

/** Render touch-sized aliases for operations owned by the input controller. */
export function renderMobileKeys(
  document: Document,
  inputController: TerminalInputController,
): HTMLElement {
  const strip = document.createElement("nav");
  strip.className = "mobile-keys";
  strip.setAttribute("aria-label", "Terminal keys");

  const keys: readonly MobileKey[] = [
    {
      label: "/",
      accessibleName: "Insert slash",
      action: () => inputController.insertText("/"),
    },
    {
      label: "!",
      accessibleName: "Insert exclamation mark",
      action: () => inputController.insertText("!"),
    },
    {
      label: "Tab",
      accessibleName: "Tab completion",
      action: () => inputController.pressKey("Tab"),
    },
    {
      label: "←",
      accessibleName: "Left arrow",
      action: () => inputController.pressKey("ArrowLeft"),
    },
    {
      label: "↑",
      accessibleName: "Up arrow",
      action: () => inputController.pressKey("ArrowUp"),
    },
    {
      label: "↓",
      accessibleName: "Down arrow",
      action: () => inputController.pressKey("ArrowDown"),
    },
    {
      label: "→",
      accessibleName: "Right arrow",
      action: () => inputController.pressKey("ArrowRight"),
    },
  ];

  for (const key of keys) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = key.label;
    button.setAttribute("aria-label", key.accessibleName);
    // Pointer activation must preserve the prompt selection that insertion and
    // completion operate on. Keyboard activation still follows native focus.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", key.action);
    strip.append(button);
  }
  return strip;
}
