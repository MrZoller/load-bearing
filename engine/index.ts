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
export type { ReplayInput, ReplayOutput } from "./session.js";

export { EVENT_SCHEMA_VERSION, readSlice } from "./events/state.js";
export type {
  EngineEvent,
  SessionState,
  TranscriptEntry,
} from "./events/state.js";
export { defineEventModule } from "./events/module.js";
export type {
  BootstrapContext,
  EventContext,
  EventHandlerDefinition,
  EventModule,
  EventModuleDefinition,
  EventOutcome,
  RegisteredHandler,
} from "./events/module.js";
export { EventRegistryError, createRegistry } from "./events/registry.js";
export type { EventRegistry } from "./events/registry.js";
export {
  ENGINE_EVENT_MODULES,
  ENGINE_EVENT_REGISTRY,
} from "./events/modules.js";
export {
  EMPTY_EVENT_LOG,
  appendEvent,
  assertEventEnvelope,
} from "./events/log.js";
export {
  EventVersionError,
  UnknownEventTypeError,
  bootstrap,
  reduce,
  restoreSnapshot,
  snapshot,
  step,
} from "./events/reduce.js";
export type { BootstrapInput, ReduceInput } from "./events/reduce.js";
export {
  DETAIL_INDENT,
  renderEntry,
  renderTranscript,
} from "./events/transcript.js";
export { readInteger, readString, requirePayload } from "./events/payload.js";
export type { EventPayload } from "./events/payload.js";
export { CLOCK_MODULE, MAX_TICK_MS } from "./events/core.js";
export { PROBE_MODULE } from "./events/probe.js";
export type { ProbeSlice } from "./events/probe.js";

export { deepFreeze } from "./freeze.js";
export {
  CONTROL_CHARACTER,
  LONE_SURROGATE,
  describeUnwritableText,
} from "./text.js";

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

export { CartridgeValidationError, loadCartridge } from "./cartridge/load.js";
export type { CartridgeIssue } from "./cartridge/load.js";
export {
  ABSOLUTE_PATH_PATTERN,
  ARCHETYPES,
  CARTRIDGE_SCHEMA,
  CARTRIDGE_SCHEMA_VERSION,
} from "./cartridge/schema.js";
export { CARTRIDGE_SCHEMA_ID, emitJsonSchema } from "./cartridge/jsonSchema.js";
export type {
  Archetype,
  CartridgeFile,
  CartridgeMeta,
  CartridgeModel,
  CartridgeRepository,
  DeferredObject,
  LoadedCartridge,
} from "./cartridge/types.js";
