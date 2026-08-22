import { createShellExecuteEvent, readTerminalSlice } from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";
import { createRuntimeSession } from "./session.js";
import { renderTerminalTranscript } from "./terminal/renderer.js";
import { renderBashView } from "./views/bash.js";
import { renderTuiView } from "./views/tui.js";

/** Mount one terminal whose visible mode is always projected from engine state. */
export function mountApp(
  document: Document,
  mount: HTMLElement,
  cartridgeDocument: unknown,
): void {
  const session = createRuntimeSession(cartridgeDocument);
  const incidentNumber = String(session.cartridge.meta.number).padStart(3, "0");
  const resumeCommand = `loadbearing --resume incident-${incidentNumber}`;

  // The cold open is an ordinary visitor command. Keeping it in the event log
  // makes the displayed handoff and the resulting TUI mode replay together.
  session.dispatch(createShellExecuteEvent(resumeCommand));

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

  const view = document.createElement("section");
  view.className = "terminal__view";
  view.setAttribute("aria-label", "Active terminal view");

  terminal.append(beam, header, assignment, transcript, view);
  mount.replaceChildren(terminal);

  function dispatch(event: EngineEvent): void {
    session.dispatch(event);
    render();
  }

  function dispatchMany(events: readonly EngineEvent[]): void {
    session.dispatchMany(events);
    render();
  }

  function render(): void {
    const snapshot = session.current();
    transcript.replaceChildren(
      ...renderTerminalTranscript(document, session.cartridge, snapshot),
    );

    const activeView =
      readTerminalSlice(snapshot.state).mode === "bash"
        ? renderBashView(document, snapshot.state, dispatch)
        : renderTuiView(
            document,
            session.cartridge,
            snapshot.state,
            dispatchMany,
          );
    view.replaceChildren(activeView);
    activeView
      .querySelector<HTMLElement>("[data-initial-focus], input")
      ?.focus();
  }

  render();
}
