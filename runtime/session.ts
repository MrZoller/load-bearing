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
  dispatchMany(events: readonly EngineEvent[]): RuntimeSessionSnapshot;
}

export interface RuntimeSessionOptions {
  readonly seed?: string;
}

/**
 * Own the browser's sole mutable reference to the immutable engine history.
 * Presentation code receives snapshots, never a subsystem slice it could edit.
 */
export function createRuntimeSession(
  document: unknown,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const cartridge = loadCartridge(document);
  const model = cartridge.models[0];
  if (model === undefined) {
    throw new Error("A loaded cartridge must declare at least one model.");
  }

  const seed =
    options.seed ??
    formatSeed({
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
    return dispatchMany([event]);
  }

  function dispatchMany(
    events: readonly EngineEvent[],
  ): RuntimeSessionSnapshot {
    let nextLog = eventLog;
    let nextState = state;
    for (const event of events) {
      nextLog = appendEvent(nextLog, event);
      const storedEvent = nextLog[nextLog.length - 1];
      if (storedEvent === undefined) {
        throw new Error("Appending an event produced an empty event log.");
      }
      nextState = step(nextState, storedEvent);
    }

    // Publish only after the complete visitor turn folds. A rejected action
    // cannot expose a visitor message without its authored consequence.
    eventLog = nextLog;
    state = nextState;
    return current();
  }

  return Object.freeze({ cartridge, current, dispatch, dispatchMany });
}
