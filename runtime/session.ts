import {
  EMPTY_EVENT_LOG,
  appendEvent,
  bootstrap,
  formatSeed,
  loadCartridge,
  step,
} from "../engine/index.js";
import type {
  EngineEvent,
  LoadedCartridge,
  SessionState,
} from "../engine/index.js";

export interface RuntimeSessionSnapshot {
  readonly eventLog: readonly EngineEvent[];
  readonly state: SessionState;
}

export interface RuntimeSession {
  readonly cartridge: LoadedCartridge;
  current(): RuntimeSessionSnapshot;
  dispatch(event: EngineEvent): RuntimeSessionSnapshot;
}

/**
 * Own the browser's sole mutable reference to the immutable engine history.
 * Presentation code receives snapshots, never a subsystem slice it could edit.
 */
export function createRuntimeSession(document: unknown): RuntimeSession {
  const cartridge = loadCartridge(document);
  const model = cartridge.models[0];
  if (model === undefined) {
    throw new Error("A loaded cartridge must declare at least one model.");
  }

  const seed = formatSeed({
    incidentDate: cartridge.meta.date,
    dailySeed: cartridge.meta.number,
    model: model.id,
  });
  let eventLog: readonly EngineEvent[] = EMPTY_EVENT_LOG;
  let state = bootstrap({ cartridge, seed });

  function current(): RuntimeSessionSnapshot {
    return Object.freeze({ eventLog, state });
  }

  function dispatch(event: EngineEvent): RuntimeSessionSnapshot {
    const nextLog = appendEvent(eventLog, event);
    const storedEvent = nextLog[nextLog.length - 1];
    if (storedEvent === undefined) {
      throw new Error("Appending an event produced an empty event log.");
    }

    // Publish the new history only after its canonical stored event folds. If a
    // handler rejects it, callers retain the last complete state/log pair.
    const nextState = step(state, storedEvent);
    eventLog = nextLog;
    state = nextState;
    return current();
  }

  return Object.freeze({ cartridge, current, dispatch });
}
