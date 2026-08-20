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
  MAX_TRANSCRIPT_DETAIL_LINES,
  MAX_TRANSCRIPT_LINE_LENGTH,
  renderEntry,
  renderTranscript,
} from "./events/transcript.js";
export { readInteger, readString, requirePayload } from "./events/payload.js";
export type { EventPayload } from "./events/payload.js";
export { CLOCK_MODULE, MAX_TICK_MS } from "./events/core.js";
export { PROBE_MODULE } from "./events/probe.js";
export type { ProbeSlice } from "./events/probe.js";
export { VFS_MODULE, readVfsSlice, validateVfsSlice } from "./vfs/module.js";
export {
  baseName,
  compareVfsNames,
  isDescendant,
  parentPath,
  resolveVfsPath,
} from "./vfs/path.js";
export {
  chmodVfs,
  copyVfs,
  createVfsSlice,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  renameVfs,
  replaceVfsFiles,
  writeVfs,
} from "./vfs/vfs.js";
export type {
  VfsCopyOptions,
  VfsDirectoryEntry,
  VfsEntry,
  VfsErrorCode,
  VfsFailure,
  VfsFileEntry,
  VfsIdentity,
  VfsListItem,
  VfsMutation,
  VfsReadValue,
  VfsResult,
  VfsSlice,
  VfsSuccess,
} from "./vfs/types.js";

export { GIT_MODULE, readGitSlice, validateGitSlice } from "./git/module.js";
export {
  blameGit,
  checkoutGit,
  createGitSlice,
  diffGit,
  logGit,
  stageGit,
  statusGit,
} from "./git/git.js";
export type {
  GitAuthor,
  GitBlameLine,
  GitChange,
  GitCheckoutMutation,
  GitCommit,
  GitDiffComparison,
  GitDiffFile,
  GitDiffLine,
  GitDiffLineKind,
  GitErrorCode,
  GitFailure,
  GitFileSnapshot,
  GitHead,
  GitMutation,
  GitResult,
  GitSlice,
  GitStatusEntry,
  GitSuccess,
} from "./git/types.js";

export {
  WORLD_MODULE,
  readWorldSlice,
  validateWorldSlice,
} from "./world/module.js";
export {
  appendShellHistory,
  appendStreamLog,
  createWorldSlice,
  listEnv,
  listProcesses,
  listServices,
  listTickets,
  lookupEnv,
  lookupLog,
  lookupManPage,
  lookupProcess,
  lookupProcessByPid,
  lookupService,
  lookupTicket,
  readShellHistory,
  readWorldLog,
  restartService,
  setWorldEnv,
  transitionProcess,
  transitionService,
  unsetWorldEnv,
} from "./world/world.js";
export type {
  LogReadResult,
  ProcessFilter,
  ServiceFilter,
  TicketFilter,
  WorldLog,
  WorldManPage,
  WorldProcess,
  WorldService,
  WorldSlice,
  WorldTicket,
} from "./world/types.js";

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
  GIT_BRANCH_PATTERN,
  GIT_COMMIT_ID_PATTERN,
  WORLD_ID_PATTERN,
} from "./cartridge/schema.js";
export { CARTRIDGE_SCHEMA_ID, emitJsonSchema } from "./cartridge/jsonSchema.js";
export type {
  Archetype,
  CartridgeDirectory,
  CartridgeFile,
  CartridgeIdentity,
  CartridgeGitAuthor,
  CartridgeGitCommit,
  CartridgeGitFile,
  CartridgeGitHead,
  CartridgeGitHistory,
  CartridgeMeta,
  CartridgeModel,
  CartridgeRepository,
  CartridgeLog,
  CartridgeManPage,
  CartridgeProcess,
  CartridgeService,
  CartridgeTicket,
  DeferredObject,
  LoadedCartridge,
  ServiceHealth,
  WorldUnitState,
} from "./cartridge/types.js";
