import { readAgentSlice } from "../../engine/index.js";
import type {
  AgentMessage,
  EngineEvent,
  LoadedCartridge,
  TranscriptEntry,
} from "../../engine/index.js";
import type { RuntimeSessionSnapshot } from "../session.js";

function paragraph(
  document: Document,
  className: string,
  text: string,
): HTMLParagraphElement {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  return line;
}

function eventString(event: EngineEvent, field: string, label: string): string {
  const value = event.payload?.[field];
  if (typeof value !== "string") {
    throw new Error(`A stored ${label} event has no string ${field}.`);
  }
  return value;
}

function shellInputs(snapshot: RuntimeSessionSnapshot): readonly string[] {
  return snapshot.eventLog.flatMap((event) =>
    event.type === "shell.execute"
      ? [eventString(event, "input", "shell.execute")]
      : [],
  );
}

function shellResults(
  snapshot: RuntimeSessionSnapshot,
): readonly TranscriptEntry[] {
  return snapshot.state.transcript.filter(
    (entry) => entry.type === "shell.result",
  );
}

function renderLogin(
  document: Document,
  cartridge: LoadedCartridge,
  snapshot: RuntimeSessionSnapshot,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "transcript__entry transcript__entry--login";
  item.append(
    ...cartridge.story.opening.login.map((line) =>
      paragraph(document, "transcript__login", line),
    ),
    paragraph(
      document,
      "transcript__prompt",
      `${cartridge.repository.identity.user}@${cartridge.repository.system.hostname}:${cartridge.repository.cwd}$`,
    ),
  );
  return item;
}

function renderExchange(
  document: Document,
  input: string,
  result: TranscriptEntry,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "transcript__entry transcript__entry--exchange";
  item.append(paragraph(document, "transcript__command", input));
  for (const output of result.output ?? []) {
    item.append(
      paragraph(
        document,
        `transcript__output transcript__output--${output.stream}`,
        output.text,
      ),
    );
  }
  return item;
}

function renderMessage(
  document: Document,
  message: AgentMessage,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `transcript__entry transcript__entry--${message.role}`;
  item.append(
    paragraph(
      document,
      `transcript__message transcript__message--${message.role}`,
      message.text,
    ),
  );
  return item;
}

/** Project replayed shell and agent state in the order of its durable event log. */
export function renderTerminalTranscript(
  document: Document,
  cartridge: LoadedCartridge,
  snapshot: RuntimeSessionSnapshot,
): readonly HTMLLIElement[] {
  const inputs = shellInputs(snapshot);
  const results = shellResults(snapshot);
  if (inputs.length !== results.length) {
    throw new Error("Shell commands and replayed results are out of step.");
  }

  const messages = readAgentSlice(snapshot.state).messages;
  const entries: HTMLLIElement[] = [renderLogin(document, cartridge, snapshot)];
  let shellIndex = 0;
  let messageCount = 0;

  for (const event of snapshot.eventLog) {
    if (event.type === "shell.execute") {
      const input = inputs[shellIndex];
      const result = results[shellIndex];
      if (input === undefined) throw new Error("A shell input is missing.");
      if (result === undefined) throw new Error("A shell result is missing.");
      entries.push(renderExchange(document, input, result));
      shellIndex += 1;
      continue;
    }

    const messageId =
      event.type === "agent.message-added"
        ? eventString(event, "id", "agent.message-added")
        : event.type === "agent.response-recorded"
          ? `${eventString(event, "instanceId", "agent.response-recorded")}/message`
          : null;
    if (messageId === null) continue;

    const message = messages.find((candidate) => candidate.id === messageId);
    if (message === undefined) {
      throw new Error(
        `Replayed agent message ${JSON.stringify(messageId)} is missing.`,
      );
    }
    entries.push(renderMessage(document, message));
    messageCount += 1;
  }

  if (messageCount !== messages.length) {
    throw new Error("Agent events and replayed messages are out of step.");
  }
  return entries;
}
