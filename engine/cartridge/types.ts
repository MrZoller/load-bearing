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

export type Archetype = (typeof ARCHETYPES)[number];

/**
 * A subtree v0 declares but does not look inside.
 *
 * Deliberately not `unknown`: it is known to be a JSON object, deep-copied at
 * load, and safe to serialize. What is unknown is its *shape*, and the issue
 * that fixes that is named in the schema.
 */
export type DeferredObject = Readonly<Record<string, unknown>>;

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

export interface CartridgeRepository {
  /** Absolute path the session opens in. */
  readonly cwd: string;
  /** The user whose shell and filesystem permissions the session uses. */
  readonly identity: CartridgeIdentity;
  /** The simulated filesystem, keyed by absolute path. */
  readonly files: Readonly<Record<string, CartridgeFile>>;
  /** Explicit directory metadata. Missing ancestors are synthesized by the VFS. */
  readonly directories: Readonly<Record<string, CartridgeDirectory>>;
  readonly env: Readonly<Record<string, string>>;
  readonly manPages: readonly CartridgeManPage[];
  readonly shellHistory: readonly string[];
  /** Static hidden commands and explicit overrides of runtime builtins. */
  readonly commands: Readonly<Record<string, CartridgeCommand>>;
  readonly gitHistory: CartridgeGitHistory;
  readonly processes: readonly CartridgeProcess[];
  readonly services: readonly CartridgeService[];
  readonly logs: readonly CartridgeLog[];
  readonly tickets: readonly CartridgeTicket[];
  readonly tests: readonly DeferredObject[];
}

export interface LoadedCartridge {
  readonly meta: CartridgeMeta;
  readonly repository: CartridgeRepository;
  readonly models: readonly CartridgeModel[];
  readonly story: DeferredObject;
  readonly presentation: DeferredObject;
}
