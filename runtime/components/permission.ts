import {
  createMindPermissionChoiceEvent,
  createMindWaiverChoiceEvent,
} from "../../engine/index.js";
import type {
  EngineEvent,
  PendingPermissionRequest,
  PendingWaiverRequest,
  PermissionDecision,
} from "../../engine/index.js";

const CHOICES: readonly {
  readonly label: string;
  readonly decision: PermissionDecision;
}[] = [
  { label: "Allow once", decision: "grant" },
  { label: "Deny", decision: "deny" },
  { label: "Always allow", decision: "always-allow" },
];

/** Native buttons retain browser keyboard semantics without a parallel input path. */
export function renderPermission(
  document: Document,
  request: PendingPermissionRequest,
  dispatch: (event: EngineEvent) => void,
): HTMLFieldSetElement {
  const group = document.createElement("fieldset");
  group.className = "permission";

  const label = document.createElement("legend");
  label.className = "permission__label";
  label.textContent = "Permission required";

  const capability = document.createElement("p");
  capability.className = "permission__capability";
  capability.textContent = `Action: ${request.capability.action}\nResource: ${request.capability.resource}`;

  const actions = document.createElement("div");
  actions.className = "permission__actions";
  for (const [index, choice] of CHOICES.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    if (index === 0) button.dataset.initialFocus = "true";
    button.addEventListener("click", () => {
      dispatch(createMindPermissionChoiceEvent(request.id, choice.decision));
    });
    actions.append(button);
  }

  group.append(label, capability, actions);
  return group;
}

/** A waiver is one exact submission: mismatch is deterministic denial, not retry. */
export function renderWaiver(
  document: Document,
  request: PendingWaiverRequest,
  dispatch: (event: EngineEvent) => void,
): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "permission permission--waiver";
  form.setAttribute("aria-label", "Waiver consent required");

  const heading = document.createElement("h2");
  heading.className = "permission__label";
  heading.textContent = "Waiver consent required";

  const capability = document.createElement("p");
  capability.className = "permission__capability";
  capability.textContent = `Action: ${request.capability.action}\nResource: ${request.capability.resource}\nDocument: ${request.documentPath}`;

  const documentText = document.createElement("pre");
  documentText.className = "permission__document";
  documentText.textContent = request.documentContents;

  const label = document.createElement("label");
  label.className = "permission__phrase-label";
  label.htmlFor = "waiver-consent";
  label.textContent = `Type ${request.requiredPhrase} exactly to consent. Any other submitted text denies.`;

  const input = document.createElement("input");
  input.id = "waiver-consent";
  input.name = "waiver-consent";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.initialFocus = "true";

  const actions = document.createElement("div");
  actions.className = "permission__actions";
  const consent = document.createElement("button");
  consent.type = "submit";
  consent.textContent = "Submit consent";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => {
    dispatch(createMindWaiverChoiceEvent(request.id, false));
  });
  actions.append(consent, deny);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    dispatch(
      createMindWaiverChoiceEvent(
        request.id,
        input.value === request.requiredPhrase,
      ),
    );
  });
  form.append(heading, capability, documentText, label, input, actions);
  return form;
}
