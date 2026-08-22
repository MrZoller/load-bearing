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
  TranscriptOutput,
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
  chdirVfs,
  copyVfs,
  createVfsSlice,
  deleteVfs,
  listVfs,
  mkdirVfs,
  readVfs,
  queryVfsTruth,
  renameVfs,
  replaceVfsFiles,
  statVfs,
  touchVfs,
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
  VfsStatValue,
  VfsSuccess,
  VfsTruth,
} from "./vfs/types.js";

export { GIT_MODULE, readGitSlice, validateGitSlice } from "./git/module.js";
export {
  blameGit,
  abbreviateGitHash,
  branchGit,
  checkoutGit,
  commitGit,
  createGitSlice,
  currentGitHash,
  currentGitHead,
  diffGit,
  gitAddCwdPaths,
  logGit,
  resolveGitRef,
  restoreGit,
  showGit,
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
  GitRestoreMutation,
  GitResult,
  GitShowValue,
  GitSlice,
  GitStatusEntry,
  GitSuccess,
  GitVfsPlan,
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
  transitionServiceHealth,
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

export { ShellSyntaxError, tokenizeShell } from "./commands/tokenize.js";
export { CommandOptionError, parseCommandOptions } from "./commands/options.js";
export {
  CommandRegistryError,
  createCommandRegistry,
  executeCommand,
} from "./commands/registry.js";
export {
  BUILTIN_COMMANDS,
  BUILTIN_COMMAND_REGISTRY,
} from "./commands/builtins.js";
export { GIT_COMMANDS } from "./commands/git.js";
export { SYSTEM_COMMANDS } from "./commands/system.js";
export {
  createShellExecuteEvent,
  executeShell,
  MAX_SHELL_INPUT_LENGTH,
} from "./commands/shell.js";
export { SHELL_MODULE } from "./commands/module.js";
export type {
  CommandContext,
  CommandDefinition,
  CommandExecution,
  CommandOptionSpec,
  CommandRegistry,
  CommandResult,
  ParsedCommandOptions,
  RegisteredCommand,
} from "./commands/types.js";

export { NPM_COMMAND } from "./tests/command.js";
export {
  TESTS_MODULE,
  readTestsSlice,
  validateTestsSlice,
} from "./tests/module.js";
export { evaluateFilePredicate, planTestRun } from "./tests/planner.js";
export type {
  TestCaseResult,
  TestRun,
  TestRunPlan,
  TestsSlice,
} from "./tests/types.js";
export { reactionActionEvent, reactionPredicateMatches } from "./reactions.js";

export { MIND_MODULE } from "./mind/module.js";
export {
  beliefDivergence,
  compactBeliefs,
  createMindSlice,
  hasStandingPermission,
  readMindSlice,
  recordPermissionDecision,
  setBelief,
  validateBelief,
  validateCapability,
  validateMindSlice,
} from "./mind/mind.js";
export type {
  Belief,
  BeliefMismatch,
  CompactSummary,
  ExactCapability,
  FileContentsBelief,
  FileExistsBelief,
  GitHeadBelief,
  MindSlice,
  PermissionDecision,
  PermissionLedgerEntry,
  ServiceHealthBelief,
  ServiceStateBelief,
} from "./mind/types.js";

export {
  TERMINAL_MODULE,
  createTerminalModeEvent,
  createTerminalModelEvent,
} from "./terminal/module.js";
export {
  createTerminalSlice,
  forkModelStream,
  isTerminalMode,
  readTerminalSlice,
  setActiveModel,
  setTerminalMode,
  validateTerminalSlice,
} from "./terminal/terminal.js";
export type { TerminalMode, TerminalSlice } from "./terminal/types.js";
export { TERMINAL_COMMANDS } from "./commands/terminal.js";

export {
  AGENT_MODULE,
  createAgentActivityEvent,
  createAgentCapacityEvent,
  createAgentMessageEvent,
  createAgentResponseEvent,
  createAgentThinkingAddedEvent,
  createAgentThinkingUpdatedEvent,
  createAgentTodoAddedEvent,
  createAgentTodoUpdatedEvent,
  createAgentToolCallAddedEvent,
  createAgentToolCallUpdatedEvent,
} from "./agent/module.js";
export {
  MAX_AGENT_ACTIVITY_VERB_LENGTH,
  MAX_AGENT_ID_LENGTH,
  MAX_AGENT_MESSAGES,
  MAX_AGENT_RESPONSES,
  MAX_AGENT_TEXT_LENGTH,
  MAX_AGENT_THINKING_BLOCKS,
  MAX_AGENT_TITLE_LENGTH,
  MAX_AGENT_TODOS,
  MAX_AGENT_TOOL_CALLS,
  addAgentMessage,
  addAgentThinkingBlock,
  addAgentTodo,
  addAgentToolCall,
  createAgentSlice,
  readAgentSlice,
  recordAuthoredResponse,
  setAgentActivity,
  updateAgentThinkingBlock,
  updateAgentTodo,
  updateAgentToolCall,
  validateAgentActivity,
  validateAgentId,
  validateAgentSlice,
  validateAgentThinkingBlock,
  validateAgentTodo,
  validateAgentToolCall,
} from "./agent/agent.js";
export type {
  AgentActivity,
  AgentMessage,
  AgentMessageRole,
  AgentSlice,
  AgentThinkingBlock,
  AgentTodo,
  AgentToolCall,
  AuthoredResponseRecord,
  ThinkingBlockStatus,
  TodoStatus,
  ToolCallStatus,
} from "./agent/types.js";
export {
  boundAgentInput,
  createAgentInputEvents,
  normalizeAgentInput,
  selectAgentIntent,
} from "./agent/intent.js";
export type { AgentIntentSelection } from "./agent/intent.js";

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
  MODEL_ID_PATTERN,
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
  COMMAND_NAME_PATTERN,
  ENDPOINT_URL_PATTERN,
  GIT_BRANCH_PATTERN,
  GIT_COMMIT_ID_PATTERN,
  GIT_EMAIL_PATTERN,
  WORLD_ID_PATTERN,
  EVENT_TYPE_PATTERN,
  MAX_PRESENTATION_ENTRIES,
  MAX_PRESENTATION_VERBS,
  MAX_RESPONSE_ARTIFACTS,
  MAX_STORY_ACTIONS,
  MAX_STORY_INTENTS,
  MAX_STORY_RESPONSES,
  MAX_STORY_TEXT_LENGTH,
} from "./cartridge/schema.js";
export { CARTRIDGE_SCHEMA_ID, emitJsonSchema } from "./cartridge/jsonSchema.js";
export type {
  Archetype,
  CartridgeDirectory,
  CartridgeCommand,
  CartridgeEndpoint,
  CartridgeFile,
  CartridgeIdentity,
  CartridgeGitAuthor,
  CartridgeGitCommit,
  CartridgeGitFile,
  CartridgeGitHead,
  CartridgeGitHistory,
  CartridgeMeta,
  CartridgeModel,
  CartridgeAgentAction,
  CartridgeAuthoredResponse,
  CartridgeIntent,
  CartridgeMetricParameters,
  CartridgePlaceholder,
  CartridgePresentation,
  CartridgeResponseThinkingBlock,
  CartridgeResponseTodo,
  CartridgeResponseToolCall,
  CartridgeSpinnerPool,
  CartridgeStory,
  CartridgeRepository,
  CartridgeLog,
  CartridgeManPage,
  CartridgeProcess,
  CartridgeService,
  CartridgeSystem,
  CartridgeTicket,
  CartridgeTest,
  CartridgeReaction,
  DeferredObject,
  FilePredicate,
  LoadedCartridge,
  ReactionAction,
  ReactionPredicate,
  ServiceHealth,
  WorldUnitState,
} from "./cartridge/types.js";
