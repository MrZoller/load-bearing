import type {
  AgentMessageArtifacts,
  AgentThinkingBlock,
  AgentTodo,
  AgentToolCall,
} from "../../engine/index.js";

function statusText(status: string): string {
  return status.replace("-", " ");
}

function summary(
  document: Document,
  label: string,
  status: string,
): HTMLElement {
  const element = document.createElement("summary");
  element.className = "artifact__summary";
  element.textContent = `${label} — ${statusText(status)}`;
  return element;
}

function detail(
  document: Document,
  className: string,
  text: string,
): HTMLElement {
  const element = document.createElement("pre");
  element.className = className;
  element.textContent = text;
  return element;
}

function renderToolCall(
  document: Document,
  toolCall: AgentToolCall,
): HTMLDetailsElement {
  const element = document.createElement("details");
  element.className = "artifact artifact--tool";
  element.dataset.artifactId = toolCall.id;
  element.append(
    summary(document, `Tool: ${toolCall.title}`, toolCall.status),
    detail(document, "artifact__detail", `Input\n${toolCall.input}`),
  );
  if (toolCall.output !== "")
    element.append(
      detail(document, "artifact__detail", `Output\n${toolCall.output}`),
    );
  return element;
}

function renderThinkingBlock(
  document: Document,
  thinking: AgentThinkingBlock,
): HTMLDetailsElement {
  const element = document.createElement("details");
  element.className = "artifact artifact--thinking";
  element.dataset.artifactId = thinking.id;
  element.append(
    summary(document, "Thinking", thinking.status),
    detail(document, "artifact__detail", thinking.text),
  );
  return element;
}

function renderTodos(
  document: Document,
  todos: readonly AgentTodo[],
): HTMLDetailsElement {
  const element = document.createElement("details");
  element.className = "artifact artifact--todos";
  const count = `${String(todos.length)} ${todos.length === 1 ? "item" : "items"}`;
  element.append(summary(document, "Todos", count));
  const list = document.createElement("ul");
  list.className = "artifact__todos";
  for (const todo of todos) {
    const item = document.createElement("li");
    item.className = "artifact__todo";
    item.dataset.artifactId = todo.id;
    item.textContent = `${todo.text} — ${statusText(todo.status)}`;
    list.append(item);
  }
  element.append(list);
  return element;
}

/** Render replay state as native disclosures; open/focus state remains DOM-only. */
export function renderAgentArtifacts(
  document: Document,
  artifacts: AgentMessageArtifacts,
): HTMLElement | null {
  if (
    artifacts.toolCalls.length === 0 &&
    artifacts.thinkingBlocks.length === 0 &&
    artifacts.todos.length === 0
  )
    return null;
  const region = document.createElement("section");
  region.className = "artifacts";
  region.setAttribute("aria-label", "Agent work details");
  region.append(
    ...artifacts.thinkingBlocks.map((item) =>
      renderThinkingBlock(document, item),
    ),
    ...artifacts.toolCalls.map((item) => renderToolCall(document, item)),
  );
  if (artifacts.todos.length > 0)
    region.append(renderTodos(document, artifacts.todos));
  return region;
}
