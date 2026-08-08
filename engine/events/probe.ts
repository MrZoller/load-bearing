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

function advanced(slice: ProbeSlice, values: number): ProbeSlice {
  return { events: slice.events + 1, values: slice.values + values };
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
  return items.map((item, index) => {
    const scope = `${where} entry ${String(index)}`;
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

    return {
      value,
      weight: readInteger(entry, "weight", 0, MAX_PROBE_WEIGHT, scope),
    };
  });
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
    // `isSafeInteger`, not `isInteger`: at 2^53 the counter stops counting.
    // `2**53 + 1` is not representable, so `events + 1` returns `events`
    // unchanged and `values + 3` lands 4 away — corruption that survives
    // re-serialization and looks like an ordinary integer. This is the last
    // unbounded counter on the snapshot path; the clock is bounded by
    // `MAX_EPOCH_MS`, cursors by `assertUint32`, payload integers by explicit
    // bounds in `readInteger`, and `eventCount` by the transcript-length check.
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new Error(
        `${where}: ${key} must be a non-negative integer below 2^53, got ${JSON.stringify(count)}`,
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
          slice: advanced(slice, count),
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
          slice: advanced(slice, count),
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
          slice: advanced(slice, count),
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
