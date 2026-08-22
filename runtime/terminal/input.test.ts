import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import { loadCartridge, reduce } from "../../engine/index.js";
import { createTerminalInputController } from "./input.js";

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;

  constructor(
    readonly key = "",
    readonly ctrlKey = false,
    readonly altKey = false,
    readonly metaKey = false,
    readonly shiftKey = false,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeInput {
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectedDocumentText = "";
  isConnected = true;
  focusCalls = 0;
  readonly ownerDocument = {
    getSelection: () => ({ toString: () => this.selectedDocumentText }),
  };
  private readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  dispatch(type: string, event = new FakeEvent()): FakeEvent {
    this.listeners.get(type)?.(event);
    return event;
  }
}

class FakeForm {
  private readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  submit(): FakeEvent {
    const event = new FakeEvent();
    this.listeners.get("submit")?.(event);
    return event;
  }
}

const CARTRIDGE = loadCartridge(cartridgeDocument);
const STATE = reduce({
  cartridge: CARTRIDGE,
  seed: "2026-08-22/0/structural-audit",
  events: [],
});

function bind(
  controller: ReturnType<typeof createTerminalInputController>,
  mode: "tui" | "bash",
  submit: (value: string) => void,
): { readonly form: FakeForm; readonly input: FakeInput } {
  const form = new FakeForm();
  const input = new FakeInput();
  controller.bind({
    mode,
    form: form as unknown as HTMLFormElement,
    input: input as unknown as HTMLInputElement,
    state: STATE,
    submit,
  });
  return { form, input };
}

describe("createTerminalInputController", () => {
  it("routes arrows through independent histories and restores each draft", () => {
    const controller = createTerminalInputController({
      initialBashHistory: ["pwd"],
      clearTranscript() {},
      enterBash() {},
    });
    const tui = bind(controller, "tui", () => {});
    const bash = bind(controller, "bash", () => {});

    tui.input.value = "inspect it";
    tui.form.submit();
    tui.input.value = "agent draft";
    tui.input.setSelectionRange(11, 11);
    tui.input.dispatch("keydown", new FakeEvent("ArrowUp"));
    expect(tui.input.value).toBe("inspect it");
    tui.input.dispatch("keydown", new FakeEvent("ArrowDown"));
    expect(tui.input.value).toBe("agent draft");

    bash.input.value = "shell draft";
    bash.input.setSelectionRange(11, 11);
    bash.input.dispatch("keydown", new FakeEvent("ArrowUp"));
    expect(bash.input.value).toBe("pwd");
  });

  it("keeps native copy and paste untouched but handles unselected Ctrl+C", () => {
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const tui = bind(controller, "tui", () => {});

    tui.input.value = "selected";
    tui.input.setSelectionRange(0, 8);
    const copy = tui.input.dispatch("keydown", new FakeEvent("c", true));
    expect(copy.defaultPrevented).toBe(false);
    expect(tui.input.value).toBe("selected");
    expect(
      tui.input.dispatch("keydown", new FakeEvent("v", true)).defaultPrevented,
    ).toBe(false);

    tui.input.setSelectionRange(8, 8);
    tui.input.selectedDocumentText = "transcript selection";
    const transcriptCopy = tui.input.dispatch(
      "keydown",
      new FakeEvent("c", true),
    );
    expect(transcriptCopy.defaultPrevented).toBe(false);
    expect(tui.input.value).toBe("selected");

    tui.input.selectedDocumentText = "";
    const cancel = tui.input.dispatch("keydown", new FakeEvent("c", true));
    expect(cancel.defaultPrevented).toBe(true);
    expect(tui.input.value).toBe("");
  });

  it("consumes Tab for Bash completion even when transcript text remains selected", () => {
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const bash = bind(controller, "bash", () => {});

    bash.input.value = "c";
    bash.input.setSelectionRange(1, 1);
    bash.input.selectedDocumentText = "stale transcript selection";
    const completion = bash.input.dispatch("keydown", new FakeEvent("Tab"));

    expect(completion.defaultPrevented).toBe(true);
    expect(bash.input.value).toBe("c");
  });

  it("preserves a draft for clear and nonempty Ctrl+D, entering Bash only from an empty prompt", () => {
    let clears = 0;
    let bashEntries = 0;
    const submissions: string[] = [];
    const controller = createTerminalInputController({
      clearTranscript() {
        clears += 1;
      },
      enterBash() {
        bashEntries += 1;
      },
    });
    const tui = bind(controller, "tui", (value) => submissions.push(value));

    tui.input.value = "draft survives clear";
    tui.input.setSelectionRange(20, 20);
    expect(
      tui.input.dispatch("keydown", new FakeEvent("l", true)).defaultPrevented,
    ).toBe(true);
    expect(tui.input.value).toBe("draft survives clear");
    expect(
      tui.input.dispatch("keydown", new FakeEvent("d", true)).defaultPrevented,
    ).toBe(false);
    expect(tui.input.value).toBe("draft survives clear");
    expect(bashEntries).toBe(0);

    tui.input.value = "";
    tui.input.setSelectionRange(0, 0);
    expect(
      tui.input.dispatch("keydown", new FakeEvent("d", true)).defaultPrevented,
    ).toBe(true);
    tui.input.value = "discard me";
    tui.input.setSelectionRange(10, 10);
    expect(
      tui.input.dispatch("keydown", new FakeEvent("Escape")).defaultPrevented,
    ).toBe(true);

    expect(clears).toBe(1);
    expect(bashEntries).toBe(1);
    expect(tui.input.value).toBe("");
    expect(submissions).toEqual([]);
  });

  it("inserts virtual text at the selection, resets history, and restores prompt focus", () => {
    let refreshes = 0;
    let activity = 0;
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
      onActivity() {
        activity += 1;
      },
    });
    const form = new FakeForm();
    const input = new FakeInput();
    controller.bind({
      mode: "tui",
      form: form as unknown as HTMLFormElement,
      input: input as unknown as HTMLInputElement,
      state: STATE,
      submit() {},
      completionPresentation: {
        isOpen: () => false,
        move() {},
        accept: () => false,
        close: () => false,
        refresh() {
          refreshes += 1;
        },
      },
    });

    input.value = "remember";
    input.setSelectionRange(8, 8);
    form.submit();
    input.value = "abef";
    input.setSelectionRange(2, 2);
    controller.insertText("cd");
    expect(input.value).toBe("abcdef");
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);

    input.setSelectionRange(2, 4);
    controller.insertText("!");
    expect(input.value).toBe("ab!ef");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    controller.pressKey("ArrowUp");
    expect(input.value).toBe("remember");
    expect(refreshes).toBe(2);
    expect(input.focusCalls).toBe(3);
    expect(activity).toBe(4);
  });

  it("routes virtual Tab and history arrows through the hardware completion paths", () => {
    let open = true;
    const moves: number[] = [];
    let accepts = 0;
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const form = new FakeForm();
    const input = new FakeInput();
    controller.bind({
      mode: "tui",
      form: form as unknown as HTMLFormElement,
      input: input as unknown as HTMLInputElement,
      state: STATE,
      submit() {},
      completionPresentation: {
        isOpen: () => open,
        move(direction) {
          moves.push(direction);
        },
        accept() {
          accepts += 1;
          return true;
        },
        close() {
          open = false;
          return true;
        },
        refresh() {},
      },
    });

    controller.pressKey("ArrowDown");
    controller.pressKey("Tab");
    expect(moves).toEqual([1]);
    expect(accepts).toBe(1);

    open = false;
    input.value = "inspect it";
    input.setSelectionRange(10, 10);
    form.submit();
    input.value = "draft";
    input.setSelectionRange(5, 5);
    controller.pressKey("ArrowUp");
    expect(input.value).toBe("inspect it");
    controller.pressKey("ArrowDown");
    expect(input.value).toBe("draft");
  });

  it("returns exact completed input to native Tab traversal after closing the popup", () => {
    let open = true;
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const form = new FakeForm();
    const input = new FakeInput();
    input.value = "/help";
    input.setSelectionRange(5, 5);
    controller.bind({
      mode: "tui",
      form: form as unknown as HTMLFormElement,
      input: input as unknown as HTMLInputElement,
      state: STATE,
      submit() {},
      completionPresentation: {
        isOpen: () => open,
        move() {},
        accept() {
          open = false;
          return true;
        },
        close() {
          const wasOpen = open;
          open = false;
          return wasOpen;
        },
        refresh() {},
      },
    });

    expect(
      input.dispatch("keydown", new FakeEvent("Tab")).defaultPrevented,
    ).toBe(true);
    expect(open).toBe(false);
    expect(
      input.dispatch("keydown", new FakeEvent("Tab")).defaultPrevented,
    ).toBe(false);
  });

  it("moves a virtual caret without replacing selections and ignores cleared or stale bindings", () => {
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const tui = bind(controller, "tui", () => {});

    tui.input.value = "abcdef";
    tui.input.setSelectionRange(1, 4);
    controller.pressKey("ArrowLeft");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([1, 1]);
    tui.input.setSelectionRange(1, 4);
    controller.pressKey("ArrowRight");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([4, 4]);
    controller.pressKey("ArrowRight");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([5, 5]);

    controller.clear();
    controller.insertText("!");
    controller.pressKey("ArrowLeft");
    expect(tui.input.value).toBe("abcdef");
    expect(tui.input.focusCalls).toBe(3);

    const stale = bind(controller, "tui", () => {});
    stale.input.value = "stale";
    stale.input.isConnected = false;
    controller.insertText("/");
    controller.pressKey("ArrowLeft");
    expect(stale.input.value).toBe("stale");
    expect(stale.input.focusCalls).toBe(0);
  });

  it("moves virtual carets across Unicode code points without splitting surrogates", () => {
    const controller = createTerminalInputController({
      clearTranscript() {},
      enterBash() {},
    });
    const tui = bind(controller, "tui", () => {});

    tui.input.value = "🧱a";
    tui.input.setSelectionRange(0, 0);
    controller.pressKey("ArrowRight");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([2, 2]);
    controller.pressKey("ArrowLeft");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([0, 0]);

    tui.input.value = "🧱";
    tui.input.setSelectionRange(1, 1);
    controller.insertText("!");
    expect(tui.input.value).toBe("!🧱");
    expect([tui.input.selectionStart, tui.input.selectionEnd]).toEqual([1, 1]);
  });
});
