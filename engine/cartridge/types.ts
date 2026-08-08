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

export interface CartridgeModel {
  readonly id: string;
  readonly name: string;
  readonly archetype: Archetype;
  readonly description: string;
  readonly costMultiplier: number;
  readonly quirks: readonly string[];
}

export interface CartridgeRepository {
  /** Absolute path the session opens in. */
  readonly cwd: string;
  /** The simulated filesystem, keyed by absolute path. */
  readonly files: Readonly<Record<string, CartridgeFile>>;
  readonly env: Readonly<Record<string, string>>;
  readonly manPages: Readonly<Record<string, string>>;
  readonly shellHistory: readonly string[];
  readonly gitHistory: readonly DeferredObject[];
  readonly processes: readonly DeferredObject[];
  readonly services: readonly DeferredObject[];
  readonly logs: readonly DeferredObject[];
  readonly tickets: readonly DeferredObject[];
  readonly tests: readonly DeferredObject[];
}

export interface LoadedCartridge {
  readonly meta: CartridgeMeta;
  readonly repository: CartridgeRepository;
  readonly models: readonly CartridgeModel[];
  readonly story: DeferredObject;
  readonly presentation: DeferredObject;
}
