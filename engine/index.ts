/**
 * Load Bearing simulation engine.
 *
 * Headless by requirement: pure TypeScript, zero DOM dependencies, runnable
 * in Node and the browser. The Phase 5 playtester agents drive this same
 * module in CI, so anything that needs a document object belongs in
 * /runtime instead. See docs/ARCHITECTURE.md.
 *
 * `npm run gate:purity` machine-checks that requirement rather than trusting
 * review to catch it; see engine/testing/README.md.
 */

export { ENGINE_VERSION } from "./version.js";
export { replaySession } from "./session.js";
export type {
  EngineEvent,
  ReplayInput,
  ReplayOutput,
  SessionState,
} from "./session.js";
export {
  CanonicalSerializeError,
  deserialize,
  serialize,
  serializeInline,
} from "./serialize/canonical.js";
