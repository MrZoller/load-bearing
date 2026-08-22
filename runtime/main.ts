import incident001 from "../content/incidents/incident-001.json";
import phaseOneDemo from "../content/incidents/phase-1-demo.json";
import { renderTranscript, serialize } from "../engine/index.js";
import type { EngineEvent } from "../engine/index.js";
import { mountApp } from "./app.js";
import "./styles.css";

declare global {
  interface Window {
    __LOAD_BEARING_ACCEPTANCE__?: () => {
      readonly events: readonly EngineEvent[];
      readonly seed: string;
      readonly state: string;
      readonly transcript: string;
    };
  }
}

const mount = document.querySelector<HTMLElement>("#app");
if (mount === null) throw new Error("The runtime mount point is missing.");

const searchParams = new URL(window.location.href).searchParams;
// This bounded legacy scenario keeps Phase 1 browser coverage without exposing
// arbitrary content selection or changing the production Incident #001 path.
const cartridgeDocument =
  searchParams.get("scenario") === "phase-1-demo" ? phaseOneDemo : incident001;
const app = mountApp(document, mount, cartridgeDocument);

// This opt-in probe exposes canonical, read-only evidence to the production-
// bundle acceptance test. It offers no dispatch path and is absent from normal
// visits, so the runtime still owns the sole mutable event-log reference.
if (searchParams.get("acceptance") === "1") {
  window.__LOAD_BEARING_ACCEPTANCE__ = () => {
    const snapshot = app.current();
    const lines = renderTranscript(snapshot.state.transcript);
    return Object.freeze({
      events: snapshot.eventLog,
      seed: snapshot.state.seed,
      state: serialize(snapshot.state),
      transcript: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    });
  };
}
