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
  private readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
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
    const cancel = tui.input.dispatch("keydown", new FakeEvent("c", true));
    expect(cancel.defaultPrevented).toBe(true);
    expect(tui.input.value).toBe("");
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
});
