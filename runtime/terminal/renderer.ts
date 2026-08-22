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

function capacityResponseId(entry: TranscriptEntry): string {
  const prefix = "capacity response=";
  if (
    !entry.summary.startsWith(prefix) ||
    entry.summary.length === prefix.length
  )
    throw new Error("A stored agent capacity transcript has no response id.");
  return entry.summary.slice(prefix.length);
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

function authoredMessage(
  cartridge: LoadedCartridge,
  responseId: string,
): AgentMessage {
  const response = cartridge.story.responses.find(
    (candidate) => candidate.id === responseId,
  );
  if (response === undefined) {
    throw new Error(
      `A stored agent capacity event names unknown response ${JSON.stringify(responseId)}.`,
    );
  }
  return {
    id: "capacity/message",
    role: "agent",
    text: response.text,
    responseId,
  };
}

/** Project replayed shell and agent state in the order of its durable event log. */
export function renderTerminalTranscript(
  document: Document,
  cartridge: LoadedCartridge,
  snapshot: RuntimeSessionSnapshot,
): readonly HTMLLIElement[] {
  const inputs = shellInputs(snapshot);
  const resultCount = shellResults(snapshot).length;
  if (inputs.length !== resultCount) {
    throw new Error("Shell commands and replayed results are out of step.");
  }

  const messages = readAgentSlice(snapshot.state).messages;
  const entries: HTMLLIElement[] = [renderLogin(document, cartridge, snapshot)];
  let shellIndex = 0;
  let messageCount = 0;

  for (const transcriptEntry of snapshot.state.transcript) {
    if (transcriptEntry.type === "shell.result") {
      const input = inputs[shellIndex];
      if (input === undefined) throw new Error("A shell input is missing.");
      entries.push(renderExchange(document, input, transcriptEntry));
      shellIndex += 1;
      continue;
    }

    if (transcriptEntry.type === "agent.capacity-reached") {
      entries.push(
        renderMessage(
          document,
          authoredMessage(cartridge, capacityResponseId(transcriptEntry)),
        ),
      );
      continue;
    }

    if (
      transcriptEntry.type !== "agent.message-added" &&
      transcriptEntry.type !== "agent.response-recorded"
    )
      continue;
    const message = messages[messageCount];
    if (message === undefined) {
      throw new Error("A replayed agent message is missing.");
    }
    entries.push(renderMessage(document, message));
    messageCount += 1;
  }

  if (shellIndex !== inputs.length)
    throw new Error("Shell commands and replayed results are out of step.");
  if (messageCount !== messages.length) {
    throw new Error("Agent events and replayed messages are out of step.");
  }
  return entries;
}
