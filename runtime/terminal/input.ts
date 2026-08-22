import type { SessionState } from "../../engine/index.js";
import { completeTerminalInput } from "./completion.js";
import { createTerminalHistory } from "./history.js";
import type { TerminalHistory, TerminalInputMode } from "./history.js";

export interface CompletionPresentation {
  isOpen(): boolean;
  move(direction: -1 | 1): void;
  accept(): boolean;
  close(): boolean;
  refresh(): void;
}

export interface TerminalInputBinding {
  readonly mode: TerminalInputMode;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly state: SessionState;
  readonly submit: (value: string) => void;
  readonly completionPresentation?: CompletionPresentation;
  readonly closePresentation?: () => boolean;
}

export interface TerminalInputController {
  bind(binding: TerminalInputBinding): void;
}

export interface TerminalInputControllerOptions {
  readonly initialBashHistory?: readonly string[];
  readonly clearTranscript: () => void;
  readonly enterBash: () => void;
}

function hasSelection(input: HTMLInputElement): boolean {
  return (
    input.selectionStart !== null &&
    input.selectionEnd !== null &&
    input.selectionStart !== input.selectionEnd
  );
}

function replaceInput(
  input: HTMLInputElement,
  value: string,
  cursor = value.length,
): void {
  input.value = value;
  input.setSelectionRange(cursor, cursor);
}

/** Bind both prompts to one controller while their DOM nodes rerender. */
export function createTerminalInputController(
  options: TerminalInputControllerOptions,
): TerminalInputController {
  const history: TerminalHistory = createTerminalHistory(
    options.initialBashHistory,
  );

  return {
    bind(binding) {
      const { form, input, mode, completionPresentation } = binding;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value;
        history.record(mode, value);
        binding.submit(value);
      });

      input.addEventListener("input", () => {
        history.reset(mode);
        completionPresentation?.refresh();
      });

      input.addEventListener("keydown", (event) => {
        const key = event.key;
        const control = event.ctrlKey && !event.altKey && !event.metaKey;

        // Cmd/Ctrl copy and all paste variants remain native. Ctrl+C is a
        // terminal cancel only when there is no selected text to copy.
        if (control && key.toLowerCase() === "c" && !hasSelection(input)) {
          event.preventDefault();
          replaceInput(input, "");
          completionPresentation?.close();
          binding.closePresentation?.();
          history.reset(mode);
          return;
        }
        if (control && key.toLowerCase() === "l") {
          event.preventDefault();
          options.clearTranscript();
          return;
        }
        if (control && key.toLowerCase() === "d") {
          if (mode === "tui" && input.value === "") {
            event.preventDefault();
            options.enterBash();
          }
          return;
        }
        if (key === "Escape") {
          const closedCompletion = completionPresentation?.close() ?? false;
          const closedPresentation = binding.closePresentation?.() ?? false;
          if (closedCompletion || closedPresentation || input.value !== "") {
            event.preventDefault();
            replaceInput(input, "");
            history.reset(mode);
          }
          return;
        }
        if (
          completionPresentation?.isOpen() === true &&
          (key === "ArrowUp" || key === "ArrowDown")
        ) {
          event.preventDefault();
          completionPresentation.move(key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (key === "ArrowUp" || key === "ArrowDown") {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          event.preventDefault();
          const value =
            key === "ArrowUp"
              ? history.previous(mode, input.value)
              : history.next(mode, input.value);
          replaceInput(input, value);
          // History owns this arrow sequence. Reopening a slash popup for a
          // recalled command would capture ArrowDown and strand the draft.
          completionPresentation?.close();
          return;
        }
        if (key !== "Tab" || event.shiftKey || hasSelection(input)) return;
        if (completionPresentation?.isOpen() === true) {
          if (completionPresentation.accept()) event.preventDefault();
          return;
        }
        const cursor = input.selectionStart ?? input.value.length;
        const completion = completeTerminalInput(
          mode,
          input.value,
          cursor,
          binding.state,
        );
        if (completion === null || completion.value === input.value) return;
        event.preventDefault();
        replaceInput(input, completion.value, completion.cursor);
        completionPresentation?.refresh();
      });
    },
  };
}
