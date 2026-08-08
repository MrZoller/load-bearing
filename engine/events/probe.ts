/**
 * Diagnostics: events that draw from the PRNG and write down what came out.
 *
 * These exist so a golden fixture can lock the *generator* rather than
 * something downstream of it. `engine/__fixtures__/replay/002-random-clock`
 * records a thousand raw draws, a float derivation, an `int()` histogram, and a
 * `weightedPick` distribution as committed artifacts, so a change to the seed
 * hash, the mulberry32 constants, `fork`'s path derivation, or the rejection
 * window fails at the draw where it first diverged instead of showing up months
 * later as a spinner picking a different verb.
 *
 * They are registered in the ordinary engine registry rather than bolted onto
 * the harness, so fixtures exercise exactly the dispatch path production uses.
 * They mutate no world state, reach nothing outside the PRNG, and are the one
 * module in Phase 0 that carries a slice — which is deliberate: it puts the
 * slice mechanism into a committed recording rather than leaving it proven only
 * by unit tests.
 *
 * Streams are addressed relative to this module's own stream (`root/probe`), as
 * every module's are. `""` names `root/probe` itself.
 */

import type { RandomStream, WeightedEntry } from "../random/stream.js";
import { defineEventModule } from "./module.js";
import type { EventContext } from "./module.js";
import { readInteger, readString, requirePayload } from "./payload.js";
import type { EventPayload } from "./payload.js";
import { padZero } from "./transcript.js";

/** Raw draws printed per transcript line by a `probe.random` in uint32 form. */
const UINT32_PER_LINE = 8;

/** Floats per transcript line — four, because each is far wider. */
const FLOAT_PER_LINE = 4;

/** Ceiling on a probe's draw count, so a fixture stays a readable artifact. */
const MAX_PROBE_COUNT = 20000;

/** Ceiling on `probe.int`'s bound, so its histogram stays readable. */
const MAX_PROBE_INT_BOUND = 1024;

/** Ceiling on a probe weight, well inside `weightedPick`'s own limit. */
const MAX_PROBE_WEIGHT = 1000000;

/** What the probes have done so far. The whole point is that it accumulates. */
export interface ProbeSlice {
  /** How many probe events have been folded in. */
  readonly events: number;
  /** How many values they produced in total. */
  readonly values: number;
}

function hex32(value: number): string {
  return padZero(value.toString(16), 8);
}

/**
 * Resolve a payload's `stream` field against this module's stream.
 *
 * A fixture writes `spinner.verbs` and gets `root/probe/spinner.verbs`. Slashes
 * fork further, so `spinner/verbs` reaches a grandchild — which is what makes
 * the fixture cover path derivation at depth rather than only at the first
 * level.
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
 * per-probe line says *when* a stream reached a position, which is what turns a
 * failing fixture from "something diverged" into "this probe diverged".
 */
function cursorLine(stream: RandomStream): string {
  const cursor = stream.toState().cursors[stream.path] ?? 0;
  return `cursor=${hex32(cursor)}`;
}

function chunkedLines(values: readonly string[], perLine: number): string[] {
  const lines: string[] = [];
  for (let start = 0; start < values.length; start += perLine) {
    lines.push(
      `${padZero(start, 4)}  ${values.slice(start, start + perLine).join(" ")}`,
    );
  }
  return lines;
}

/** The stream and the draw count every probe payload carries. */
function readProbeHead(context: EventContext): {
  payload: EventPayload;
  stream: RandomStream;
  count: number;
} {
  const payload = requirePayload(context);
  return {
    payload,
    stream: resolveStream(
      context.random,
      readString(payload, "stream", context.where),
    ),
    count: readInteger(payload, "count", 1, MAX_PROBE_COUNT, context.where),
  };
}

/**
 * Advance the counters, refusing to produce one that cannot be read back.
 *
 * The guard belongs here, on the fold path, and not only at the restore
 * boundary. Past `MAX_SAFE_INTEGER` addition stops being exact — `n + 1`
 * returns `n`, `n + 3` lands 2 away — so the counter silently stops counting
 * and the corruption survives re-serialization looking like an ordinary
 * integer. Refusing costs one comparison per probe event.
 *
 * It cannot be replaced by a tighter bound at restore. Any ceiling `B` that
 * restore accepts is a value the next fold turns into `B + growth`, which is
 * larger than `B` and which restore would then refuse — so the engine would
 * emit a snapshot it will not read back, whatever `B` is. The round-trip
 * property is only available from this side.
 */
function advanced(
  slice: ProbeSlice,
  values: number,
  where: string,
): ProbeSlice {
  const events = slice.events + 1;
  const total = slice.values + values;
  if (!Number.isSafeInteger(events) || !Number.isSafeInteger(total)) {
    throw new Error(
      `${where}: this probe would take the slice past ${String(Number.MAX_SAFE_INTEGER)}, where ` +
        `addition stops being exact and the counter would silently stop counting.`,
    );
  }
  return { events, values: total };
}

function readWeightedEntries(
  payload: EventPayload,
  where: string,
): readonly WeightedEntry<string>[] {
  const raw = payload["entries"];
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: entries must be an array`);
  }

  const items: readonly unknown[] = raw;
  const seen = new Set<string>();
  const entries: WeightedEntry<string>[] = [];
  // An index loop, because `map` skips holes. A sparse `entries` array — from a
  // hand-built log or a decoded permalink — passed validation untouched and
  // reached `weightedPick`'s own hole check as a bare `TypeError` on
  // `entry.value`, naming no event and no module. `weightedPick` carries an
  // explicit named check for exactly this and `captureOutcome` carries a
  // paragraph about `forEach` skipping holes; the validator sitting between
  // them did neither.
  for (let index = 0; index < items.length; index += 1) {
    const scope = `${where} entry ${String(index)}`;
    const item = items[index];
    if (!(index in items)) {
      throw new Error(`${scope}: is a hole in a sparse array`);
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${scope}: must be an object`);
    }

    const entry = item as EventPayload;
    const value = readString(entry, "value", scope);
    // The snapshot tallies by value and prints one row per entry, so two arms
    // sharing a label would each report the merged count: the rows would sum
    // past `count`, and a weight-0 arm would appear to have been selected.
    // `weightedPick` handles duplicates correctly — it walks by index — so this
    // is the *report* being ambiguous, and an ambiguous report is worse than no
    // report when it is committed as a contract.
    if (seen.has(value)) {
      throw new Error(
        `${scope}: value ${JSON.stringify(value)} already appears in this snapshot; distribution rows are labelled by value`,
      );
    }
    seen.add(value);

    entries.push({
      value,
      weight: readInteger(entry, "weight", 0, MAX_PROBE_WEIGHT, scope),
    });
  }
  return entries;
}

/**
 * Check a `probe` slice arriving from a snapshot.
 *
 * The worked example of the `validateSlice` hook, and the reason it exists: the
 * reducer can confirm the snapshot has a `probe` key and nothing more, so
 * `{ events: "oops" }` would restore cleanly and the next probe event would
 * fold `"oops1"` into recorded state. Only this module knows the shape, so only
 * this module can refuse it.
 */
function validateProbeSlice(slice: unknown, where: string): ProbeSlice {
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    throw new Error(`${where}: must be an object`);
  }
  const record = slice as Readonly<Record<string, unknown>>;
  const counts = ["events", "values"] as const;
  for (const key of counts) {
    const count = record[key];
    // Exactly the safe-integer range, which is exactly what the fold path can
    // produce: `advanced()` refuses to *create* a counter above
    // `MAX_SAFE_INTEGER`, so accepting up to it here means restore takes back
    // precisely the set of values the engine can emit. The two bounds are the
    // same number for that reason, not by coincidence — together they are one
    // invariant, that the engine never produces a counter it will not read
    // back.
    //
    // A tighter ceiling here would break that rather than strengthen it: any
    // value restore accepts, the next fold turns into a larger one, which
    // restore would then refuse.
    //
    // ## Scope of this check, for #5–#13
    //
    // Within the modules that exist today this is the last unbounded counter on
    // the snapshot path — the clock is bounded by `MAX_EPOCH_MS`, PRNG cursors
    // by `assertUint32`, payload integers by the explicit bounds `readInteger`
    // requires, and `eventCount` by the transcript-length equality in
    // `restoreSnapshot` (which is a real bound, but an indirect one: it holds
    // only because the transcript it is compared against is itself bounded).
    //
    // That is a statement about today, not a property of the design.
    // `validateSlice` is per-module and there is no shared numeric-bound
    // helper, so a stateful subsystem that adds a counter reintroduces this
    // exact bug and owns bounding it — at both ends, as here. If a third module
    // needs the same arithmetic, that is the point to extract the helper rather
    // than to write this comment a third time.
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new Error(
        `${where}: ${key} must be an integer between 0 and ` +
          `${String(Number.MAX_SAFE_INTEGER)}, got ${JSON.stringify(count)}. Past that, ` +
          `addition stops being exact and the counter would silently stop counting.`,
      );
    }
  }
  // Extra keys are refused for the reason the cartridge loader refuses them: a
  // field silently dropped on restore is one its author believes is in effect.
  const unknownKeys = Object.keys(record).filter(
    (key) => !counts.includes(key as (typeof counts)[number]),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${where}: unexpected field(s) ${unknownKeys.sort().join(", ")}; this slice holds ` +
        `${counts.join(", ")}`,
    );
  }

  return {
    events: record["events"] as number,
    values: record["values"] as number,
  };
}

export const PROBE_MODULE = defineEventModule<ProbeSlice>({
  namespace: "probe",
  description:
    "Diagnostics that draw from the seeded PRNG so a fixture can lock the generator itself.",
  initialSlice: () => ({ events: 0, values: 0 }),
  validateSlice: validateProbeSlice,
  events: {
    /** Raw draws, as hex uint32s or as the floats derived from them. */
    "probe.random": {
      version: 0,
      apply(context, slice) {
        const { payload, stream, count } = readProbeHead(context);
        const form = readString(payload, "form", context.where);
        if (form !== "uint32" && form !== "float") {
          throw new Error(`${context.where}: form must be "uint32" or "float"`);
        }

        const rendered: string[] = [];
        for (let index = 0; index < count; index += 1) {
          rendered.push(
            form === "uint32"
              ? hex32(stream.nextUint32())
              : String(stream.next()),
          );
        }

        return {
          slice: advanced(slice, count, context.where),
          summary: `stream=${stream.path} count=${String(count)} form=${form}`,
          detail: [
            ...chunkedLines(
              rendered,
              form === "uint32" ? UINT32_PER_LINE : FLOAT_PER_LINE,
            ),
            cursorLine(stream),
          ],
        };
      },
    },

    /** A histogram of `int(max)`, which is where rejection sampling shows up. */
    "probe.int": {
      version: 0,
      apply(context, slice) {
        const { payload, stream, count } = readProbeHead(context);
        const max = readInteger(
          payload,
          "max",
          1,
          MAX_PROBE_INT_BOUND,
          context.where,
        );

        const tally: number[] = [];
        for (let bucket = 0; bucket < max; bucket += 1) tally.push(0);
        for (let index = 0; index < count; index += 1) {
          const drawn = stream.int(max);
          tally[drawn] = (tally[drawn] ?? 0) + 1;
        }

        return {
          slice: advanced(slice, count, context.where),
          summary: `stream=${stream.path} count=${String(count)} max=${String(max)}`,
          detail: [
            ...tally.map(
              (hits, bucket) =>
                `${String(bucket).padStart(4, " ")}  ${String(hits).padStart(6, " ")}`,
            ),
            cursorLine(stream),
          ],
        };
      },
    },

    /** A distribution snapshot, zero-weight arms included. */
    "probe.weighted": {
      version: 0,
      apply(context, slice) {
        const { payload, stream, count } = readProbeHead(context);
        const entries = readWeightedEntries(payload, context.where);

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
          slice: advanced(slice, count, context.where),
          summary: `stream=${stream.path} count=${String(count)}`,
          detail: [
            ...entries.map(
              (entry) =>
                `${entry.value.padEnd(width, " ")}  weight=${String(entry.weight).padStart(6, " ")}  picks=${String(tally.get(entry.value) ?? 0).padStart(7, " ")}`,
            ),
            cursorLine(stream),
          ],
        };
      },
    },
  },
});
