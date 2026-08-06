import { describe, expect, it, vi } from "vitest";

import {
  listReplayFixtures,
  loadReplayFixture,
  loadReplayRecording,
  parseReplayFixture,
} from "./fixtures.js";
import { compareRecording, replayFixture } from "./replay.js";
import { serialize } from "../serialize/canonical.js";

const FIXTURES = listReplayFixtures();

describe("golden replay fixtures", () => {
  it("has fixtures to replay", () => {
    // A suite that silently found nothing would pass forever while proving
    // nothing, which is the failure mode this whole harness exists to prevent.
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES)("%s replays byte-identically", (name) => {
    const replayed = replayFixture(loadReplayFixture(name));

    const mismatch = compareRecording(
      name,
      loadReplayRecording(name),
      replayed,
    );
    if (mismatch !== undefined) throw new Error(mismatch);
  });

  it.each(FIXTURES)(
    "%s replays identically from a fresh input and a fresh module",
    async (name) => {
      // Both halves of the isolation matter, and for different reasons.
      //
      // Separately loaded fixtures, because passing one object to both calls
      // would let a reducer that mutates its input on first use still compare
      // equal, and bless the mutation as the baseline.
      //
      // Separately loaded *modules*, because by the time this test runs the
      // engine has already been invoked — so comparing two more calls would
      // compare the second against the third. Module-level state that changes
      // behaviour on first invocation and then settles would survive that.
      // `resetModules` makes each side a first invocation.
      vi.resetModules();
      const first = (await import("./replay.js")).replayFixture(
        loadReplayFixture(name),
      );

      vi.resetModules();
      const second = (await import("./replay.js")).replayFixture(
        loadReplayFixture(name),
      );

      expect(first).toEqual(second);
    },
  );

  it.each(FIXTURES)("%s leaves its input untouched", (name) => {
    const fixture = loadReplayFixture(name);
    const before = serialize(fixture as unknown);

    replayFixture(fixture);

    // The cartridge is loaded once per session and reused, so a reducer that
    // edited it in place would have a later session start from altered state.
    expect(serialize(fixture as unknown)).toBe(before);
  });
});

describe("compareRecording", () => {
  const recorded = {
    state: '{\n  "a": 1\n}\n',
    transcript: "0000  session.start\n",
  };

  it("returns nothing when both artifacts match", () => {
    expect(
      compareRecording("sample", recorded, { ...recorded }),
    ).toBeUndefined();
  });

  it("fails on a single changed byte, and says where", () => {
    const message = compareRecording("sample", recorded, {
      ...recorded,
      state: '{\n  "a": 2\n}\n',
    });

    expect(message).toContain("sample/state.json does not match its recording");
    expect(message).toContain("first difference at line 2");
    expect(message).toContain('- 2 |   "a": 1');
    expect(message).toContain('+ 2 |   "a": 2');
    expect(message).toContain("npm run fixtures:update");
  });

  it("reports a transcript mismatch too", () => {
    const message = compareRecording("sample", recorded, {
      ...recorded,
      transcript: "0000  session.begin\n",
    });

    expect(message).toContain(
      "sample/transcript.txt does not match its recording",
    );
  });
});

describe("fixture loading", () => {
  it("rejects a fixture whose name disagrees with its directory", () => {
    expect(() => loadReplayFixture("no-such-fixture")).toThrow();
  });

  it("names the re-record command when a recording is missing", () => {
    expect(() => loadReplayRecording("no-such-fixture")).toThrow(
      /fixtures:update/,
    );
  });

  it("shape-checks every event, so a typo cannot become a green baseline", () => {
    // An event saying `kind` instead of `type` replays with type undefined,
    // and `fixtures:update` would then record that as the expected transcript.
    const withEvents = (events: unknown[]) => ({
      name: "sample",
      description: "sample",
      seed: "sample",
      cartridge: null,
      events,
    });

    for (const bad of [{ kind: "session.start" }, { type: 42 }, null, ["x"]]) {
      expect(() =>
        parseReplayFixture(
          withEvents([{ type: "session.start" }, bad]),
          "sample",
        ),
      ).toThrow(/events\[1\]/);
    }

    expect(() =>
      parseReplayFixture(withEvents([{ type: "session.start" }]), "sample"),
    ).not.toThrow();
  });

  it("rejects a fixture that is not an object, or is missing a field", () => {
    expect(() => parseReplayFixture([], "sample")).toThrow(/JSON object/);
    expect(() => parseReplayFixture({ name: "sample" }, "sample")).toThrow(
      /"description" must be a string/,
    );
  });

  it("rejects a control character in an event type", () => {
    // The transcript is one line per entry joined with LF, so a type carrying
    // a newline would render one event as several lines, and `fixtures:update`
    // would bless that as the baseline.
    const withType = (type: string) => ({
      name: "sample",
      description: "d",
      seed: "s",
      cartridge: null,
      events: [{ type }],
    });

    expect(() => parseReplayFixture(withType("a\nb"), "sample")).toThrow(
      /control character/,
    );
    expect(() => parseReplayFixture(withType("a\rb"), "sample")).toThrow(
      /control character/,
    );
    expect(() =>
      parseReplayFixture(withType("shell.exec"), "sample"),
    ).not.toThrow();
  });

  it("requires a cartridge key, which may be null but may not be absent", () => {
    // Without this, a misspelled key replays as `cartridge: undefined`, the
    // serializer drops the undefined property, and `fixtures:update` records a
    // green baseline for two thirds of the input triple.
    const fields = { name: "sample", description: "d", seed: "s", events: [] };

    expect(() => parseReplayFixture(fields, "sample")).toThrow(
      /"cartridge" is required/,
    );
    expect(() =>
      parseReplayFixture({ ...fields, cartridge: null }, "sample"),
    ).not.toThrow();
  });
});
