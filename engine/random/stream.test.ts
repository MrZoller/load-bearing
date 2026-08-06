import { describe, expect, it } from "vitest";

import { serialize } from "../serialize/canonical.js";
import { UINT32_RANGE, hashString } from "./seed.js";
import {
  MAX_INT_RANGE,
  ROOT_LABEL,
  createRandom,
  restoreRandom,
} from "./stream.js";
import type { RandomState, RandomStream, WeightedEntry } from "./stream.js";

const SEED = "2026-08-05/0/deep-foundation";

function take(stream: RandomStream, count: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1)
    values.push(stream.nextUint32());
  return values;
}

describe("createRandom", () => {
  it("produces the same sequence for the same seed", () => {
    expect(take(createRandom(SEED), 32)).toEqual(take(createRandom(SEED), 32));
  });

  it("produces a different sequence for a different seed", () => {
    expect(take(createRandom(SEED), 8)).not.toEqual(
      take(createRandom("2026-08-06/0/deep-foundation"), 8),
    );
  });

  it("accepts a pre-hashed uint32 seed, equivalently to hashing the string", () => {
    expect(take(createRandom(hashString(SEED)), 8)).toEqual(
      take(createRandom(SEED), 8),
    );
  });

  it("rejects a numeric seed that is not a uint32", () => {
    for (const seed of [-1, 1.5, UINT32_RANGE, Number.NaN]) {
      expect(() => createRandom(seed)).toThrow(/seed must be an integer/);
    }
  });

  it("names the root stream", () => {
    const root = createRandom(SEED);
    expect(root.label).toBe(ROOT_LABEL);
    expect(root.path).toBe(ROOT_LABEL);
  });

  it("is pinned to specific values, because every fixture depends on them", () => {
    // mulberry32 over the FNV-1a seed. A change here re-rolls every recorded
    // session in the repository.
    expect(take(createRandom(SEED), 4)).toEqual([
      123609770, 2007029138, 1478351952, 112100095,
    ]);
  });
});

describe("next", () => {
  it("is the raw draw over 2^32", () => {
    const floats = createRandom(SEED);
    const raws = createRandom(SEED);
    for (let index = 0; index < 64; index += 1) {
      expect(floats.next()).toBe(raws.nextUint32() / UINT32_RANGE);
    }
  });

  it("stays inside [0, 1)", () => {
    const stream = createRandom(SEED);
    for (let index = 0; index < 10000; index += 1) {
      const value = stream.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("fork", () => {
  it("gives two labels independent streams", () => {
    const left = createRandom(SEED).fork("spinner.verbs");
    const right = createRandom(SEED).fork("rare-events");
    expect(take(left, 8)).not.toEqual(take(right, 8));
  });

  it("does not perturb a sibling — the reason sub-streams exist", () => {
    // Draw heavily from one stream, then check the other is untouched. This is
    // the property that stops a new draw in one subsystem invalidating every
    // unrelated fixture.
    const undisturbed = take(createRandom(SEED).fork("rare-events"), 8);

    const root = createRandom(SEED);
    take(root.fork("spinner.verbs"), 500);
    take(root, 500);

    expect(take(root.fork("rare-events"), 8)).toEqual(undisturbed);
  });

  it("is independent of when the fork happens", () => {
    const early = createRandom(SEED);
    const earlyChild = early.fork("pids");
    take(early, 100);

    const late = createRandom(SEED);
    take(late, 100);
    const lateChild = late.fork("pids");

    expect(take(earlyChild, 8)).toEqual(take(lateChild, 8));
  });

  it("returns the same stream for the same label, not a fresh one", () => {
    // Streams are named, so two handles to `pids` are two views of one
    // sequence — otherwise two subsystems drawing pids would issue the same
    // ones.
    const root = createRandom(SEED);
    const first = take(root.fork("pids"), 4);
    const second = take(root.fork("pids"), 4);
    expect(first).not.toEqual(second);

    const continuous = take(createRandom(SEED).fork("pids"), 8);
    expect([...first, ...second]).toEqual(continuous);
  });

  it("nests, and a nested path differs from the flattened spelling", () => {
    const nested = createRandom(SEED).fork("spinner").fork("verbs");
    expect(nested.path).toBe(`${ROOT_LABEL}/spinner/verbs`);
    expect(nested.label).toBe("verbs");
  });

  it("rejects labels that are not slugs, including embedded separators", () => {
    const root = createRandom(SEED);
    for (const label of ["", "a/b", "Spinner", "spinner verbs", ".lead"]) {
      expect(() => root.fork(label)).toThrow(/stream label must match/);
    }
  });
});

describe("int", () => {
  it("stays inside the range", () => {
    const stream = createRandom(SEED).fork("pids");
    for (let index = 0; index < 5000; index += 1) {
      const value = stream.int(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it("covers the whole range roughly evenly", () => {
    const stream = createRandom(SEED).fork("pids");
    const tally = new Map<number, number>();
    for (let index = 0; index < 70000; index += 1) {
      const bucket = stream.int(7);
      tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
    }
    for (let bucket = 0; bucket < 7; bucket += 1) {
      expect(tally.get(bucket)).toBeGreaterThan(9000);
      expect(tally.get(bucket)).toBeLessThan(11000);
    }
  });

  it("returns 0 for a range of one", () => {
    const stream = createRandom(SEED);
    expect(stream.int(1)).toBe(0);
  });

  it("handles the full uint32 range, where the rejection window is empty", () => {
    const stream = createRandom(SEED);
    const wide = createRandom(SEED);
    expect(stream.int(MAX_INT_RANGE)).toBe(wide.nextUint32());
  });

  it("rejects bounds outside [1, 2^32]", () => {
    const stream = createRandom(SEED);
    for (const bound of [0, -1, 1.5, MAX_INT_RANGE + 1, Number.NaN]) {
      expect(() => stream.int(bound)).toThrow(/int\(\) bound must be/);
    }
  });
});

describe("pick", () => {
  it("chooses elements from the array", () => {
    const stream = createRandom(SEED).fork("verbs");
    const values = ["excavating", "reinforcing", "surveying"];
    for (let index = 0; index < 100; index += 1) {
      expect(values).toContain(stream.pick(values));
    }
  });

  it("is int() applied to the length", () => {
    const values = ["a", "b", "c", "d", "e"];
    const picking = createRandom(SEED);
    const indexing = createRandom(SEED);
    for (let index = 0; index < 32; index += 1) {
      expect(picking.pick(values)).toBe(values[indexing.int(values.length)]);
    }
  });

  it("rejects an empty array", () => {
    expect(() => createRandom(SEED).pick([])).toThrow(
      /pick\(\) from an empty array/,
    );
  });

  it("rejects a hole in a sparse array rather than returning undefined", () => {
    const sparse = new Array<string>(4);
    expect(() => createRandom(SEED).pick(sparse)).toThrow(/sparse array/);
  });
});

describe("weightedPick", () => {
  const entries: readonly WeightedEntry<string>[] = [
    { value: "never", weight: 0 },
    { value: "rare", weight: 1 },
    { value: "common", weight: 99 },
  ];

  it("respects the weights", () => {
    const stream = createRandom(SEED).fork("rare-events");
    const tally = new Map<string, number>([
      ["never", 0],
      ["rare", 0],
      ["common", 0],
    ]);
    for (let index = 0; index < 100000; index += 1) {
      const picked = stream.weightedPick(entries);
      tally.set(picked, (tally.get(picked) ?? 0) + 1);
    }

    expect(tally.get("never")).toBe(0);
    expect(tally.get("rare")).toBeGreaterThan(700);
    expect(tally.get("rare")).toBeLessThan(1300);
    expect(tally.get("common")).toBeGreaterThan(98000);
  });

  it("never returns a zero-weight entry, even as the only survivor", () => {
    const stream = createRandom(SEED);
    for (let index = 0; index < 200; index += 1) {
      expect(
        stream.weightedPick([
          { value: "off", weight: 0 },
          { value: "on", weight: 1 },
        ]),
      ).toBe("on");
    }
  });

  it("depends on entry order, which is therefore part of the contract", () => {
    const pair: readonly WeightedEntry<string>[] = [
      { value: "left", weight: 1 },
      { value: "right", weight: 1 },
    ];
    const straight = createRandom(SEED);
    const reversed = createRandom(SEED);

    const forwards: string[] = [];
    const backwards: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      forwards.push(straight.weightedPick(pair));
      backwards.push(reversed.weightedPick([...pair].reverse()));
    }

    // Same rolls, mirrored outcomes: reordering the list is a content change,
    // not a formatting one.
    expect(backwards).toEqual(
      forwards.map((value) => (value === "left" ? "right" : "left")),
    );
  });

  it("rejects an empty list", () => {
    expect(() => createRandom(SEED).weightedPick([])).toThrow(
      /weightedPick\(\) from an empty list/,
    );
  });

  it("rejects weights that are not non-negative integers", () => {
    for (const weight of [-1, 0.5, Number.NaN]) {
      expect(() =>
        createRandom(SEED).weightedPick([{ value: "x", weight }]),
      ).toThrow(/weight 0 must be a non-negative integer/);
    }
  });

  it("rejects a list that can never select anything", () => {
    expect(() =>
      createRandom(SEED).weightedPick([
        { value: "a", weight: 0 },
        { value: "b", weight: 0 },
      ]),
    ).toThrow(/weights must total between 1/);
  });
});

describe("state", () => {
  it("records only streams that were drawn from", () => {
    const root = createRandom(SEED);
    root.fork("untouched");
    take(root.fork("used"), 3);

    expect(Object.keys(root.toState().cursors)).toEqual([`${ROOT_LABEL}/used`]);
  });

  it("reports the whole tree from any handle", () => {
    const root = createRandom(SEED);
    const child = root.fork("child");
    take(root, 1);
    take(child, 1);

    expect(child.toState()).toEqual(root.toState());
  });

  it("round-trips byte-identically through the canonical serializer", () => {
    const root = createRandom(SEED);
    take(root.fork("spinner.verbs"), 17);
    take(root.fork("rare-events"), 3);
    take(root, 5);

    const recorded = serialize(root.toState());
    expect(serialize(restoreRandom(root.toState()).toState())).toBe(recorded);
  });

  it("restores every stream to exactly where it stopped", () => {
    // Two independent runs advanced identically. One is snapshotted and
    // restored before continuing; the other just continues. Building both from
    // scratch is what keeps the expectation from being read off the same
    // object under test.
    function advanced(): RandomStream {
      const stream = createRandom(SEED);
      take(stream, 4);
      take(stream.fork("spinner.verbs"), 9);
      return stream;
    }

    const control = advanced();
    const restored = restoreRandom(advanced().toState());

    expect([
      ...take(restored, 4),
      ...take(restored.fork("spinner.verbs"), 4),
    ]).toEqual([
      ...take(control, 4),
      ...take(control.fork("spinner.verbs"), 4),
    ]);
  });

  it("continues an untouched stream from its derived position", () => {
    const fresh = createRandom(SEED);
    take(fresh, 3);
    const restored = restoreRandom(fresh.toState());

    expect(take(restored.fork("never-used"), 4)).toEqual(
      take(createRandom(SEED).fork("never-used"), 4),
    );
  });

  it("rejects state that would replay differently than it was recorded", () => {
    const valid = createRandom(SEED);
    take(valid.fork("pids"), 1);
    const state = valid.toState();

    expect(() => restoreRandom({ ...state, seed: -1 })).toThrow(
      /seed must be an integer/,
    );
    expect(() =>
      restoreRandom({ ...state, cursors: { [`${ROOT_LABEL}/pids`]: 1.5 } }),
    ).toThrow(/cursor for/);
    expect(() =>
      restoreRandom({ ...state, cursors: { "pids/extra": 1 } }),
    ).toThrow(/must start with/);
    expect(() =>
      restoreRandom({ ...state, cursors: { [`${ROOT_LABEL}/Pids`]: 1 } }),
    ).toThrow(/stream label must match/);
  });

  it("reports a missing or wrongly-shaped cursors map as such", () => {
    // JSON from a fixture or a permalink can be any shape at all, so the
    // domain error has to come before anything dereferences it.
    for (const cursors of [undefined, null, [], "root/pids=1"]) {
      expect(() =>
        restoreRandom({ seed: 1, cursors } as unknown as RandomState),
      ).toThrow(/cursors must be an object/);
    }
  });
});
