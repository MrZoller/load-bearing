/**
 * The simulated clock.
 *
 * Time in the engine is a number that only moves when an event says so. There
 * is no wall clock to read (invariant 2 bans `Date`, and the purity gate
 * enforces it), so "how long has this session been running" is a property of
 * the event log, not of when the visitor happened to open the tab. Two people
 * replaying the same log see the same timestamps on the same lines, a year
 * apart.
 *
 * The clock therefore has exactly two pieces of state: where the session
 * started, and how far it has advanced. Which events advance it, and by how
 * much, is decided per subsystem — a `git log` is instantaneous, a simulated
 * test run is not — and belongs with those subsystems, not here. The reducer
 * hands each event handler a live clock (`engine/events/module.ts` →
 * `EventContext`) and takes its position back afterwards; `clock.tick` is the
 * event for time passing on its own.
 */

import type { CivilTime } from "./civil.js";
import {
  MAX_EPOCH_MS,
  MIN_EPOCH_MS,
  civilFromEpochMs,
  formatTimestamp,
  parseTimestamp,
} from "./civil.js";

/** The serializable position of the clock. */
export interface ClockState {
  /** Epoch milliseconds at session start, from the cartridge. */
  readonly startMs: number;
  /** Milliseconds advanced since then. Never negative. */
  readonly elapsedMs: number;
}

export interface SimulatedClock {
  /** Epoch milliseconds now: `startMs + elapsedMs`. */
  now(): number;
  /** Milliseconds since session start. */
  elapsed(): number;
  /** UTC calendar fields for the current instant. */
  civil(): CivilTime;
  /** The current instant as `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  timestamp(): string;
  /** Move time forward by `ms`, returning the new `now()`. */
  advance(ms: number): number;
  toState(): ClockState;
}

function assertAdvance(ms: number, remaining: number): number {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(
      `clock: advance must be a non-negative integer of milliseconds, got ${String(ms)}`,
    );
  }
  if (ms > remaining) {
    throw new Error(
      `clock: advancing by ${String(ms)}ms would pass ${String(MAX_EPOCH_MS)}, the last representable instant`,
    );
  }
  return ms;
}

function makeClock(startMs: number, initialElapsed: number): SimulatedClock {
  let elapsedMs = initialElapsed;

  const clock: SimulatedClock = {
    now(): number {
      return startMs + elapsedMs;
    },

    elapsed(): number {
      return elapsedMs;
    },

    civil(): CivilTime {
      return civilFromEpochMs(clock.now());
    },

    timestamp(): string {
      return formatTimestamp(clock.now());
    },

    /**
     * Zero is allowed — plenty of events take no simulated time, and making
     * those call sites branch would be worse than letting the tick be zero.
     * Negative is not: a clock that can run backwards makes `git log` order
     * disagree with the event log, and invariant 4 says the world lies
     * consistently.
     */
    advance(ms: number): number {
      elapsedMs += assertAdvance(ms, MAX_EPOCH_MS - clock.now());
      return clock.now();
    },

    toState(): ClockState {
      return { startMs, elapsedMs };
    },
  };

  return clock;
}

/**
 * Start a clock at the cartridge-declared session start.
 *
 * A string is parsed as a UTC timestamp — the form cartridges author. A number
 * is taken as epoch milliseconds.
 */
export function createClock(start: number | string): SimulatedClock {
  const startMs =
    typeof start === "string" ? parseTimestamp(start) : assertStart(start);
  return makeClock(startMs, 0);
}

/** Rebuild a clock from serialized state, stopped exactly where it was. */
export function restoreClock(state: ClockState): SimulatedClock {
  const startMs = assertStart(state.startMs);
  if (
    !Number.isInteger(state.elapsedMs) ||
    state.elapsedMs < 0 ||
    startMs + state.elapsedMs > MAX_EPOCH_MS
  ) {
    throw new Error(
      `clock: elapsed must be an integer keeping the clock inside the representable range, got ${String(state.elapsedMs)}`,
    );
  }
  return makeClock(startMs, state.elapsedMs);
}

function assertStart(startMs: number): number {
  if (
    !Number.isInteger(startMs) ||
    startMs < MIN_EPOCH_MS ||
    startMs > MAX_EPOCH_MS
  ) {
    throw new Error(
      `clock: session start must be an integer in [${String(MIN_EPOCH_MS)}, ${String(MAX_EPOCH_MS)}] milliseconds, got ${String(startMs)}`,
    );
  }
  return startMs;
}
