import { readVfs, readVfsSlice } from "../../engine/index.js";
import type { LoadedCartridge, TranscriptEntry } from "../../engine/index.js";
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

function shellInputs(snapshot: RuntimeSessionSnapshot): readonly string[] {
  return snapshot.eventLog.flatMap((event) => {
    if (event.type !== "shell.execute") return [];
    const input = event.payload?.["input"];
    if (typeof input !== "string") {
      throw new Error("A stored shell.execute event has no string input.");
    }
    return [input];
  });
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
  const motd = readVfs(readVfsSlice(snapshot.state), "/etc/motd");
  if (!motd.ok) {
    throw new Error(`The authored login banner is unavailable: ${motd.code}.`);
  }
  item.append(
    paragraph(document, "transcript__login", motd.value.contents.trimEnd()),
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

/** Project visitor shell commands and their replayed results without UI history. */
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

  return [
    renderLogin(document, cartridge, snapshot),
    ...inputs.map((input, index) => {
      const result = results[index];
      if (result === undefined) throw new Error("A shell result is missing.");
      return renderExchange(document, input, result);
    }),
  ];
}
