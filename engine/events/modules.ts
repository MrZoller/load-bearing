/**
 * The engine's event modules, and the registry they compose into.
 *
 * **This list is the extension point.** A subsystem adds event types by writing
 * its own module file and adding one line here — not by editing the reducer,
 * the transcript renderer, or a switch statement. Issues #5 (filesystem)
 * through #13 (mind state) each do exactly that.
 *
 * A list rather than import-time self-registration, because the list is what
 * makes the set of registered events a fact you can read. With
 * `registerEvent()` calls scattered through the subsystems, "which events does
 * this engine have" is answered by whichever modules the bundler happened to
 * include, and a tree-shaken subsystem becomes a session that silently rejects
 * a third of its own log.
 *
 * Order is irrelevant — `createRegistry` sorts by namespace and rejects
 * collisions, and no module can observe another's registration. Append rather
 * than insert anyway, so the diff says what was added.
 */

import { CLOCK_MODULE } from "./core.js";
import { PROBE_MODULE } from "./probe.js";
import { createRegistry } from "./registry.js";
import type { EventRegistry } from "./registry.js";
import type { EventModule } from "./module.js";

export const ENGINE_EVENT_MODULES: readonly EventModule[] = Object.freeze([
  CLOCK_MODULE,
  PROBE_MODULE,
]);

/**
 * The registry every entry point defaults to.
 *
 * Built once at module load. `reduce`, `step`, and `appendEvent` all take a
 * registry parameter that defaults to this one, so a test can fold a log
 * against a synthetic set of modules without the engine's own being involved.
 */
export const ENGINE_EVENT_REGISTRY: EventRegistry =
  createRegistry(ENGINE_EVENT_MODULES);
