import { createMindPermissionResolvedEvent } from "../../engine/index.js";
import type {
  EngineEvent,
  PendingPermissionRequest,
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
      dispatch(createMindPermissionResolvedEvent(request.id, choice.decision));
    });
    actions.append(button);
  }

  group.append(label, capability, actions);
  return group;
}
