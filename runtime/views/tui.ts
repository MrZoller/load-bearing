import {
  canRecordAuthoredResponses,
  createAgentCapacityEvent,
  createAgentInputEvents,
  createAgentResponseEvent,
  createMindWaiverChoiceEvent,
  createShellExecuteEvent,
  createTerminalModelTransitionEvent,
  readAgentSlice,
  readMindSlice,
  readTerminalSlice,
  routeModelHandoff,
} from "../../engine/index.js";
import type {
  EngineEvent,
  LoadedCartridge,
  SessionState,
} from "../../engine/index.js";
import { renderPermission, renderWaiver } from "../components/permission.js";
import { renderAgentActivity } from "../components/activity.js";
import { currencyFromMicros, groupedInteger } from "../components/status.js";
import {
  discoverSlashCommands,
  executeSlashCommand,
} from "../commands/slash.js";
import type { SlashCommandDefinition } from "../commands/slash.js";
import type { TerminalInputController } from "../terminal/input.js";

export function createTuiInputEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
  input: string,
): readonly EngineEvent[] {
  const pendingWaiver = readMindSlice(state).pendingWaiver;
  if (pendingWaiver !== null)
    return [
      createMindWaiverChoiceEvent(
        pendingWaiver.id,
        input === pendingWaiver.requiredPhrase,
      ),
    ];
  if (input.trim().startsWith("/")) {
    const result = executeSlashCommand(cartridge, state, input);
    return result.kind === "dispatch" ? result.events : [];
  }
  if (input.startsWith("!")) return [createShellExecuteEvent(input.slice(1))];
  return createAgentInputEvents(cartridge, state, input);
}

export function createModelHandoffEvents(
  cartridge: LoadedCartridge,
  state: SessionState,
  successor: string,
): readonly EngineEvent[] {
  const selection = routeModelHandoff(cartridge, state, successor);
  if (selection.predecessor === selection.successor) return [];
  const instance = `handoff-${String(state.eventCount)}`;
  const responseIds = [
    selection.responseId,
    selection.additionResponseId,
  ].filter((responseId) => responseId !== "");
  return [
    createTerminalModelTransitionEvent(
      selection.predecessor,
      selection.successor,
    ),
    ...(!canRecordAuthoredResponses(cartridge, state, responseIds)
      ? [createAgentCapacityEvent(cartridge.story.fallback.response)]
      : selection.responseId === ""
        ? []
        : [
            createAgentResponseEvent(selection.responseId, `${instance}-pair`),
            ...(selection.additionResponseId === ""
              ? []
              : [
                  createAgentResponseEvent(
                    selection.additionResponseId,
                    `${instance}-incident`,
                  ),
                ]),
          ]),
  ];
}

/** Render the agent prompt as a thin dispatcher over replayable engine events. */
export function renderTuiView(
  document: Document,
  cartridge: LoadedCartridge,
  state: SessionState,
  dispatch: (events: readonly EngineEvent[]) => void,
  inputController: TerminalInputController,
  activityElapsedMs = 0,
  placeholder = "",
): HTMLElement {
  const mind = readMindSlice(state);
  if (mind.pendingWaiver !== null)
    return renderWaiver(document, mind.pendingWaiver, (event) =>
      dispatch([event]),
    );
  const pending = mind.pendingPermission;
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
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Agent prompt");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "slash-completions");
  input.setAttribute("aria-expanded", "false");
  input.placeholder = placeholder;
  input.disabled = readAgentSlice(state).activity.status === "working";

  const presentation = document.createElement("div");
  presentation.className = "tui-presentation";
  const completions = document.createElement("ul");
  completions.id = "slash-completions";
  completions.className = "slash-completions";
  completions.setAttribute("role", "listbox");
  completions.setAttribute("aria-label", "Slash commands");
  completions.hidden = true;
  let matches: readonly SlashCommandDefinition[] = [];
  let activeCompletion = 0;

  function closeCompletions(): boolean {
    const wasOpen = !completions.hidden;
    completions.replaceChildren();
    completions.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    matches = [];
    activeCompletion = 0;
    return wasOpen;
  }

  function closeAuxiliaryPresentation(): boolean {
    const wasOpen = presentation.hasChildNodes();
    presentation.replaceChildren();
    return wasOpen;
  }

  function closePresentation(): void {
    closeCompletions();
    closeAuxiliaryPresentation();
  }

  function renderCompletions(): void {
    matches = discoverSlashCommands(cartridge, input.value.trim());
    activeCompletion = Math.min(
      activeCompletion,
      Math.max(0, matches.length - 1),
    );
    completions.replaceChildren(
      ...matches.map((command, index) => {
        const option = document.createElement("li");
        option.id = `slash-command-${String(index)}`;
        option.className = "slash-completions__option";
        option.setAttribute("role", "option");
        option.setAttribute(
          "aria-selected",
          String(index === activeCompletion),
        );
        const name = document.createElement("strong");
        name.textContent = command.name;
        const description = document.createElement("span");
        description.textContent = command.description;
        option.append(name, description);
        return option;
      }),
    );
    completions.hidden = matches.length === 0;
    input.setAttribute("aria-expanded", String(matches.length > 0));
    if (matches.length > 0) {
      input.setAttribute(
        "aria-activedescendant",
        `slash-command-${String(activeCompletion)}`,
      );
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function showMessage(label: string, value: string): void {
    closePresentation();
    const report = document.createElement("p");
    report.className = "command-report";
    report.setAttribute("role", "status");
    report.setAttribute("aria-label", label);
    report.textContent = value;
    presentation.append(report);
    input.value = "";
    input.focus();
  }

  function showModelSelector(): void {
    closePresentation();
    const fieldset = document.createElement("fieldset");
    fieldset.className = "model-selector";
    const legend = document.createElement("legend");
    legend.textContent = "Choose active model";
    fieldset.append(legend);
    for (const model of cartridge.models) {
      const label = document.createElement("label");
      label.className = "model-selector__option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "active-model";
      radio.value = model.id;
      radio.checked = readTerminalSlice(state).activeModel === model.id;
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = model.name;
      const description = document.createElement("span");
      description.textContent = model.description;
      copy.append(name, description);
      radio.addEventListener("change", () => {
        if (radio.checked)
          dispatch(createModelHandoffEvents(cartridge, state, model.id));
      });
      radio.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePresentation();
          input.value = "";
          input.focus();
        }
      });
      label.append(radio, copy);
      fieldset.append(label);
    }
    presentation.append(fieldset);
    fieldset.querySelector<HTMLInputElement>("input:checked, input")?.focus();
  }

  inputController.bind({
    mode: "tui",
    form,
    input,
    state,
    submit(value) {
      if (value.trim().startsWith("/")) {
        const result = executeSlashCommand(cartridge, state, value);
        if (result.kind === "dispatch") {
          dispatch(result.events);
        } else if (result.kind === "model-selector") {
          showModelSelector();
        } else if (result.kind === "metrics") {
          showMessage(
            "Session cost",
            [
              `model ${result.metrics.modelName}`,
              `tokens ${groupedInteger(result.metrics.tokenCount)}`,
              `cost ${currencyFromMicros(result.metrics.costMicros)}`,
              `context ${String(result.metrics.contextPercent)}%`,
            ].join(" · "),
          );
        } else {
          showMessage("Command error", result.message);
        }
        return;
      }
      dispatch(createTuiInputEvents(cartridge, state, value));
    },
    completionPresentation: {
      isOpen: () => !completions.hidden,
      move(direction) {
        if (matches.length === 0) return;
        activeCompletion =
          (activeCompletion + direction + matches.length) % matches.length;
        renderCompletions();
      },
      accept() {
        const command = matches[activeCompletion];
        if (command === undefined) return false;
        input.value = command.name;
        input.setSelectionRange(input.value.length, input.value.length);
        closeCompletions();
        return true;
      },
      close: closeCompletions,
      refresh() {
        activeCompletion = 0;
        renderCompletions();
      },
    },
    closePresentation: closeAuxiliaryPresentation,
  });
  form.append(label, input);

  const view = document.createElement("div");
  view.className = "tui-view";
  const activity = renderAgentActivity(document, state, activityElapsedMs);
  if (activity !== null) view.append(activity);
  view.append(form, completions, presentation);
  return view;
}
