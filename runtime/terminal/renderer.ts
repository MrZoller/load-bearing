import {
  bootstrap,
  readAgentMessageArtifacts,
  readAgentSlice,
  step,
} from "../../engine/index.js";
import type {
  AgentMessage,
  AgentMessageArtifacts,
  EngineEvent,
  LoadedCartridge,
  TranscriptEntry,
} from "../../engine/index.js";
import type { RuntimeSessionSnapshot } from "../session.js";
import { renderAgentArtifacts } from "../components/artifacts.js";

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

/**
 * Associate each shell envelope with the first logged child it expands into.
 * The envelope itself is intentionally absent from the transcript, so replay
 * the durable event log to keep its command ahead of response children.
 */
function shellInputStarts(
  snapshot: RuntimeSessionSnapshot,
): ReadonlyMap<number, string> {
  let state = bootstrap({
    cartridge: snapshot.state.cartridge,
    seed: snapshot.state.seed,
  });
  const starts = new Map<number, string>();
  for (const event of snapshot.eventLog) {
    const before = state.transcript.length;
    state = step(state, event);
    if (event.type === "shell.execute") {
      if (state.transcript.length === before) {
        throw new Error("A shell command produced no replayed result.");
      }
      starts.set(before, eventString(event, "input", "shell.execute"));
    }
  }
  return starts;
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

function renderExchange(document: Document, input: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "transcript__entry transcript__entry--exchange";
  item.append(paragraph(document, "transcript__command", input));
  return item;
}

function renderShellResult(
  document: Document,
  item: HTMLLIElement,
  result: TranscriptEntry,
): void {
  for (const output of result.output ?? []) {
    item.append(
      paragraph(
        document,
        `transcript__output transcript__output--${output.stream}`,
        output.text,
      ),
    );
  }
}

function renderMessage(
  document: Document,
  message: AgentMessage,
  messageArtifacts?: AgentMessageArtifacts,
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
  if (messageArtifacts !== undefined) {
    const artifacts = renderAgentArtifacts(document, messageArtifacts);
    if (artifacts !== null) item.append(artifacts);
  }
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
  const inputStarts = shellInputStarts(snapshot);

  const messages = readAgentSlice(snapshot.state).messages;
  const entries: HTMLLIElement[] = [renderLogin(document, cartridge, snapshot)];
  let activeShell: HTMLLIElement | undefined;
  let messageCount = 0;

  for (const transcriptEntry of snapshot.state.transcript) {
    const input = inputStarts.get(transcriptEntry.index);
    if (input !== undefined) {
      if (activeShell !== undefined) {
        throw new Error("Shell commands and replayed results are out of step.");
      }
      activeShell = renderExchange(document, input);
      entries.push(activeShell);
    }

    if (transcriptEntry.type === "shell.result") {
      if (activeShell === undefined) {
        throw new Error("A shell result has no replayed input.");
      }
      renderShellResult(document, activeShell, transcriptEntry);
      activeShell = undefined;
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
      transcriptEntry.type !== "agent.response-recorded" &&
      transcriptEntry.type !== "agent.idle-nudged"
    )
      continue;
    const message = messages[messageCount];
    if (message === undefined) {
      throw new Error("A replayed agent message is missing.");
    }
    entries.push(
      renderMessage(
        document,
        message,
        readAgentMessageArtifacts(snapshot.state, message.id),
      ),
    );
    messageCount += 1;
  }

  if (activeShell !== undefined)
    throw new Error("Shell commands and replayed results are out of step.");
  if (messageCount !== messages.length) {
    throw new Error("Agent events and replayed messages are out of step.");
  }
  return entries;
}
