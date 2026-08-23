import {
  createAgentIdleNudgeEvent,
  createShellExecuteEvent,
  createTerminalModeEvent,
  hasAgentIdleNudged,
  readAgentSlice,
  readMindSlice,
  readTerminalSlice,
  selectAgentPresentation,
} from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";
import { createRuntimeSession } from "./session.js";
import type { RuntimeSession } from "./session.js";
import { renderStatus } from "./components/status.js";
import { updateAgentActivity } from "./components/activity.js";
import { renderMobileKeys } from "./components/mobile-keys.js";
import { renderTerminalTranscript } from "./terminal/renderer.js";
import { createTerminalInputController } from "./terminal/input.js";
import { createTranscriptSearch } from "./terminal/search.js";
import { createTranscriptScroll } from "./terminal/scroll.js";
import { renderBashView } from "./views/bash.js";
import { renderTuiView } from "./views/tui.js";
import { observeVisualViewport } from "./viewport.js";

// This is presentation time only: the authored working/idle events and their
// selected verb are already fixed before the browser schedules this interval.
const ACTIVITY_PRESENTATION_MS = 300;
const PLACEHOLDER_PRESENTATION_MS = 4_000;
const IDLE_NUDGE_MS = 30_000;

/** Mount one terminal whose visible mode is always projected from engine state. */
export function mountApp(
  document: Document,
  mount: HTMLElement,
  cartridgeDocument: unknown,
): Pick<RuntimeSession, "cartridge" | "current"> {
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

  // The visible transcript is replaced from replay state on every render. A
  // separate live region prevents that projection from rereading the full log;
  // only newly keyed agent and shell output is copied here.
  const outputAnnouncements = document.createElement("div");
  outputAnnouncements.className = "visually-hidden";
  outputAnnouncements.setAttribute("role", "status");
  outputAnnouncements.setAttribute("aria-live", "polite");
  outputAnnouncements.setAttribute("aria-atomic", "true");
  outputAnnouncements.setAttribute("aria-label", "New terminal output");

  const view = document.createElement("section");
  view.className = "terminal__view";
  view.setAttribute("aria-label", "Active terminal view");

  const status = document.createElement("div");
  status.className = "terminal__status";
  const focusPrompt = (): void => {
    view.querySelector<HTMLElement>("[data-initial-focus], input")?.focus();
  };
  const transcriptSearch = createTranscriptSearch(
    document,
    transcript,
    focusPrompt,
    () => resetIdleTimer(),
  );
  const transcriptScroll = createTranscriptScroll(
    document,
    transcript,
    focusPrompt,
  );
  const browser = document.defaultView;
  let activityStartedAt: number | null = null;
  let activityFrame: number | null = null;
  let hiddenTranscriptEntries = 0;
  let idleTimer: number | null = null;
  let placeholderTimer: number | null = null;
  let workingTimer: number | null = null;
  let pendingWorkingEvents: readonly EngineEvent[] | null = null;
  const seenTranscriptKeys = new Set<string>();
  let announcementsSeeded = false;
  let placeholderIndex = 0;

  function currentPlaceholders(): readonly string[] {
    return selectAgentPresentation(session.cartridge, session.current().state)
      .placeholders;
  }

  const inputController = createTerminalInputController({
    initialBashHistory: [
      ...session.cartridge.repository.shellHistory,
      resumeCommand,
    ],
    clearTranscript() {
      hiddenTranscriptEntries = renderTerminalTranscript(
        document,
        session.cartridge,
        session.current(),
      ).length;
      // Keep the live prompt and its draft in place. The cutoff is consulted
      // on later renders, while this immediate clear touches presentation only.
      transcriptScroll.clear();
    },
    enterBash() {
      dispatch(createTerminalModeEvent("bash"));
    },
    onActivity() {
      resetIdleTimer();
    },
  });
  const mobileKeys = renderMobileKeys(document, inputController);
  terminal.append(
    beam,
    assignment,
    transcriptSearch.element,
    transcript,
    outputAnnouncements,
    transcriptScroll.newOutputButton,
    view,
    mobileKeys,
    status,
  );
  mount.replaceChildren(terminal);
  observeVisualViewport(document);

  function stopIdleTimer(): void {
    if (browser !== null && idleTimer !== null) browser.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function resetIdleTimer(): void {
    stopIdleTimer();
    const current = session.current();
    if (
      browser === null ||
      selectAgentPresentation(session.cartridge, current.state)
        .idleNudgeResponse === ""
    )
      return;
    if (
      readTerminalSlice(current.state).mode !== "tui" ||
      readAgentSlice(current.state).activity.status !== "idle" ||
      readMindSlice(current.state).pendingPermission !== null ||
      readMindSlice(current.state).pendingWaiver !== null ||
      hasAgentIdleNudged(current.state)
    )
      return;
    idleTimer = browser.setTimeout(() => {
      idleTimer = null;
      const snapshot = session.current();
      const prompt = view.querySelector<HTMLInputElement>("#agent-input");
      if (
        readTerminalSlice(snapshot.state).mode !== "tui" ||
        readAgentSlice(snapshot.state).activity.status !== "idle" ||
        readMindSlice(snapshot.state).pendingPermission !== null ||
        readMindSlice(snapshot.state).pendingWaiver !== null ||
        prompt?.value !== "" ||
        hasAgentIdleNudged(snapshot.state)
      ) {
        if (!hasAgentIdleNudged(snapshot.state)) resetIdleTimer();
        return;
      }
      // Wall time dispatches one explicit authored event. The response choice
      // and one-shot fact both live in replay state, never this callback.
      dispatch(createAgentIdleNudgeEvent());
    }, IDLE_NUDGE_MS);
  }

  function schedulePlaceholder(): void {
    const placeholders = currentPlaceholders();
    if (browser !== null && placeholderTimer !== null)
      browser.clearTimeout(placeholderTimer);
    placeholderTimer = null;
    if (browser === null || placeholders.length < 2) return;
    placeholderTimer = browser.setTimeout(() => {
      const current = currentPlaceholders();
      if (current.length === 0) return;
      placeholderIndex = (placeholderIndex + 1) % current.length;
      const prompt = view.querySelector<HTMLInputElement>("#agent-input");
      if (prompt !== null)
        prompt.placeholder = current[placeholderIndex % current.length] ?? "";
      schedulePlaceholder();
    }, PLACEHOLDER_PRESENTATION_MS);
  }

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

  function finishWorkingPresentation(): void {
    if (pendingWorkingEvents === null) return;
    const events = pendingWorkingEvents;
    pendingWorkingEvents = null;
    if (browser !== null && workingTimer !== null)
      browser.clearTimeout(workingTimer);
    workingTimer = null;
    session.dispatchMany(events);
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
      if (pendingWorkingEvents !== null) return;
      session.dispatch(first);
      pendingWorkingEvents = events.slice(1);
      render();
      // Keep the already-authored working boundary on screen long enough to
      // read its verb and see the spinner move. Wall time decides only when
      // this fixed event sequence is presented, never which events it holds.
      workingTimer = browser.setTimeout(
        finishWorkingPresentation,
        ACTIVITY_PRESENTATION_MS,
      );
      return;
    }
    session.dispatchMany(events);
    render();
  }

  function render(): void {
    const snapshot = session.current();
    const placeholders = currentPlaceholders();
    if (placeholderIndex >= placeholders.length) placeholderIndex = 0;
    const activity = readAgentSlice(snapshot.state).activity;
    const inTui = readTerminalSlice(snapshot.state).mode === "tui";
    if (inTui && activity.status === "working") {
      activityStartedAt ??= browser?.performance.now() ?? 0;
    } else {
      activityStartedAt = null;
      stopActivityFrame();
    }
    const transcriptEntries = renderTerminalTranscript(
      document,
      session.cartridge,
      snapshot,
    );
    const newAnnouncements: string[] = [];
    for (const entry of transcriptEntries) {
      const key = entry.dataset["transcriptKey"];
      if (key === undefined || seenTranscriptKeys.has(key)) continue;
      seenTranscriptKeys.add(key);
      const announcement = entry.dataset["announcement"];
      if (announcementsSeeded && announcement !== undefined)
        newAnnouncements.push(announcement);
    }
    if (newAnnouncements.length > 0) {
      const announcement = document.createElement("p");
      announcement.textContent = newAnnouncements.join("\n");
      outputAnnouncements.replaceChildren(announcement);
    }
    announcementsSeeded = true;
    transcriptScroll.render(transcriptEntries.slice(hiddenTranscriptEntries));
    transcriptSearch.refresh();
    transcriptScroll.afterSearchRefresh();

    inputController.clear();
    const activeView =
      readTerminalSlice(snapshot.state).mode === "bash"
        ? renderBashView(document, snapshot.state, dispatch, inputController)
        : renderTuiView(
            document,
            session.cartridge,
            snapshot.state,
            dispatchMany,
            inputController,
            activityStartedAt === null || browser === null
              ? 0
              : browser.performance.now() - activityStartedAt,
            placeholders[placeholderIndex] ?? "",
          );
    view.replaceChildren(activeView);
    status.replaceChildren(
      renderStatus(document, snapshot.state, session.cartridge.meta.number),
    );
    if (transcriptSearch.element.hidden || !transcriptSearch.hasFocus())
      focusPrompt();
    scheduleActivityFrame();
    schedulePlaceholder();
    resetIdleTimer();
  }

  render();
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || pendingWorkingEvents === null) return;
    event.preventDefault();
    finishWorkingPresentation();
  });
  // The mounted surface may expose this read-only pair to an acceptance
  // harness. Mutation remains private to the closures above: browser tests can
  // replay what happened, but cannot manufacture state outside dispatch.
  return Object.freeze({
    cartridge: session.cartridge,
    current: session.current,
  });
}
