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
  clear(): void;
  insertText(text: string): void;
  pressKey(
    key: "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  ): void;
}

export interface TerminalInputControllerOptions {
  readonly initialBashHistory?: readonly string[];
  readonly clearTranscript: () => void;
  readonly enterBash: () => void;
  /** Browser-only idle scheduling observes interaction without storing it. */
  readonly onActivity?: () => void;
}

function hasInputSelection(input: HTMLInputElement): boolean {
  return (
    input.selectionStart !== null &&
    input.selectionEnd !== null &&
    input.selectionStart !== input.selectionEnd
  );
}

function hasDocumentSelection(input: HTMLInputElement): boolean {
  return (input.ownerDocument?.getSelection()?.toString().length ?? 0) > 0;
}

function replaceInput(
  input: HTMLInputElement,
  value: string,
  cursor = value.length,
): void {
  input.value = value;
  input.setSelectionRange(cursor, cursor);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Keep virtual controls from splitting a supplementary Unicode character. */
function snapToCodePointBoundary(value: string, offset: number): number {
  if (
    offset > 0 &&
    offset < value.length &&
    isHighSurrogate(value.charCodeAt(offset - 1)) &&
    isLowSurrogate(value.charCodeAt(offset))
  ) {
    return offset - 1;
  }
  return offset;
}

function previousCodePointBoundary(value: string, offset: number): number {
  const previous = Math.max(0, offset - 1);
  return snapToCodePointBoundary(value, previous);
}

function nextCodePointBoundary(value: string, offset: number): number {
  if (
    offset + 1 < value.length &&
    isHighSurrogate(value.charCodeAt(offset)) &&
    isLowSurrogate(value.charCodeAt(offset + 1))
  ) {
    return offset + 2;
  }
  return Math.min(value.length, offset + 1);
}

/** Bind both prompts to one controller while their DOM nodes rerender. */
export function createTerminalInputController(
  options: TerminalInputControllerOptions,
): TerminalInputController {
  const history: TerminalHistory = createTerminalHistory(
    options.initialBashHistory,
  );

  let currentBinding: TerminalInputBinding | null = null;

  function activeBinding(): TerminalInputBinding | null {
    if (currentBinding === null || !currentBinding.input.isConnected)
      return null;
    return currentBinding;
  }

  function moveOrComplete(
    binding: TerminalInputBinding,
    key: "Tab" | "ArrowUp" | "ArrowDown",
  ): boolean {
    const { input, mode, completionPresentation } = binding;
    if (
      completionPresentation?.isOpen() === true &&
      (key === "ArrowUp" || key === "ArrowDown")
    ) {
      completionPresentation.move(key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const value =
        key === "ArrowUp"
          ? history.previous(mode, input.value)
          : history.next(mode, input.value);
      replaceInput(input, value);
      // History owns this arrow sequence. Reopening a slash popup for a
      // recalled command would capture ArrowDown and strand the draft.
      completionPresentation?.close();
      return true;
    }
    if (hasInputSelection(input)) return false;
    if (completionPresentation?.isOpen() === true)
      return completionPresentation.accept();
    const cursor = input.selectionStart ?? input.value.length;
    const completion = completeTerminalInput(
      mode,
      input.value,
      cursor,
      binding.state,
    );
    if (completion === null) return false;
    if (completion.value !== input.value) {
      replaceInput(input, completion.value, completion.cursor);
      completionPresentation?.refresh();
    }
    return true;
  }

  return {
    bind(binding) {
      currentBinding = binding;
      const { form, input, mode, completionPresentation } = binding;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        options.onActivity?.();
        const value = input.value;
        history.record(mode, value);
        binding.submit(value);
      });

      input.addEventListener("input", () => {
        options.onActivity?.();
        history.reset(mode);
        completionPresentation?.refresh();
      });

      input.addEventListener("keydown", (event) => {
        options.onActivity?.();
        const key = event.key;
        const control = event.ctrlKey && !event.altKey && !event.metaKey;

        // Cmd/Ctrl copy and all paste variants remain native. Ctrl+C is a
        // terminal cancel only when there is no selected text to copy.
        if (
          control &&
          key.toLowerCase() === "c" &&
          !hasInputSelection(input) &&
          !hasDocumentSelection(input)
        ) {
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
        if (key === "ArrowUp" || key === "ArrowDown") {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
            return;
          if (moveOrComplete(binding, key)) event.preventDefault();
          return;
        }
        // A transcript selection matters to copy, but it must not disable
        // prompt completion after the user returns focus to the input.
        if (key !== "Tab" || event.shiftKey || hasInputSelection(input)) return;
        if (moveOrComplete(binding, "Tab")) event.preventDefault();
      });
    },
    clear() {
      currentBinding = null;
    },
    insertText(text) {
      const binding = activeBinding();
      if (binding === null) return;
      const { input, mode, completionPresentation } = binding;
      const start = snapToCodePointBoundary(
        input.value,
        input.selectionStart ?? input.value.length,
      );
      const end = snapToCodePointBoundary(
        input.value,
        input.selectionEnd ?? start,
      );
      const value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
      replaceInput(input, value, start + text.length);
      history.reset(mode);
      completionPresentation?.refresh();
      options.onActivity?.();
      input.focus();
    },
    pressKey(key) {
      const binding = activeBinding();
      if (binding === null) return;
      const { input } = binding;
      if (key === "ArrowLeft" || key === "ArrowRight") {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const cursor =
          key === "ArrowLeft"
            ? start === end
              ? previousCodePointBoundary(input.value, start)
              : start
            : start === end
              ? nextCodePointBoundary(input.value, end)
              : end;
        input.setSelectionRange(cursor, cursor);
      } else {
        moveOrComplete(binding, key);
      }
      options.onActivity?.();
      input.focus();
    },
  };
}
