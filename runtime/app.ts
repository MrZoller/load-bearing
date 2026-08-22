import {
  createShellExecuteEvent,
  readAgentSlice,
  readTerminalSlice,
} from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";
import { createRuntimeSession } from "./session.js";
import { renderStatus } from "./components/status.js";
import { updateAgentActivity } from "./components/activity.js";
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

  const assignment = document.createElement("p");
  assignment.className = "terminal__assignment";
  assignment.textContent = session.cartridge.meta.assignment;

  const transcript = document.createElement("ol");
  transcript.className = "transcript";
  transcript.setAttribute("aria-label", "Session transcript");

  const view = document.createElement("section");
  view.className = "terminal__view";
  view.setAttribute("aria-label", "Active terminal view");

  const status = document.createElement("div");
  terminal.append(beam, assignment, transcript, view, status);
  mount.replaceChildren(terminal);

  const browser = document.defaultView;
  let activityStartedAt: number | null = null;
  let activityFrame: number | null = null;

  function stopActivityFrame(): void {
    if (browser !== null && activityFrame !== null)
      browser.cancelAnimationFrame(activityFrame);
    activityFrame = null;
  }

  function scheduleActivityFrame(): void {
    stopActivityFrame();
    if (browser === null || activityStartedAt === null) return;
    const snapshot = session.current();
    if (
      readTerminalSlice(snapshot.state).mode !== "tui" ||
      readAgentSlice(snapshot.state).activity.status !== "working"
    )
      return;

    activityFrame = browser.requestAnimationFrame((now) => {
      const element = view.querySelector<HTMLElement>("[data-agent-activity]");
      if (element === null || activityStartedAt === null) return;
      // Wall time interpolates this one presentation node. It never dispatches
      // an event, chooses copy, increments metrics, or rewrites replay state.
      updateAgentActivity(
        element,
        session.current().state,
        now - activityStartedAt,
      );
      scheduleActivityFrame();
    });
  }

  function dispatch(event: EngineEvent): void {
    session.dispatch(event);
    render();
  }

  function dispatchMany(events: readonly EngineEvent[]): void {
    const first = events[0];
    // A visitor turn starts with a replayable working event and ends idle.
    // Paint that boundary once before folding the completed authored turn, so
    // the spinner is a real browser state rather than dead presentation code.
    // The frame only schedules rendering; it never chooses or changes events.
    if (
      first?.type === "agent.activity-set" &&
      first.payload?.["status"] === "working" &&
      events.length > 1 &&
      browser !== null
    ) {
      session.dispatch(first);
      render();
      browser.requestAnimationFrame(() => {
        // RAF callbacks run before their frame paints. A second callback keeps
        // the replayable working state mounted through that paint, then folds
        // the already-authored completion without letting wall time choose it.
        browser.requestAnimationFrame(() => {
          session.dispatchMany(events.slice(1));
          render();
        });
      });
      return;
    }
    session.dispatchMany(events);
    render();
  }

  function render(): void {
    const snapshot = session.current();
    const activity = readAgentSlice(snapshot.state).activity;
    const inTui = readTerminalSlice(snapshot.state).mode === "tui";
    if (inTui && activity.status === "working") {
      activityStartedAt ??= browser?.performance.now() ?? 0;
    } else {
      activityStartedAt = null;
      stopActivityFrame();
    }
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
            activityStartedAt === null || browser === null
              ? 0
              : browser.performance.now() - activityStartedAt,
          );
    view.replaceChildren(activeView);
    status.replaceChildren(
      renderStatus(document, snapshot.state, session.cartridge.meta.number),
    );
    activeView
      .querySelector<HTMLElement>("[data-initial-focus], input")
      ?.focus();
    scheduleActivityFrame();
  }

  render();
}
