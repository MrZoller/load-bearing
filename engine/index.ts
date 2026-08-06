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
export { DEFAULT_SESSION_START_MS, replaySession } from "./session.js";
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

export {
  FNV_OFFSET_BASIS_32,
  FNV_PRIME_32,
  SEED_FIELD_SEPARATOR,
  UINT32_RANGE,
  formatSeed,
  hashString,
} from "./random/seed.js";
export type { SeedMaterial } from "./random/seed.js";
export {
  MAX_INT_RANGE,
  PATH_SEPARATOR,
  ROOT_LABEL,
  createRandom,
  restoreRandom,
} from "./random/stream.js";
export type {
  RandomState,
  RandomStream,
  WeightedEntry,
} from "./random/stream.js";

export {
  MAX_EPOCH_MS,
  MIN_EPOCH_MS,
  MONTH_NAMES,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  WEEKDAY_NAMES,
  civilFromEpochMs,
  daysInMonth,
  epochMsFromCivil,
  formatTimestamp,
  isLeapYear,
  parseTimestamp,
} from "./clock/civil.js";
export type { CivilInput, CivilTime } from "./clock/civil.js";
export { createClock, restoreClock } from "./clock/clock.js";
export type { ClockState, SimulatedClock } from "./clock/clock.js";
