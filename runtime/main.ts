import cartridgeDocument from "../content/incidents/phase-1-demo.json";
import { createShellExecuteEvent } from "../engine/index.js";
import type { TranscriptEntry } from "../engine/index.js";
import { createRuntimeSession } from "./session.js";
import "./styles.css";

const mount = document.querySelector<HTMLElement>("#app");
if (mount === null) throw new Error("The runtime mount point is missing.");

const session = createRuntimeSession(cartridgeDocument);
const incidentNumber = String(session.cartridge.meta.number).padStart(3, "0");

const terminal = document.createElement("main");
terminal.className = "terminal";
terminal.setAttribute("aria-label", "Load Bearing terminal");

const beam = document.createElement("div");
beam.className = "beam";
beam.setAttribute("aria-hidden", "true");

const header = document.createElement("header");
header.className = "terminal__header";
const brand = document.createElement("p");
brand.className = "terminal__brand";
brand.textContent = `loadbearing.cc · Incident #${incidentNumber}`;
const status = document.createElement("p");
status.className = "terminal__status";
status.textContent = "SIMULATION ONLINE";
header.append(brand, status);

const assignment = document.createElement("p");
assignment.className = "terminal__assignment";
assignment.textContent = session.cartridge.meta.assignment;

const transcript = document.createElement("ol");
transcript.className = "transcript";
transcript.setAttribute("aria-label", "Session transcript");

const form = document.createElement("form");
form.className = "prompt";
const label = document.createElement("label");
label.className = "prompt__label";
label.htmlFor = "terminal-input";
label.textContent = "❯";
const input = document.createElement("input");
input.id = "terminal-input";
input.name = "command";
input.type = "text";
input.autocomplete = "off";
input.autocapitalize = "off";
input.spellcheck = false;
input.setAttribute("aria-label", "Terminal command");
form.append(label, input);

terminal.append(beam, header, assignment, transcript, form);
mount.append(terminal);

function renderEntry(entry: TranscriptEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "transcript__entry";

  const heading = document.createElement("p");
  heading.className = "transcript__heading";
  heading.textContent = entry.summary === "" ? entry.type : entry.summary;
  item.append(heading);

  for (const line of entry.detail) {
    const detail = document.createElement("pre");
    detail.className = "transcript__detail";
    detail.textContent = line;
    item.append(detail);
  }

  for (const output of entry.output ?? []) {
    const line = document.createElement("pre");
    line.className = `transcript__output transcript__output--${output.stream}`;
    line.textContent = output.text;
    item.append(line);
  }
  return item;
}

function renderTranscript(): void {
  transcript.replaceChildren(
    ...session.current().state.transcript.map(renderEntry),
  );
}

function execute(inputValue: string): void {
  session.dispatch(createShellExecuteEvent(inputValue));
  renderTranscript();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = input.value;
  input.value = "";
  execute(command);
  input.focus();
});

// The walking skeleton starts with one ordinary engine event so its first
// paint proves that the browser is rendering derived transcript state.
execute("pwd");
input.focus();
