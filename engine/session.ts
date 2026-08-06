/**
 * Session replay — the shape of `state = reduce(cartridge, seed, eventLog)`.
 *
 * PROVISIONAL. The types here are the surface the golden-replay harness binds
 * to; the *implementation* is a placeholder that folds the event log into a
 * trivially derived state and transcript. It exists so the replay loop is
 * proven end to end in CI from the first Phase 0 PR onward, rather than after
 * the reducer lands.
 *
 * It drives a real seeded PRNG (`engine/random/`) and a real simulated clock
 * (`engine/clock/`), because those two *are* the determinism contract: a
 * placeholder that threaded the seed without ever drawing from it would prove
 * the harness works and prove nothing about what the harness exists to
 * protect. The probe events below exist so a fixture can lock a thousand draws
 * and a distribution snapshot as committed artifacts.
 *
 * The event log and reducer core (issue #4) replaces `replaySession`'s body,
 * the `SessionState` shape, and this whole vocabulary with a real event
 * registry. That will invalidate the recorded artifacts of every fixture
 * written before it — which is the designed path, not an accident: re-record
 * with `npm run fixtures:update` and justify the change in the PR description,
 * per CLAUDE.md.
 *
 * See docs/ARCHITECTURE.md → Event sourcing and determinism.
 */

import { ENGINE_VERSION } from "./version.js";
import { createClock } from "./clock/clock.js";
import type { ClockState, SimulatedClock } from "./clock/clock.js";
import { createRandom } from "./random/stream.js";
import type {
  RandomState,
  RandomStream,
  WeightedEntry,
} from "./random/stream.js";

/**
 * An entry in the append-only event log.
 *
 * Issue #4 replaces this with a discriminated union plus a registry that
 * subsystems extend. Until then the harness only needs a stable envelope.
 */
export interface EngineEvent {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** The triple that fully determines a session. */
export interface ReplayInput {
  /** The world. Unvalidated here; issue #3 introduces the loader. */
  readonly cartridge: unknown;
  /** Seed material for the PRNG, in the canonical form `formatSeed` renders. */
  readonly seed: string;
  readonly events: readonly EngineEvent[];
}

/** @provisional Replaced by the real state tree in issue #4. */
export interface SessionState {
  readonly engineVersion: string;
  readonly seed: string;
  readonly cartridge: unknown;
  readonly eventCount: number;
  readonly clock: ClockState;
  readonly random: RandomState;
}

export interface ReplayOutput {
  readonly state: SessionState;
  /** Transcript lines, LF-joined by the harness into `transcript.txt`. */
  readonly transcript: readonly string[];
}

/**
 * Where the clock starts when a cartridge does not say.
 *
 * The epoch, deliberately. A transcript stamped 1970 is a cartridge that
 * forgot to declare `meta.startedAt`, and it says so at a glance; a
 * plausible-looking default would be a wrong date nobody notices.
 *
 * @provisional Where that field lives is issue #3's to formalize with the rest
 * of the cartridge schema. Issue #2 needs *a* cartridge-declared start time,
 * so it picks one.
 */
export const DEFAULT_SESSION_START_MS = 0;

/** Indent for a transcript line elaborating the event line above it. */
const DETAIL_INDENT = "      ";

/** Raw draws printed per transcript line by a `uint32` probe. */
const DRAWS_PER_LINE = 8;

/** Ceiling on a probe's draw count, so a fixture stays a readable artifact. */
const MAX_PROBE_COUNT = 20000;

/** Ceiling on `random.int`'s bound, so its histogram stays readable. */
const MAX_PROBE_INT_BOUND = 1024;

/** Ceiling on a probe weight, well inside `weightedPick`'s own limit. */
const MAX_PROBE_WEIGHT = 1000000;

function padZero(value: number | string, width: number): string {
  return String(value).padStart(width, "0");
}

function hex32(value: number): string {
  return padZero(value.toString(16), 8);
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Read the cartridge-declared session start.
 *
 * Tolerant about the cartridge being shapeless — it is `unknown` until issue
 * #3 — but not about the field itself: a `startedAt` that is present and not a
 * UTC timestamp is an authoring error worth failing on, while an absent one is
 * a cartridge that predates the field.
 */
function readSessionStart(cartridge: unknown): number | string {
  const meta = asRecord(asRecord(cartridge)?.["meta"]);
  const startedAt = meta?.["startedAt"];
  if (startedAt === undefined) return DEFAULT_SESSION_START_MS;
  if (typeof startedAt !== "string") {
    throw new Error(
      `cartridge: meta.startedAt must be a UTC timestamp string, got ${JSON.stringify(startedAt)}`,
    );
  }
  return startedAt;
}

function requirePayload(
  event: EngineEvent,
  context: string,
): Readonly<Record<string, unknown>> {
  if (event.payload === undefined) {
    throw new Error(`${context}: this event type requires a payload`);
  }
  return event.payload;
}

function readInteger(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  low: number,
  high: number,
  context: string,
): number {
  const value = payload[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < low ||
    value > high
  ) {
    throw new Error(
      `${context}: ${key} must be an integer in [${String(low)}, ${String(high)}], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error(
      `${context}: ${key} must be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function readWeightedEntries(
  payload: Readonly<Record<string, unknown>>,
  context: string,
): readonly WeightedEntry<string>[] {
  const raw = payload["entries"];
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: entries must be an array`);
  }

  const items: readonly unknown[] = raw;
  const seen = new Set<string>();
  return items.map((item, index) => {
    const scope = `${context} entry ${String(index)}`;
    const entry = asRecord(item);
    if (entry === undefined) {
      throw new Error(`${scope}: must be an object`);
    }

    const value = readString(entry, "value", scope);
    // The snapshot tallies by value and prints one row per entry, so two arms
    // sharing a label would each report the merged count: the rows would sum
    // past `count`, and a weight-0 arm would appear to have been selected.
    // `weightedPick` handles duplicates correctly — it walks by index — so
    // this is the *report* being ambiguous, and an ambiguous report is worse
    // than no report when it is committed as a contract. Two identical labels
    // in a distribution snapshot are unreadable even with honest counts, so
    // reject rather than disambiguate.
    if (seen.has(value)) {
      throw new Error(
        `${scope}: value ${JSON.stringify(value)} already appears in this snapshot; distribution rows are labelled by value`,
      );
    }
    seen.add(value);

    return {
      value,
      weight: readInteger(entry, "weight", 0, MAX_PROBE_WEIGHT, scope),
    };
  });
}

/**
 * Resolve a payload's `stream` field to a stream handle.
 *
 * The path is relative to the root, so a fixture writes `spinner.verbs` rather
 * than `root/spinner.verbs`. The empty path is the root itself.
 */
function resolveStream(root: RandomStream, path: string): RandomStream {
  if (path === "") return root;
  let stream = root;
  for (const segment of path.split("/")) {
    stream = stream.fork(segment);
  }
  return stream;
}

/**
 * Where a stream stopped, as a transcript line.
 *
 * `state.json` records the same cursors, but only their final values. A
 * per-probe line says *when* a stream reached a position, which is what turns
 * a failing fixture from "something diverged" into "this probe diverged".
 */
function cursorLine(stream: RandomStream): string {
  const cursor = stream.toState().cursors[stream.path] ?? 0;
  return `${DETAIL_INDENT}cursor=${hex32(cursor)}`;
}

function chunkedLines(values: readonly string[], perLine: number): string[] {
  const lines: string[] = [];
  for (let start = 0; start < values.length; start += perLine) {
    lines.push(
      `${DETAIL_INDENT}${padZero(start, 4)}  ${values.slice(start, start + perLine).join(" ")}`,
    );
  }
  return lines;
}

/** What an event contributed to the transcript, beyond its own header line. */
interface EventRendering {
  /** Appended to the event's header line. */
  readonly summary: string;
  /** Indented lines below it. */
  readonly lines: readonly string[];
}

const NOTHING: EventRendering = { summary: "", lines: [] };

/**
 * Apply one event and describe what it did.
 *
 * @provisional Every case below is scaffolding for the fixtures; issue #4
 * replaces the whole function with a dispatch over the real event registry.
 */
function applyEvent(
  event: EngineEvent,
  context: string,
  clock: SimulatedClock,
  root: RandomStream,
): EventRendering {
  if (event.type === "clock.tick") {
    const payload = requirePayload(event, context);
    const ms = readInteger(payload, "ms", 0, 86400000, context);
    clock.advance(ms);
    return { summary: ` ms=${String(ms)}`, lines: [] };
  }

  if (event.type === "random.draw") {
    const payload = requirePayload(event, context);
    const stream = resolveStream(root, readString(payload, "stream", context));
    const count = readInteger(payload, "count", 1, MAX_PROBE_COUNT, context);
    const form = readString(payload, "form", context);
    if (form !== "uint32" && form !== "float") {
      throw new Error(`${context}: form must be "uint32" or "float"`);
    }

    const rendered: string[] = [];
    for (let index = 0; index < count; index += 1) {
      rendered.push(
        form === "uint32" ? hex32(stream.nextUint32()) : String(stream.next()),
      );
    }

    return {
      summary: ` stream=${stream.path} count=${String(count)} form=${form}`,
      lines: [
        ...chunkedLines(rendered, form === "uint32" ? DRAWS_PER_LINE : 4),
        cursorLine(stream),
      ],
    };
  }

  if (event.type === "random.int") {
    const payload = requirePayload(event, context);
    const stream = resolveStream(root, readString(payload, "stream", context));
    const count = readInteger(payload, "count", 1, MAX_PROBE_COUNT, context);
    const max = readInteger(payload, "max", 1, MAX_PROBE_INT_BOUND, context);

    const tally: number[] = [];
    for (let bucket = 0; bucket < max; bucket += 1) tally.push(0);
    for (let index = 0; index < count; index += 1) {
      const drawn = stream.int(max);
      tally[drawn] = (tally[drawn] ?? 0) + 1;
    }

    return {
      summary: ` stream=${stream.path} count=${String(count)} max=${String(max)}`,
      lines: [
        ...tally.map(
          (hits, bucket) =>
            `${DETAIL_INDENT}${String(bucket).padStart(4, " ")}  ${String(hits).padStart(6, " ")}`,
        ),
        cursorLine(stream),
      ],
    };
  }

  if (event.type === "random.weighted") {
    const payload = requirePayload(event, context);
    const stream = resolveStream(root, readString(payload, "stream", context));
    const count = readInteger(payload, "count", 1, MAX_PROBE_COUNT, context);
    const entries = readWeightedEntries(payload, context);

    const tally = new Map<string, number>();
    for (const entry of entries) tally.set(entry.value, 0);
    for (let index = 0; index < count; index += 1) {
      const picked = stream.weightedPick(entries);
      tally.set(picked, (tally.get(picked) ?? 0) + 1);
    }

    const width = entries.reduce(
      (widest, entry) => Math.max(widest, entry.value.length),
      0,
    );
    return {
      summary: ` stream=${stream.path} count=${String(count)}`,
      lines: [
        ...entries.map(
          (entry) =>
            `${DETAIL_INDENT}${entry.value.padEnd(width, " ")}  weight=${String(entry.weight).padStart(6, " ")}  picks=${String(tally.get(entry.value) ?? 0).padStart(7, " ")}`,
        ),
        cursorLine(stream),
      ],
    };
  }

  return NOTHING;
}

/**
 * Fold an event log into session state and a transcript.
 *
 * Pure and total: identical input produces identical output, with no reads of
 * wall-clock time, randomness, or ambient environment.
 */
export function replaySession(input: ReplayInput): ReplayOutput {
  const clock = createClock(readSessionStart(input.cartridge));
  const random = createRandom(input.seed);
  const transcript: string[] = [];

  input.events.forEach((event, index) => {
    // Stamped before the event is applied, so a `clock.tick` reads as the
    // moment it was issued rather than the moment it finished.
    const stamp = clock.timestamp();
    const rendering = applyEvent(
      event,
      `event ${String(index)} (${event.type})`,
      clock,
      random,
    );
    transcript.push(
      `${padZero(index, 4)}  ${stamp}  ${event.type}${rendering.summary}`,
      ...rendering.lines,
    );
  });

  return {
    state: {
      engineVersion: ENGINE_VERSION,
      seed: input.seed,
      cartridge: input.cartridge,
      eventCount: input.events.length,
      clock: clock.toState(),
      random: random.toState(),
    },
    transcript,
  };
}
