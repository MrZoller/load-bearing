import { describe, expect, it, vi } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import type { LoadedCartridge } from "../cartridge/types.js";
import { readAgentSlice } from "../agent/agent.js";
import { restoreSnapshot, snapshot, step } from "../events/reduce.js";
import { findWaiverConsent, readMindSlice } from "../mind/mind.js";
import { readStorySlice } from "../story/story.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { lookupProcess, lookupService, readWorldLog } from "../world/world.js";

import {
  type CartridgeReference,
  listReplayFixtures,
  loadReplayFixture,
  loadReplayRecording,
  parseReplayFixture,
} from "./fixtures.js";
import { compareRecording, replayFixture } from "./replay.js";
import { deserialize, serialize } from "../serialize/canonical.js";

const FIXTURES = listReplayFixtures();

/**
 * Freeze a value and everything reachable from it.
 *
 * Under strict mode — which every module is — writing to a frozen object
 * throws, so an in-place edit fails loudly at the point it happens instead of
 * being inferred afterwards from a serialized comparison.
 */
function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Stand-in for the disk resolver `fixtures.ts` supplies.
 *
 * These tests are about `fixture.json`'s own shape, so the cartridge it names
 * is resolved to a marker rather than a real world — the loader has its own
 * tests, and pulling one in here would make a fixture-shape failure look like
 * a cartridge failure.
 */
const RESOLVE_CARTRIDGE = (reference: CartridgeReference) => ({
  resolved: reference,
});

describe("golden replay fixtures", () => {
  it("declares the Incident #001 load-balancer shell evidence without needing a recording", () => {
    const fixture = loadReplayFixture("021-incident-001-load-balancer");

    expect(fixture.cartridgeName).toBe("incident-001");
    expect(fixture.events.map((event) => event.payload?.["input"])).toEqual([
      "npm test",
      "curl http://load-balancer.internal/health",
      "rm config/routes.conf",
      "cp -p config/routes.200.conf config/routes.conf",
      "npm test",
      "curl http://load-balancer.internal/health",
      "rm config/routes.conf",
      "cp -p config/routes.500.conf config/routes.conf",
      "npm test",
      "curl http://load-balancer.internal/health",
    ]);
  });

  it("records the Bash-only policy clue and reversible rm plus cp -p repair without story state", () => {
    const fixture = loadReplayFixture("030-incident-001-bash-clue-repair");
    const recording = replayFixture(fixture);
    const state = restoreSnapshot(recording.state);
    const policy = readVfs(
      readVfsSlice(state),
      "/var/lib/regional-router/.regional-policy",
    );

    expect(fixture.events.map((event) => event.payload?.["input"])).toEqual(
      expect.arrayContaining([
        "ls -la /var/lib/regional-router",
        "cat /var/lib/regional-router/.regional-policy",
        "rm config/routes.conf",
        "cp -p config/routes.200.conf config/routes.conf",
        "rm config/routes.conf",
        "cp -p config/routes.500.conf config/routes.conf",
        "pwd",
      ]),
    );
    expect(policy).toMatchObject({
      value: {
        contents: expect.stringContaining("health_success=detach:europe"),
      },
    });
    expect(
      readVfs(
        readVfsSlice(state),
        "/production/load-balancer/config/routes.conf",
      ),
    ).toMatchObject({
      value: { contents: "health_status=500\neurope_attached=true\n" },
    });
    expect(
      lookupService(readWorldSlice(state), "endpoint-responder"),
    ).toMatchObject({ state: "stopped", health: "unknown" });
    expect(readStorySlice(state)).toMatchObject({
      facts: [],
      discoveredEndings: [],
    });
    expect(recording.transcript).toContain("HTTP/1.1 200 OK");
    expect(recording.transcript).toContain(
      "HTTP/1.1 500 Internal Server Error",
    );
    expect(recording.transcript).toContain(
      "Access: (0644/-rw-r--r--)  Uid: (root)   Gid: (operators)",
    );
    expect(recording.transcript).toContain("stdout> /production/load-balancer");
  });

  it("records the full session's cross-subsystem consequences", () => {
    const recording = replayFixture(loadReplayFixture("014-full-session"));
    const state = deserialize(recording.state) as Record<string, unknown>;
    const slices = state["slices"] as Record<string, Record<string, unknown>>;
    const vfs = slices["vfs"] as Record<string, unknown>;
    const entries = vfs["entries"] as Record<string, unknown>;
    const git = slices["git"] as Record<string, unknown>;
    const mind = slices["mind"] as Record<string, unknown>;
    const world = slices["world"] as Record<string, unknown>;

    // The edit triggers services and a process, while checkout restores the
    // tracked file. The belief deliberately retains the earlier observation.
    expect(entries["/production/service/src/ready.stale"]).toMatchObject({
      kind: "file",
      contents: "remove me\n",
    });
    expect(git["head"]).toEqual({ kind: "branch", target: "main" });
    expect(world["services"]).toMatchObject([
      { id: "api", state: "running", health: "healthy" },
    ]);
    expect(world["processes"]).toMatchObject([
      { id: "worker", state: "running" },
    ]);
    expect(mind["permissions"]).toMatchObject([{ decision: "always-allow" }]);
    expect(mind["beliefs"]).toMatchObject([
      { kind: "service-health", service: "api", health: "unknown" },
    ]);
    expect(recording.transcript).toContain("tests.run exit=1");
    expect(recording.transcript).toContain("tests.run exit=0");
    expect(recording.transcript).toContain("git.status paths=1");
    expect(recording.transcript).toContain("git.restore");
  });

  it("records one outer story event while its consequence atomically spans story, VFS, and world owners", () => {
    const recording = replayFixture(
      loadReplayFixture("022-story-consequences"),
    );
    const state = restoreSnapshot(recording.state);
    const world = readWorldSlice(state);

    expect(readStorySlice(state).counters).toEqual([
      { id: "attempts", value: 1 },
    ]);
    expect(readVfs(readVfsSlice(state), "/etc/motd")).toMatchObject({
      value: { contents: "changed\n" },
    });
    expect(lookupService(world, "api")).toMatchObject({
      state: "stopped",
      health: "degraded",
    });
    expect(lookupProcess(world, "worker")).toMatchObject({ state: "stopped" });
    expect(readWorldLog(world, readVfsSlice(state), "story-log")).toEqual({
      ok: true,
      entries: ["started", "consequence"],
    });
    expect(state.eventCount).toBe(1);
    expect(state.transcript).toHaveLength(1);
    expect(recording.transcript).toContain("story.beat-reached beat=start");
  });

  it("records pending permission resolution at its simulated instant", () => {
    const recording = replayFixture(
      loadReplayFixture("019-pending-permissions"),
    );
    const state = deserialize(recording.state) as Record<string, unknown>;
    const slices = state["slices"] as Record<string, Record<string, unknown>>;
    const mind = slices["mind"];

    expect(mind).toMatchObject({
      pendingPermission: null,
      permissions: [
        {
          capability: {
            kind: "exact",
            action: "delete",
            resource: "/production/service/src/index.ts",
          },
          decision: "always-allow",
          at: "2026-08-05T09:14:22.019Z",
        },
      ],
    });
    expect(recording.transcript).toContain(
      "2026-08-05T09:14:22.019Z  mind.permission-resolved",
    );
  });

  it("records atomic permission branches and exact waiver consent without widening either ledger", () => {
    const recording = replayFixture(
      loadReplayFixture("023-atomic-permission-continuations"),
    );
    const state = restoreSnapshot(recording.state);
    const mind = readMindSlice(state);

    expect(mind.permissions.map(({ decision }) => decision)).toEqual([
      "grant",
      "deny",
      "always-allow",
    ]);
    expect(mind.waiverConsents).toEqual([
      expect.objectContaining({
        id: "write-ready-waiver",
        version: 1,
        phrase: "I agree",
        at: "2026-08-22T09:14:22.034Z",
      }),
    ]);
    expect(
      readVfs(readVfsSlice(state), "/production/service/WAIVER.md"),
    ).toMatchObject({
      value: { contents: expect.stringContaining("I agree") },
    });
    expect(
      readVfs(readVfsSlice(state), "/production/service/src/ready.stale"),
    ).toMatchObject({ value: { contents: "waiver accepted\n" } });
    expect(recording.transcript).not.toContain("mind.permission-choice");
    expect(recording.transcript).not.toContain("mind.waiver-choice");
  });

  it("records a rare draw only after the completing shell expansion, and never rerolls it", () => {
    const recording = replayFixture(loadReplayFixture("026-rare-events"));
    const state = restoreSnapshot(recording.state);

    expect(readStorySlice(state).rareEvents).toEqual([
      expect.objectContaining({
        id: "missing-evidence",
        evaluated: true,
        fired: false,
      }),
    ]);
    expect(Object.keys(state.random.cursors)).toContain(
      "root/story/rare-events/missing-evidence",
    );
    expect(recording.transcript).toContain(
      'vfs.delete path="/srv/app/evidence.txt" removed=1',
    );
    expect(recording.transcript.match(/shell\.result/g)).toHaveLength(2);
  });

  it("pins four same-seed persona outcomes over one shared beat identity", () => {
    const recording = replayFixture(
      loadReplayFixture("024-sparse-persona-routes"),
    );
    const state = restoreSnapshot(recording.state);

    expect(readStorySlice(state).currentBeat).toBe("shared");
    expect(
      readAgentSlice(state).responses.map((response) => response.responseId),
    ).toEqual(["paranoid", "reckless", "superficial", "existential"]);
  });

  it("records Incident #001's four same-seed voices as distinct transcripts over one unchanged machine", () => {
    const fixtures = [
      "031-incident-001-deep-foundation-voices",
      "032-incident-001-temporary-shoring-voices",
      "033-incident-001-drywall-voices",
      "034-incident-001-cantilever-voices",
    ].map((name) => loadReplayFixture(name));
    const recordings = fixtures.map((fixture) => replayFixture(fixture));
    const states = recordings.map(({ state }) => restoreSnapshot(state));
    const first = states[0];
    if (first === undefined)
      throw new Error("four voice fixtures are required");

    expect(new Set(recordings.map(({ transcript }) => transcript)).size).toBe(
      4,
    );
    const responseTexts = states.map((state, index) => {
      const fixture = fixtures[index];
      if (fixture === undefined)
        throw new Error("four voice fixtures are required");
      const cartridge = loadCartridge(fixture.cartridge);
      return readAgentSlice(state).responses.map(({ responseId }) => {
        const response = cartridge.story.responses.find(
          (candidate) => candidate.id === responseId,
        );
        if (response === undefined)
          throw new Error(`Incident #001 is missing response ${responseId}`);
        return response.text;
      });
    });
    expect(
      new Set(responseTexts.map((texts) => JSON.stringify(texts))).size,
    ).toBe(4);
    expect(readStorySlice(first)).toEqual({
      stage: 0,
      currentBeat: "load-bearing-declaration",
      currentVariant: "preserved-load-bearing-response",
      facts: [{ id: "callback-load-bearing-response", kind: "callback" }],
      counters: [
        { id: "flail", value: 0 },
        { id: "capitulation", value: 0 },
      ],
      rareEvents: [],
      discoveredEndings: ["load-bearing-response"],
    });
    for (const state of states.slice(1)) {
      expect(readStorySlice(state)).toEqual(readStorySlice(first));
      expect(state.slices["git"]).toEqual(first.slices["git"]);
      expect(readVfsSlice(state)).toEqual(readVfsSlice(first));
      expect(readWorldSlice(state)).toEqual(readWorldSlice(first));
    }
  });

  it("records Incident #001's shared story outcome, waiver ledger, and resumable canonical snapshot", () => {
    const fixture = loadReplayFixture("020-incident-001-story");
    const recording = replayFixture(fixture);
    const state = restoreSnapshot(recording.state);

    // The fact event precedes the condition-selected callback. Their order is
    // story state, not transcript decoration, and the ending remains a
    // discovery rather than a terminal session state.
    expect(readStorySlice(state)).toEqual({
      stage: 1,
      currentBeat: "load-bearing-declaration",
      currentVariant: "preserved-load-bearing-response",
      facts: [
        { id: "bash-regional-detachment", kind: "reveal" },
        { id: "callback-load-bearing-response", kind: "callback" },
      ],
      counters: [
        { id: "flail", value: 0 },
        { id: "capitulation", value: 0 },
      ],
      rareEvents: [],
      discoveredEndings: ["load-bearing-response"],
    });
    expect(
      findWaiverConsent(readMindSlice(state), {
        id: "regional-fail-open",
        version: 1,
        phrase: "I agree",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
      }),
    ).toEqual({
      id: "regional-fail-open",
      version: 1,
      phrase: "I agree",
      capability: {
        kind: "exact",
        action: "detach-region",
        resource: "/regions/europe",
      },
      at: "2026-08-22T09:14:22.000Z",
    });
    expect(snapshot(state)).toBe(recording.state);

    const continued = step(state, {
      type: "agent.message-added",
      payload: { id: "turn-4", text: "keep investigating" },
    });
    expect(readStorySlice(continued)).toEqual(readStorySlice(state));
  });

  it("records Incident #001's world evidence without duplicate reactions across copy, write, and replacement", () => {
    const recording = replayFixture(
      loadReplayFixture("028-incident-001-world-evidence"),
    );
    const state = restoreSnapshot(recording.state);
    const world = readWorldSlice(state);

    expect(lookupService(world, "endpoint-responder")).toMatchObject({
      state: "stopped",
      health: "unknown",
      ports: [8080],
    });
    expect(lookupService(world, "regional-router")).toMatchObject({
      state: "running",
      health: "healthy",
      ports: [443],
    });
    expect(lookupProcess(world, "endpoint-responder")).toMatchObject({
      pid: 1842,
      state: "stopped",
    });
    expect(
      readWorldLog(world, readVfsSlice(state), "health-check-log"),
    ).toEqual({
      ok: true,
      entries: [
        "health endpoint serving 500; Europe remains attached",
        "regional router healthy",
        "health endpoint serving 200; Europe detached",
        "health endpoint serving 500; Europe reattached",
        "health endpoint serving 200; Europe detached",
        "health endpoint serving 500; Europe reattached",
      ],
    });
    expect(
      readWorldLog(world, readVfsSlice(state), "regional-routing-events"),
    ).toEqual({
      ok: true,
      entries: [
        "health status 500 retained; Europe attached",
        "regional router healthy",
        "regional router unhealthy after Europe detached",
        "regional router healthy after Europe reattached",
        "regional router unhealthy after Europe detached",
        "regional router healthy after Europe reattached",
      ],
    });
    expect(recording.transcript.match(/tests\.run exit=/g)).toHaveLength(3);
    expect(recording.transcript).toContain("HTTP/1.1 200 OK");
    expect(recording.transcript).toContain(
      "HTTP/1.1 500 Internal Server Error",
    );
    expect(recording.transcript).toContain("vfs.write path=");
    expect(recording.transcript).toContain(
      "git.checkout head=branch:greg/healthcheck-repair",
    );
    expect(recording.transcript).toContain("git.checkout head=branch:main");
    expect(recording.transcript).not.toContain(
      "git.checkout failed code=DIRTY",
    );
  });

  it("records Incident #001's environmental clues as static evidence through repair and undo", () => {
    const recording = replayFixture(
      loadReplayFixture("029-incident-001-environment"),
    );
    const state = restoreSnapshot(recording.state);
    const world = readWorldSlice(state);
    const policy = readVfs(
      readVfsSlice(state),
      "/var/lib/regional-router/.regional-policy",
    );

    expect(world.env).toMatchObject({
      HEALTH_SUCCESS_EFFECT: "detach-regional-route",
      REGIONAL_FAIL_MODE: "retain",
      ROUTING_POLICY_OWNER: "greg@departed",
      TICKET_ARCHIVE_COMMAND: "ops-archive",
    });
    expect(world.manPages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "regional-router", section: "8" }),
        expect.objectContaining({ name: "routes.conf", section: "5" }),
      ]),
    );
    expect(world.tickets).toEqual([
      expect.objectContaining({ id: "OPS-1842", service: "regional-router" }),
      expect.objectContaining({ id: "OPS-1911", service: "regional-router" }),
    ]);
    expect(policy).toEqual({
      ok: true,
      value: {
        path: "/var/lib/regional-router/.regional-policy",
        contents:
          "policy_revision=3\nhealth_success=detach:europe\nhealth_failure=retain:europe\nowner=greg\nownership_status=departed\n",
      },
    });
    expect(recording.transcript.match(/OPS-1842/g)).toHaveLength(3);
    expect(
      world.shellHistory.filter((input) => input === "ops-archive"),
    ).toHaveLength(4);
  });

  it("keeps the production fixture's one shared story state when a different model starts", () => {
    const fixture = loadReplayFixture("020-incident-001-story");
    const source = deserialize(serialize(fixture.cartridge)) as Record<
      string,
      unknown
    >;
    const models = source["models"];
    if (!Array.isArray(models) || models.length < 2)
      throw new Error("Incident #001 fixture requires at least two models");
    const first = models[0];
    const second = models[1];
    if (first === undefined || second === undefined)
      throw new Error("Incident #001 fixture models must be dense");
    const alternateCartridge = loadCartridge({
      ...source,
      models: [second, first, ...models.slice(2)],
    });
    const baseline = restoreSnapshot(replayFixture(fixture).state);
    const alternate = restoreSnapshot(
      replayFixture(fixture, alternateCartridge).state,
    );

    expect(baseline.slices["terminal"]).toMatchObject({
      activeModel: "deep-foundation",
    });
    expect(alternate.slices["terminal"]).toMatchObject({
      activeModel: "temporary-shoring",
    });
    expect(readStorySlice(alternate)).toEqual(readStorySlice(baseline));
  });

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
      const freshModule = await import("./replay.js");
      const second = freshModule.replayFixture(loadReplayFixture(name));

      expect(first).toEqual(second);

      // And a consecutive call inside the *same* graph. Two first calls of
      // separate graphs agree even when a reducer counts its invocations, so
      // that comparison alone would miss `let calls = 0` — the case where
      // replaying the same fixture twice in one session produces different
      // bytes.
      const third = freshModule.replayFixture(loadReplayFixture(name));

      expect(third).toEqual(second);

      // And twice with the *same* objects — fixture *and* loaded cartridge.
      // A reducer that remembers input identities in a WeakMap, which the gate
      // allows, would answer identically to two separately loaded cartridges
      // while behaving differently in production, where a session loads once
      // and reuses it. Passing the cartridge explicitly is what makes this
      // branch test identity at all: `replayFixture` loads per call by
      // default, so every other call above holds a fresh one.
      const shared = loadReplayFixture(name);
      const sharedCartridge = deepFreeze(
        loadCartridge(shared.cartridge),
      ) as LoadedCartridge;
      const sharedFirst = freshModule.replayFixture(shared, sharedCartridge);

      // Drained between the two, so a mutation deferred to a microtask has
      // landed before the second call reads it. The gate bans asynchrony in
      // engine sources, and this is the assertion that would notice if that
      // ban were ever lifted or evaded.
      await Promise.resolve();

      expect(freshModule.replayFixture(shared, sharedCartridge)).toEqual(
        sharedFirst,
      );

      // And against the committed recording. Everything above compares
      // isolated output with isolated output, which agrees even when module
      // state carried over from an *earlier fixture* — the recorder walks the
      // same sorted list this suite does, so contamination would be baked into
      // the artifact and reproduced from it. Only the recording is outside
      // that shared history.
      const mismatch = compareRecording(name, loadReplayRecording(name), first);
      if (mismatch !== undefined) throw new Error(mismatch);
    },
  );

  it.each(FIXTURES)("%s leaves its input untouched", (name) => {
    const fixture = loadReplayFixture(name);
    const before = serialize(fixture as unknown);

    // The *loaded* cartridge is what a reducer actually holds, and it has to
    // be frozen and passed explicitly: `replayFixture` loads a fresh one per
    // call by default, so freezing the raw fixture alone leaves the object
    // under test mutable and unexamined.
    const cartridge = deepFreeze(
      loadCartridge(fixture.cartridge),
    ) as LoadedCartridge;
    const cartridgeBefore = serialize(cartridge);

    // Frozen as well as compared, because the comparison alone cannot see
    // every edit: `serialize` drops undefined-valued properties by JSON
    // convention, so `cartridge.touched = undefined` would add an own property
    // observable to a later session and still compare equal. Freezing makes
    // the assignment itself throw — modules are strict mode.
    replayFixture(deepFreeze(fixture) as typeof fixture, cartridge);

    // The cartridge is loaded once per session and reused, so a reducer that
    // edited it in place would have a later session start from altered state.
    expect(serialize(fixture as unknown)).toBe(before);
    expect(serialize(cartridge)).toBe(cartridgeBefore);
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

  it("reads recordings without normalizing their bytes", () => {
    // Two failures the decoder configuration exists to prevent, both of which
    // would make the harness report byte identity it had not checked: a
    // malformed sequence becoming U+FFFD, and a leading BOM being consumed.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

    expect(decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
    expect(() => decoder.decode(new Uint8Array([0xff, 0xfe]))).toThrow();

    // The lenient default silently does both.
    const lenient = new TextDecoder("utf-8");
    expect(lenient.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(lenient.decode(new Uint8Array([0xff, 0xfe]))).toContain("�");
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
      cartridge: "minimal",
      events,
    });

    for (const bad of [{ kind: "session.start" }, { type: 42 }, null, ["x"]]) {
      expect(() =>
        parseReplayFixture(
          withEvents([{ type: "session.start" }, bad]),
          "sample",
          "sample",
          RESOLVE_CARTRIDGE,
        ),
      ).toThrow(/events\[1\]/);
    }

    expect(() =>
      parseReplayFixture(
        withEvents([{ type: "session.start" }]),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).not.toThrow();
  });

  it("rejects a fixture whose JSON repeats a key", async () => {
    // JSON.parse keeps the last value silently, so the file would show one
    // scenario to a reader while CI exercised another — and the recording
    // that results is green and wrong.
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const root = new URL(
      "../__fixtures__/replay/000-duplicate-key/",
      import.meta.url,
    );
    const dir = root.pathname;

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}fixture.json`,
      '{"name":"000-duplicate-key","description":"d","seed":"s","cartridge":null,"events":[],"seed":"other"}\n',
    );

    try {
      expect(() => loadReplayFixture("000-duplicate-key")).toThrow(
        /duplicate key "seed"/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a fixture that is not an object, or is missing a field", () => {
    expect(() =>
      parseReplayFixture([], "sample", "sample", RESOLVE_CARTRIDGE),
    ).toThrow(/JSON object/);
    expect(() =>
      parseReplayFixture(
        { name: "sample" },
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/"description" must be a string/);
  });

  it("rejects an unpaired surrogate in an event type", () => {
    // JSON permits "\ud800", but writing it as UTF-8 substitutes U+FFFD, so
    // the recording would not hold what replay produced and no re-record could
    // ever make the byte-identity test pass.
    const withType = (type: string) => ({
      name: "sample",
      description: "d",
      seed: "s",
      cartridge: "minimal",
      events: [{ type }],
    });

    expect(() =>
      parseReplayFixture(
        withType("a\ud800b"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/unpaired surrogate/);
    expect(() =>
      parseReplayFixture(
        withType("a\udc00"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/unpaired surrogate/);
    // A correctly paired astral character is fine.
    expect(() =>
      parseReplayFixture(
        withType("shell.exec.\u{1f9f1}"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).not.toThrow();
  });

  it("rejects a payload that is not an object", () => {
    // EngineEvent declares payload a record when present; casting past that at
    // the disk boundary hands a reducer a value the type system promised.
    const withPayload = (payload: unknown) => ({
      name: "sample",
      description: "d",
      seed: "s",
      cartridge: "minimal",
      events: [{ type: "shell.exec", payload }],
    });

    for (const bad of [null, ["a"], 42, "text"]) {
      expect(() =>
        parseReplayFixture(
          withPayload(bad),
          "sample",
          "sample",
          RESOLVE_CARTRIDGE,
        ),
      ).toThrow(/"payload"/);
    }

    expect(() =>
      parseReplayFixture(
        withPayload({ input: "pwd" }),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).not.toThrow();
    expect(() =>
      parseReplayFixture(
        withPayload(undefined),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).not.toThrow();
  });

  it("rejects a control character in an event type", () => {
    // The transcript is one line per entry joined with LF, so a type carrying
    // a newline would render one event as several lines, and `fixtures:update`
    // would bless that as the baseline.
    const withType = (type: string) => ({
      name: "sample",
      description: "d",
      seed: "s",
      cartridge: "minimal",
      events: [{ type }],
    });

    expect(() =>
      parseReplayFixture(
        withType("a\nb"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/control character/);
    expect(() =>
      parseReplayFixture(
        withType("a\rb"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/control character/);
    expect(() =>
      parseReplayFixture(
        withType("shell.exec"),
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).not.toThrow();
  });

  it("requires a cartridge name, and resolves it exactly once", () => {
    // Without this, a misspelled key replays as `cartridge: undefined`, the
    // serializer drops the undefined property, and `fixtures:update` records a
    // green baseline for two thirds of the input triple.
    const fields = { name: "sample", description: "d", seed: "s", events: [] };

    expect(() =>
      parseReplayFixture(fields, "sample", "sample", RESOLVE_CARTRIDGE),
    ).toThrow(/"cartridge" must be a fixture name/);
    expect(() =>
      parseReplayFixture(
        { ...fields, cartridge: {} },
        "sample",
        "sample",
        RESOLVE_CARTRIDGE,
      ),
    ).toThrow(/"cartridge" must be a fixture name/);

    const asked: string[] = [];
    const fixture = parseReplayFixture(
      { ...fields, cartridge: "minimal" },
      "sample",
      "sample",
      (reference) => {
        if (typeof reference !== "string")
          throw new Error("sample fixture should resolve a fixture cartridge");
        asked.push(reference);
        return { resolved: reference };
      },
    );

    expect(asked).toEqual(["minimal"]);
    expect(fixture.cartridgeName).toBe("minimal");
    expect(fixture.cartridge).toEqual({ resolved: "minimal" });
  });

  it("allows only the explicit production incident reference", () => {
    const fields = { name: "sample", description: "d", seed: "s", events: [] };
    const resolved: unknown[] = [];
    expect(() =>
      parseReplayFixture(
        { ...fields, cartridge: { kind: "incident", id: "../incident-001" } },
        "sample",
        "sample",
        (reference) => resolved.push(reference),
      ),
    ).toThrow(/cartridge/);
    expect(() =>
      parseReplayFixture(
        { ...fields, cartridge: { kind: "unbounded", id: "incident-001" } },
        "sample",
        "sample",
        (reference) => resolved.push(reference),
      ),
    ).toThrow(/cartridge/);
    parseReplayFixture(
      { ...fields, cartridge: { kind: "incident", id: "incident-001" } },
      "sample",
      "sample",
      (reference) => resolved.push(reference),
    );
    expect(resolved).toEqual([{ kind: "incident", id: "incident-001" }]);
  });

  it("reports a malformed fixture before chasing its cartridge reference", () => {
    // Otherwise a fixture with a bad event list and a bad cartridge name
    // reports the missing file, which is the less useful of the two.
    expect(() =>
      parseReplayFixture(
        {
          name: "sample",
          description: "d",
          seed: "s",
          cartridge: "does-not-exist",
          events: [{ kind: "oops" }],
        },
        "sample",
        "sample",
        () => {
          throw new Error("cartridge should not have been read");
        },
      ),
    ).toThrow(/events\[0\]/);
  });
});
