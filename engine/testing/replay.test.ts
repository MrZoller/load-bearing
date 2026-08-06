import { describe, expect, it } from "vitest";

import {
  listReplayFixtures,
  loadReplayFixture,
  loadReplayRecording,
  parseReplayFixture,
} from "./fixtures.js";
import { compareRecording, replayFixture } from "./replay.js";

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

  it.each(FIXTURES)("%s replays identically twice in a row", (name) => {
    const fixture = loadReplayFixture(name);

    // Guards against hidden state: memoization, a module-level accumulator, a
    // lazily initialized cache. Reducing the same log twice must be observably
    // the same operation.
    expect(replayFixture(fixture)).toEqual(replayFixture(fixture));
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
});
