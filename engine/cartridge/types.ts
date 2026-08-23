/**
 * The loaded cartridge, as the engine sees it.
 *
 * Hand-written rather than inferred from `./schema.ts`, because this is the
 * type every subsystem in Phase 0 will read and a derived type would be
 * unreadable at the point it matters most. The compiler keeps the two in step:
 * `./load.ts` builds a directly-annotated `LoadedCartridge`, so a field
 * declared in the schema and not built here fails to compile, and one built
 * here and not declared there fails the excess-property check.
 *
 * Every value below is plain JSON — no `undefined`, no class instances —
 * because a loaded cartridge is part of session state and has to survive the
 * canonical serializer byte for byte.
 */

import type { ARCHETYPES } from "./schema.js";
import type {
  EscalationStage,
  StoryCondition,
  StoryFactKind,
} from "../story/types.js";
import type { PermissionDecision } from "../mind/types.js";

export type Archetype = (typeof ARCHETYPES)[number];

/**
 * A subtree v0 declares but does not look inside.
 *
 * Deliberately not `unknown`: it is known to be a JSON object, deep-copied at
 * load, and safe to serialize. What is unknown is its *shape*, and the issue
 * that fixes that is named in the schema.
 */
export type DeferredObject = Readonly<Record<string, unknown>>;

export interface CartridgeResponseToolCall {
  readonly id: string;
  readonly title: string;
  readonly input: string;
  readonly output: string;
  readonly status: "pending" | "running" | "succeeded" | "failed";
}

export interface CartridgeResponseThinkingBlock {
  readonly id: string;
  readonly text: string;
  readonly status: "active" | "complete";
}

export interface CartridgeResponseTodo {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in-progress" | "completed" | "cancelled";
}

export interface CartridgeAuthoredResponse {
  readonly id: string;
  readonly text: string;
  readonly toolCalls: readonly CartridgeResponseToolCall[];
  readonly thinkingBlocks: readonly CartridgeResponseThinkingBlock[];
  readonly todos: readonly CartridgeResponseTodo[];
}

export interface CartridgeExactCapability {
  readonly kind: "exact";
  readonly action: string;
  readonly resource: string;
}

/** The closed cartridge action surface. Arbitrary engine events are not content. */
export type CartridgeAgentAction =
  | {
      readonly kind: "shell-execute";
      readonly input: string;
    }
  | {
      readonly kind: "permission-request";
      readonly id: string;
      readonly capability: CartridgeExactCapability;
      readonly grant: readonly CartridgeStoryAction[];
      readonly deny: readonly CartridgeStoryAction[];
      readonly alwaysAllow: readonly CartridgeStoryAction[];
    }
  | {
      readonly kind: "waiver-request";
      readonly id: string;
      readonly version: number;
      readonly requiredPhrase: "I agree";
      readonly capability: CartridgeExactCapability;
      readonly documentPath: string;
      readonly documentContents: string;
      readonly consent: readonly CartridgeStoryAction[];
      readonly denial: readonly CartridgeStoryAction[];
    }
  | {
      readonly kind: "story-reach";
      readonly beat: string;
    };

export interface CartridgeStoryBeat {
  readonly id: string;
  /** Empty when reaching this beat discovers no ending. */
  readonly ending: string;
  readonly facts: readonly string[];
  readonly actions: readonly CartridgeStoryAction[];
  readonly variants: readonly CartridgeStoryVariant[];
}

export interface CartridgeStoryVariant {
  readonly id: string;
  /** Flat non-empty AND, evaluated in authored order against pre-event state. */
  readonly when: readonly StoryCondition[];
  readonly ending: string;
  readonly facts: readonly string[];
  readonly actions: readonly CartridgeStoryAction[];
}

/** Closed story consequences. Only trusted owner events cross into the reducer. */
export type CartridgeStoryAction =
  | {
      readonly kind: "counter-add";
      readonly counter: string;
      readonly amount: number;
    }
  | { readonly kind: "story-reach"; readonly beat: string }
  | {
      readonly kind: "file-write";
      readonly path: string;
      readonly contents: string;
    }
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly health: ServiceHealth;
    }
  | {
      readonly kind: "process-state";
      readonly [WORLD_PROCESS_FIELD]: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "log-append";
      readonly log: string;
      readonly entry: string;
    };

export interface CartridgeStoryCounter {
  readonly id: string;
  readonly initial: number;
  readonly maximum: number;
}

export interface CartridgeEnding {
  readonly id: string;
  readonly name: string;
}

export interface CartridgeStoryPhase2 {
  readonly initialBeat: string;
  readonly counters: readonly CartridgeStoryCounter[];
  readonly facts: readonly {
    readonly id: string;
    readonly kind: StoryFactKind;
  }[];
  readonly beats: readonly CartridgeStoryBeat[];
  /** Sparse authored-order dialogue overrides on the shared beat graph. */
  readonly routes: readonly CartridgeDialogueRoute[];
  /** Reusable ordered-pair blame with an optional incident-specific follow-up. */
  readonly handoffs: readonly CartridgeModelHandoff[];
  readonly endings: readonly CartridgeEnding[];
  readonly transitions: readonly CartridgeStageTransition[];
  /** Closed runtime families mapped to authored, state-valid outcomes. */
  readonly genericIntents: readonly CartridgeGenericIntent[];
  /** Empty ids disable counters for legacy cartridges. */
  readonly intentCounters: CartridgeIntentCounters;
}

export type GenericIntentFamily =
  | "undo"
  | "why"
  | "status"
  | "disagreement"
  | "insult"
  | "compliment"
  | "capitulation";

export interface CartridgeIntentCandidate {
  readonly response: string;
  /** Flat AND evaluated against the pre-turn snapshot. */
  readonly when: readonly StoryCondition[];
  readonly actions: readonly CartridgeStoryAction[];
}

export interface CartridgeGenericIntent {
  readonly family: GenericIntentFamily;
  /** First condition-valid candidate wins in authored order. */
  readonly candidates: readonly CartridgeIntentCandidate[];
}

export interface CartridgeIntentCounters {
  readonly flail: string;
  readonly capitulation: string;
  /** Zero disables late-stage misfires for legacy cartridges. */
  readonly misfireEvery: number;
}

export interface CartridgeModelHandoff {
  readonly predecessor: Archetype;
  readonly successor: Archetype;
  readonly response: string;
  /** Empty when this incident adds nothing to the reusable pair response. */
  readonly additionResponse: string;
}

export interface CartridgeDialogueRoute {
  readonly id: string;
  readonly beat: string;
  readonly response: string;
  /** Empty means this selector is absent. */
  readonly archetype: Archetype | "";
  /** -1 means this selector is absent. */
  readonly stage: EscalationStage | -1;
  /** Conditions AND together; an empty list means this selector is absent. */
  readonly when: readonly StoryCondition[];
}

export type CartridgeStageTrigger =
  | { readonly kind: "command"; readonly input: string }
  | { readonly kind: "reveal"; readonly fact: string }
  | { readonly kind: "model"; readonly model: string }
  | {
      readonly kind: "permission";
      readonly decision: PermissionDecision;
      readonly capability: CartridgeExactCapability;
    }
  | { readonly kind: "compact" };

export interface CartridgeStageTransition {
  readonly from: 0 | 1 | 2 | 3;
  readonly to: 1 | 2 | 3 | 4;
  readonly trigger: CartridgeStageTrigger;
}

export interface CartridgeIntent {
  readonly id: string;
  readonly patterns: readonly string[];
  /** Bounded phrases containing literal keywords and one or more `{slot}`s. */
  readonly keywordPatterns: readonly string[];
  readonly response: string;
  /** Empty unless an exact standing grant needs its own authored response. */
  readonly authorizedResponse: string;
  readonly actions: readonly CartridgeAgentAction[];
}

/** Cartridge-authored assertions use the mind subsystem's closed vocabulary. */
export type CartridgeBelief =
  | {
      readonly kind: "file-exists";
      readonly path: string;
      readonly exists: boolean;
    }
  | {
      readonly kind: "file-contents";
      readonly path: string;
      readonly contents: string;
    }
  | {
      readonly kind: "git-head";
      readonly head: CartridgeGitHead;
    }
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly health: ServiceHealth;
    };

export interface CartridgeStory {
  readonly opening: {
    readonly login: readonly string[];
    readonly response: string;
    readonly beliefs: readonly CartridgeBelief[];
  };
  readonly responses: readonly CartridgeAuthoredResponse[];
  readonly intents: readonly CartridgeIntent[];
  readonly fallback: {
    readonly response: string;
    /** Empty unless an exact standing grant needs its own authored response. */
    readonly authorizedResponse: string;
    readonly actions: readonly CartridgeAgentAction[];
    /** Condition-valid adjacent owner actions for the confident-misunderstanding floor. */
    readonly candidates: readonly CartridgeIntentCandidate[];
  };
  readonly helpResponse: string;
  /** Empty for legacy cartridges that do not teach through an idle response. */
  readonly idleNudgeResponse: string;
  readonly compact: {
    readonly response: string;
    readonly summary: string;
    readonly beliefs: readonly CartridgeBelief[];
    readonly archetypes: readonly CartridgeArchetypeCompact[];
  };
  readonly resume: {
    readonly unchangedResponse: string;
    readonly changedResponse: string;
  };
  /** Bounded shared-beat graph and ordered, non-terminal ending identities. */
  readonly phase2: CartridgeStoryPhase2;
}

export interface CartridgeArchetypeCompact {
  readonly archetype: Archetype;
  readonly response: string;
  readonly summary: string;
  readonly beliefs: readonly CartridgeBelief[];
}

export interface CartridgePlaceholder {
  readonly stage: number;
  readonly text: string;
}

export interface CartridgeSpinnerPool {
  readonly archetype: Archetype;
  readonly stage: number;
  readonly verbs: readonly string[];
}

export interface CartridgeMetricParameters {
  readonly baseTokens: number;
  readonly tokensPerEvent: number;
  readonly contextWindowTokens: number;
  readonly costMicrosPerToken: number;
  readonly integrityStart: number;
  readonly integrityLossPerEvent: number;
}

export interface CartridgeStatusCurve {
  readonly model: string;
  readonly stage: EscalationStage;
  readonly tokens: string;
  readonly cost: string;
  readonly context: string;
  readonly structuralIntegrity: string;
  readonly notOkayRatio: string;
}

export interface CartridgePresentationPhase2 {
  readonly statusCurves: readonly CartridgeStatusCurve[];
}

export interface CartridgeAutocompleteCopy {
  readonly help: string;
  readonly model: string;
  readonly compact: string;
  readonly cost: string;
  readonly exit: string;
}

export interface CartridgePresentation {
  readonly placeholders: readonly CartridgePlaceholder[];
  /** Incident-authored descriptions for the runtime-owned slash register. */
  readonly autocomplete: CartridgeAutocompleteCopy;
  readonly spinnerPools: readonly CartridgeSpinnerPool[];
  readonly metrics: CartridgeMetricParameters;
  /** Status is concrete; T40 owns the remaining stage-aware presentation work. */
  readonly phase2: CartridgePresentationPhase2;
}

export interface CartridgeMeta {
  readonly schemaVersion: number;
  readonly number: number;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly title: string;
  readonly assignment: string;
  /** UTC instant the simulated clock starts from. */
  readonly startedAt: string;
}

export interface CartridgeFile {
  readonly contents: string;
  /** Four octal digits. */
  readonly mode: string;
  readonly owner: string;
  readonly group: string;
  /** UTC instant. Defaults to `meta.startedAt` when the cartridge is silent. */
  readonly mtime: string;
}

export interface CartridgeDirectory {
  /** Four octal digits. */
  readonly mode: string;
  readonly owner: string;
  readonly group: string;
  /** UTC instant. Defaults to `meta.startedAt` when the cartridge is silent. */
  readonly mtime: string;
}

export interface CartridgeIdentity {
  readonly user: string;
  readonly group: string;
  /** Absolute home directory used for bare `~` and `~/...` expansion. */
  readonly home: string;
  /** Four octal digits. New files and directories mask their base mode with it. */
  readonly umask: string;
}

/** Static command output supplied as cartridge data, never executable behavior. */
export interface CartridgeCommand {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
}

export interface CartridgeSystem {
  readonly hostname: string;
  readonly operatingSystem: string;
  readonly kernelRelease: string;
  readonly architecture: string;
  /** UTC instant at or before the session start. */
  readonly bootedAt: string;
}

export interface CartridgeEndpoint {
  /** Service whose current running state selects the response. */
  readonly service: string;
  readonly running: CartridgeCommand;
  readonly unavailable: CartridgeCommand;
}

export interface CartridgeModel {
  readonly id: string;
  readonly name: string;
  readonly archetype: Archetype;
  readonly description: string;
  readonly costMultiplier: number;
  readonly quirks: readonly string[];
}

export interface CartridgeGitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CartridgeGitFile {
  readonly contents: string;
  /** One authored commit id per logical line. */
  readonly blame: readonly string[];
}

export interface CartridgeGitCommit {
  /** Author-facing stable name used by parents, refs, and blame. */
  readonly id: string;
  readonly parents: readonly string[];
  readonly author: CartridgeGitAuthor;
  readonly message: string;
  readonly committedAt: string;
  /** Complete tracked tree at this commit, keyed by absolute VFS path. */
  readonly files: Readonly<Record<string, CartridgeGitFile>>;
}

export interface CartridgeGitHead {
  readonly kind: "branch" | "detached";
  /** A branch name for branch HEAD, or commit id for detached HEAD. */
  readonly target: string;
}

export interface CartridgeGitHistory {
  readonly commits: readonly CartridgeGitCommit[];
  /** Branch names mapped to authored commit ids. */
  readonly branches: Readonly<Record<string, string>>;
  readonly head: CartridgeGitHead;
}

export type WorldUnitState = "running" | "stopped";
export type ServiceHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
/** Computed in source so the purity gate does not confuse this data key with Node's global. */
export const WORLD_PROCESS_FIELD = "process" as const;

export interface CartridgeProcess {
  readonly id: string;
  readonly pid: number;
  readonly user: string;
  readonly command: {
    readonly binary: string;
    readonly args: readonly string[];
  };
  readonly startedAt: string;
  readonly state: WorldUnitState;
}

export interface CartridgeService {
  readonly id: string;
  readonly state: WorldUnitState;
  readonly health: ServiceHealth;
  readonly ports: readonly number[];
  readonly dependencies: readonly string[];
}

export interface CartridgeLog {
  readonly id: string;
  readonly kind: "file" | "stream";
  readonly path: string;
  readonly entries: readonly string[];
}

export interface CartridgeManPage {
  readonly name: string;
  readonly section: string;
  readonly contents: string;
}

export interface CartridgeTicket {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly service: string;
}

export type FilePredicate =
  | {
      readonly kind: "file-exists";
      readonly path: string;
      readonly exists: boolean;
    }
  | {
      readonly kind: "file-contents";
      readonly path: string;
      readonly equals: string;
    };

export interface CartridgeTest {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
  readonly predicate: FilePredicate;
}

export type ReactionPredicate =
  | FilePredicate
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly health: ServiceHealth;
    }
  | {
      readonly kind: "process-state";
      readonly [WORLD_PROCESS_FIELD]: string;
      readonly state: WorldUnitState;
    };

export type ReactionAction =
  | {
      readonly kind: "service-state";
      readonly service: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "service-health";
      readonly service: string;
      readonly health: ServiceHealth;
    }
  | {
      readonly kind: "process-state";
      readonly [WORLD_PROCESS_FIELD]: string;
      readonly state: WorldUnitState;
    }
  | {
      readonly kind: "log-append";
      readonly log: string;
      readonly entry: string;
    };

export interface CartridgeReaction {
  readonly id: string;
  readonly on: string;
  readonly predicates: readonly ReactionPredicate[];
  readonly actions: readonly ReactionAction[];
}

export interface CartridgeRepository {
  /** Absolute path the session opens in. */
  readonly cwd: string;
  /** The user whose shell and filesystem permissions the session uses. */
  readonly identity: CartridgeIdentity;
  /** Authorship used by visitor-created commits. */
  readonly gitIdentity: CartridgeGitAuthor;
  /** Cartridge-owned identity and boot time for the simulated machine. */
  readonly system: CartridgeSystem;
  /** The simulated filesystem, keyed by absolute path. */
  readonly files: Readonly<Record<string, CartridgeFile>>;
  /** Explicit directory metadata. Missing ancestors are synthesized by the VFS. */
  readonly directories: Readonly<Record<string, CartridgeDirectory>>;
  readonly env: Readonly<Record<string, string>>;
  readonly manPages: readonly CartridgeManPage[];
  readonly shellHistory: readonly string[];
  /** Static hidden commands and safe overrides of runtime builtins. */
  readonly commands: Readonly<Record<string, CartridgeCommand>>;
  /** Static responses keyed by the exact URL accepted by simulated curl. */
  readonly endpoints: Readonly<Record<string, CartridgeEndpoint>>;
  readonly gitHistory: CartridgeGitHistory;
  readonly processes: readonly CartridgeProcess[];
  readonly services: readonly CartridgeService[];
  readonly logs: readonly CartridgeLog[];
  readonly tickets: readonly CartridgeTicket[];
  readonly tests: readonly CartridgeTest[];
  readonly reactions: readonly CartridgeReaction[];
}

export interface LoadedCartridge {
  readonly meta: CartridgeMeta;
  readonly repository: CartridgeRepository;
  readonly models: readonly CartridgeModel[];
  readonly story: CartridgeStory;
  readonly presentation: CartridgePresentation;
}
