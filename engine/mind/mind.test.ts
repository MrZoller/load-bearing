import { describe, expect, it } from "vitest";

import { loadCartridge } from "../cartridge/load.js";
import { readGitSlice } from "../git/module.js";
import { serialize } from "../serialize/canonical.js";
import { loadCartridgeFixture } from "../testing/fixtures.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readWorldSlice } from "../world/module.js";
import { reduce, restoreSnapshot, snapshot, step } from "../events/reduce.js";
import type { EngineEvent, SessionState } from "../events/state.js";
import {
  beliefDivergence,
  hasStandingPermission,
  hasWaiverConsent,
  MAX_WAIVER_CONSENTS,
  readMindSlice,
  validateMindSlice,
} from "./mind.js";
import {
  createMindPermissionRequestedEvent,
  createMindPermissionResolvedEvent,
  createMindWaiverConsentRecordedEvent,
} from "./module.js";

const SEED = "2026-08-05/13/deep-foundation";
const STARTED_AT = "2026-08-05T09:14:22.000Z";
const CARTRIDGE = loadCartridge(loadCartridgeFixture("minimal"));

function fold(events: readonly EngineEvent[]): SessionState {
  return reduce({ cartridge: CARTRIDGE, seed: SEED, events });
}

function mindEvent(type: string, payload: unknown): EngineEvent {
  return { type, payload } as EngineEvent;
}

function restoreWithMind(mind: unknown): SessionState {
  const parsed = JSON.parse(snapshot(fold([]))) as Record<string, unknown>;
  (parsed["slices"] as Record<string, unknown>)["mind"] = mind;
  return restoreSnapshot(serialize(parsed));
}

const CAPABILITY = {
  kind: "exact" as const,
  action: "write",
  resource: "/etc/motd",
};

function waiver(index: number) {
  return {
    id: `waiver-${String(index)}`,
    version: 1,
    phrase: "I accept the load-bearing consequence.",
    capability: CAPABILITY,
  };
}

describe("mind events", () => {
  it("resolves every choice atomically from only the matching pending request", () => {
    const requested = createMindPermissionRequestedEvent(
      "delete-motd",
      CAPABILITY,
    );
    const pending = fold([requested]);

    expect(readMindSlice(pending).pendingPermission).toEqual({
      id: "delete-motd",
      capability: CAPABILITY,
    });
    expect(() =>
      fold([
        requested,
        createMindPermissionRequestedEvent("second-request", CAPABILITY),
      ]),
    ).toThrow(/must be resolved first/);
    expect(() =>
      fold([
        requested,
        createMindPermissionResolvedEvent("different-request", "grant"),
      ]),
    ).toThrow(/does not match pending request/);
    expect(() =>
      fold([createMindPermissionResolvedEvent("delete-motd", "grant")]),
    ).toThrow(/no permission request is pending/);

    for (const [decision, ms] of [
      ["grant", 7],
      ["deny", 8],
      ["always-allow", 9],
    ] as const) {
      const resolved = fold([
        requested,
        { type: "clock.tick", payload: { ms } },
        createMindPermissionResolvedEvent("delete-motd", decision),
      ]);
      expect(readMindSlice(resolved)).toEqual({
        pendingPermission: null,
        permissions: [
          {
            capability: CAPABILITY,
            decision,
            at: `2026-08-05T09:14:22.00${String(ms)}Z`,
          },
        ],
        waiverConsents: [],
        beliefs: [],
        compactHistory: [],
      });
    }
  });

  it("restores a pending request without changing how direct decisions replay", () => {
    const requested = fold([
      createMindPermissionRequestedEvent("delete-motd", CAPABILITY),
    ]);
    const restored = restoreSnapshot(snapshot(requested));

    expect(readMindSlice(restored).pendingPermission).toEqual({
      id: "delete-motd",
      capability: CAPABILITY,
    });
    expect(
      readMindSlice(
        step(
          restored,
          createMindPermissionResolvedEvent("delete-motd", "deny"),
        ),
      ),
    ).toMatchObject({
      pendingPermission: null,
      permissions: [
        { capability: CAPABILITY, decision: "deny", at: STARTED_AT },
      ],
    });
    expect(
      readMindSlice(
        fold([
          {
            type: "mind.permission-decision",
            payload: { capability: CAPABILITY, decision: "grant" },
          },
        ]),
      ),
    ).toMatchObject({
      pendingPermission: null,
      permissions: [
        { capability: CAPABILITY, decision: "grant", at: STARTED_AT },
      ],
    });
  });

  it("timestamps every permission decision at its simulated instant", () => {
    const state = fold([
      {
        type: "mind.permission-decision",
        payload: { capability: CAPABILITY, decision: "grant" },
      },
      { type: "clock.tick", payload: { ms: 1 } },
      {
        type: "mind.permission-decision",
        payload: { capability: CAPABILITY, decision: "deny" },
      },
      { type: "clock.tick", payload: { ms: 1 } },
      {
        type: "mind.permission-decision",
        payload: { capability: CAPABILITY, decision: "always-allow" },
      },
    ]);

    expect(
      readMindSlice(state).permissions.map(({ decision, at }) => ({
        decision,
        at,
      })),
    ).toEqual([
      { decision: "grant", at: STARTED_AT },
      { decision: "deny", at: "2026-08-05T09:14:22.001Z" },
      { decision: "always-allow", at: "2026-08-05T09:14:22.002Z" },
    ]);
  });

  it("keeps an ordered, exact, simulated-time waiver ledger distinct from permissions", () => {
    const waiver = {
      id: "emergency-waiver",
      version: 1,
      phrase: "I accept the load-bearing consequence.",
      capability: CAPABILITY,
    };
    const state = fold([
      createMindWaiverConsentRecordedEvent(waiver),
      { type: "clock.tick", payload: { ms: 7 } },
      createMindWaiverConsentRecordedEvent({ ...waiver, id: "second-waiver" }),
      {
        type: "mind.permission-decision",
        payload: { capability: CAPABILITY, decision: "always-allow" },
      },
    ]);
    const mind = readMindSlice(state);

    expect(mind.waiverConsents).toEqual([
      { ...waiver, at: STARTED_AT },
      { ...waiver, id: "second-waiver", at: "2026-08-05T09:14:22.007Z" },
    ]);
    expect(hasWaiverConsent(mind, waiver)).toBe(true);
    expect(hasWaiverConsent(mind, { ...waiver, version: 2 })).toBe(false);
    expect(
      hasWaiverConsent(mind, {
        ...waiver,
        capability: { ...CAPABILITY, action: "delete" },
      }),
    ).toBe(false);
    expect(
      hasWaiverConsent(mind, {
        ...waiver,
        capability: { ...CAPABILITY, resource: "/etc/shadow" },
      }),
    ).toBe(false);
    expect(() =>
      fold([
        createMindWaiverConsentRecordedEvent(waiver),
        createMindWaiverConsentRecordedEvent({
          ...waiver,
          phrase: "revised words",
        }),
      ]),
    ).toThrow(/id "emergency-waiver" version 1 is already recorded/);
  });

  it("accepts exactly the bounded number of waiver consents and rejects the next record", () => {
    const accepted = Array.from({ length: MAX_WAIVER_CONSENTS }, (_, index) =>
      createMindWaiverConsentRecordedEvent(waiver(index)),
    );

    expect(readMindSlice(fold(accepted)).waiverConsents).toHaveLength(
      MAX_WAIVER_CONSENTS,
    );
    expect(() =>
      fold([
        ...accepted,
        createMindWaiverConsentRecordedEvent(waiver(MAX_WAIVER_CONSENTS)),
      ]),
    ).toThrow(
      `mind waiver consent: cannot record more than ${String(MAX_WAIVER_CONSENTS)} entries`,
    );
  });

  it("strictly validates waiver events and restored ledger snapshots", () => {
    const waiver = {
      id: "emergency-waiver",
      version: 1,
      phrase: "I accept the load-bearing consequence.",
      capability: CAPABILITY,
    };
    expect(() =>
      fold([
        mindEvent("mind.waiver-consent-recorded", { ...waiver, extra: true }),
      ]),
    ).toThrow(/unexpected payload field\(s\) extra/);
    for (const [waiverConsents, message] of [
      [[{ ...waiver, at: STARTED_AT, extra: true }], /unexpected field/],
      [[{ ...waiver, at: "not-time" }], /real fixed-width UTC instant/],
      [
        [
          { ...waiver, at: STARTED_AT },
          { ...waiver, at: STARTED_AT },
        ],
        /duplicate waiver id and version/,
      ],
    ] as const) {
      expect(() =>
        restoreWithMind({
          permissions: [],
          pendingPermission: null,
          waiverConsents,
          beliefs: [],
          compactHistory: [],
        }),
      ).toThrow(message);
    }
  });

  it("rejects a hostile restored waiver ledger longer than its bound", () => {
    const waiverConsents = Array.from(
      { length: MAX_WAIVER_CONSENTS + 1 },
      (_, index) => ({ ...waiver(index), at: STARTED_AT }),
    );

    expect(() =>
      restoreWithMind({
        permissions: [],
        pendingPermission: null,
        waiverConsents,
        beliefs: [],
        compactHistory: [],
      }),
    ).toThrow(
      `snapshot: slices.mind.waiverConsents: must contain at most ${String(MAX_WAIVER_CONSENTS)} entries`,
    );
  });

  it("grants standing permission only for an exact always-allow capability", () => {
    const slice = readMindSlice(
      fold([
        {
          type: "mind.permission-decision",
          payload: { capability: CAPABILITY, decision: "grant" },
        },
        {
          type: "mind.permission-decision",
          payload: { capability: CAPABILITY, decision: "always-allow" },
        },
      ]),
    );

    expect(hasStandingPermission(slice, CAPABILITY)).toBe(true);
    expect(
      hasStandingPermission(slice, { ...CAPABILITY, action: "read" }),
    ).toBe(false);
    expect(
      hasStandingPermission(slice, {
        ...CAPABILITY,
        resource: "/etc/motd.bak",
      }),
    ).toBe(false);

    for (const decision of ["grant", "deny"] as const) {
      expect(
        hasStandingPermission(
          readMindSlice(
            fold([
              mindEvent("mind.permission-decision", {
                capability: CAPABILITY,
                decision,
              }),
            ]),
          ),
          CAPABILITY,
        ),
      ).toBe(false);
    }
  });

  it("upserts beliefs by typed subject without moving their position", () => {
    const state = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "git-head",
            head: { kind: "branch", target: "main" },
          },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: false },
        },
      },
    ]);

    expect(readMindSlice(state).beliefs).toEqual([
      { kind: "file-exists", path: "/etc/motd", exists: false },
      { kind: "git-head", head: { kind: "branch", target: "main" } },
    ]);
  });

  it("compacts by replacing beliefs wholesale and retaining timestamped summaries", () => {
    const state = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
      },
      { type: "clock.tick", payload: { ms: 7 } },
      {
        type: "mind.compact",
        payload: {
          summary: "forgot the filesystem",
          beliefs: [
            { kind: "service-state", service: "missing", state: "running" },
          ],
        },
      },
      { type: "clock.tick", payload: { ms: 3 } },
      {
        type: "mind.compact",
        payload: { summary: "forgot the service", beliefs: [] },
      },
    ]);

    expect(readMindSlice(state)).toEqual({
      permissions: [],
      pendingPermission: null,
      waiverConsents: [],
      beliefs: [],
      compactHistory: [
        {
          summary: "forgot the filesystem",
          at: "2026-08-05T09:14:22.007Z",
        },
        { summary: "forgot the service", at: "2026-08-05T09:14:22.010Z" },
      ],
    });
  });

  it("rejects hostile values before JSON serialization can hide them", () => {
    const accessor = { waiverConsents: [], beliefs: [], compactHistory: [] };
    Object.defineProperty(accessor, "permissions", {
      enumerable: true,
      get: () => [],
    });
    const symbolKey = {
      permissions: [],
      waiverConsents: [],
      beliefs: [],
      compactHistory: [],
    };
    Object.defineProperty(symbolKey, Symbol("hostile"), { value: true });
    const nonstandardPrototype = Object.assign(Object.create({}), {
      permissions: [],
      waiverConsents: [],
      beliefs: [],
      compactHistory: [],
    });
    const nonEnumerable = {
      waiverConsents: [],
      beliefs: [],
      compactHistory: [],
    };
    Object.defineProperty(nonEnumerable, "permissions", {
      enumerable: false,
      value: [],
    });

    for (const [value, message] of [
      [accessor, /accessors are not inert JSON data/],
      [symbolKey, /must not contain symbol-keyed fields/],
      [nonstandardPrototype, /must be a plain JSON object/],
      [nonEnumerable, /non-enumerable fields are not JSON data/],
      [
        {
          permissions: new Array(1),
          waiverConsents: [],
          beliefs: [],
          compactHistory: [],
        },
        /must be a dense array without extra fields/,
      ],
    ] as const)
      expect(() => validateMindSlice(value, "snapshot: slices.mind")).toThrow(
        message,
      );
  });

  it("rejects malformed event payloads and malformed mind snapshots", () => {
    expect(() =>
      fold([
        {
          type: "mind.permission-decision",
          payload: { capability: CAPABILITY, decision: "always" },
        },
      ]),
    ).toThrow(/decision must be grant, deny or always-allow/);
    expect(() =>
      fold([
        createMindPermissionRequestedEvent("delete-motd", CAPABILITY),
        mindEvent("mind.permission-resolved", {
          id: "delete-motd",
          decision: "always",
        }),
      ]),
    ).toThrow(/decision must be grant, deny or always-allow/);
    expect(() =>
      fold([
        {
          type: "mind.compact",
          payload: {
            summary: "x",
            beliefs: [{ kind: "file-exists", path: "relative", exists: true }],
          },
        },
      ]),
    ).toThrow(/canonical absolute POSIX path/);
    expect(() =>
      fold([
        mindEvent("mind.permission-decision", {
          capability: { ...CAPABILITY, kind: "prefix" },
          decision: "grant",
        }),
      ]),
    ).toThrow(/kind: must be exact/);
    for (const [payload, message] of [
      [
        {
          belief: {
            kind: "git-head",
            head: { kind: "detached", target: "not-a-hash" },
          },
        },
        /valid branch or a detached HEAD with a 40-digit hash/,
      ],
      [
        {
          belief: { kind: "service-state", service: "api", state: "paused" },
        },
        /state: must be running or stopped/,
      ],
      [
        {
          belief: {
            kind: "service-health",
            service: "api",
            health: "excellent",
          },
        },
        /health: must be a service health value/,
      ],
      [{ belief: { kind: "intuition" } }, /unknown belief kind/],
    ] as const)
      expect(() => fold([mindEvent("mind.belief-set", payload)])).toThrow(
        message,
      );

    const duplicateBeliefs = [
      { kind: "file-exists", path: "/etc/motd", exists: true },
      { kind: "file-exists", path: "/etc/motd", exists: false },
    ];
    expect(() =>
      fold([
        mindEvent("mind.compact", {
          summary: "duplicate assertion",
          beliefs: duplicateBeliefs,
        }),
      ]),
    ).toThrow(/duplicate typed belief subject/);

    const duplicateSlice = {
      permissions: [],
      pendingPermission: null,
      waiverConsents: [],
      beliefs: duplicateBeliefs,
      compactHistory: [],
    };
    expect(() =>
      validateMindSlice(duplicateSlice, "snapshot: slices.mind"),
    ).toThrow(/duplicate typed subject/);
    expect(() => restoreWithMind(duplicateSlice)).toThrow(
      /duplicate typed subject/,
    );
    expect(() =>
      validateMindSlice(
        {
          permissions: [],
          pendingPermission: null,
          waiverConsents: [],
          beliefs: [],
          compactHistory: [],
          extra: true,
        },
        "snapshot: slices.mind",
      ),
    ).toThrow(/unexpected field/);

    expect(() =>
      restoreWithMind({
        permissions: [],
        pendingPermission: null,
        waiverConsents: [],
        beliefs: [],
        compactHistory: [{ summary: "x", at: "not-time" }],
      }),
    ).toThrow(/real fixed-width UTC instant/);

    for (const [pendingPermission, message] of [
      [
        {
          id: "bad\nid",
          capability: CAPABILITY,
        },
        /non-empty single-line identifier/,
      ],
      [
        {
          id: "delete-motd",
          capability: { ...CAPABILITY, action: "" },
        },
        /non-empty single-line string/,
      ],
      [
        {
          id: "delete-motd",
          capability: { ...CAPABILITY, resource: "x".repeat(16_001) },
        },
        /action and resource must each be at most/,
      ],
      [
        { id: "delete-motd", capability: CAPABILITY, extra: true },
        /unexpected field/,
      ],
    ] as const) {
      expect(() =>
        restoreWithMind({
          permissions: [],
          pendingPermission,
          waiverConsents: [],
          beliefs: [],
          compactHistory: [],
        }),
      ).toThrow(message);
    }
  });
});

describe("mind truth comparison and ownership", () => {
  it("reports all five typed divergences, including missing service truth", () => {
    const state = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/missing", exists: true },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "file-contents",
            path: "/etc/motd",
            contents: "wrong",
          },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "git-head",
            head: {
              kind: "detached",
              target: "0000000000000000000000000000000000000000",
            },
          },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "service-state",
            service: "missing",
            state: "running",
          },
        },
      },
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "service-health",
            service: "missing",
            health: "healthy",
          },
        },
      },
    ]);

    expect(beliefDivergence(state)).toEqual([
      { kind: "file-exists", path: "/missing", believed: true, actual: false },
      {
        kind: "file-contents",
        path: "/etc/motd",
        believed: "wrong",
        actual: "This system is load-bearing.\n",
      },
      {
        kind: "git-head",
        believed: {
          kind: "detached",
          target: "0000000000000000000000000000000000000000",
        },
        actual: readGitSlice(state).head,
      },
      {
        kind: "service-state",
        service: "missing",
        believed: "running",
        actual: null,
      },
      {
        kind: "service-health",
        service: "missing",
        believed: "healthy",
        actual: null,
      },
    ]);
  });

  it("can agree with the empty detached HEAD of an unborn repository", () => {
    const state = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: {
            kind: "git-head",
            head: { kind: "detached", target: "" },
          },
        },
      },
    ]);

    expect(beliefDivergence(state)).toEqual([]);
  });

  it("queries unreadable VFS truth without making it readable to the shell", () => {
    const raw = loadCartridgeFixture("minimal") as Record<string, unknown>;
    const repository = raw["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<string, unknown>;
    const cartridge = loadCartridge({
      ...raw,
      repository: {
        ...repository,
        identity: {
          user: "greg",
          group: "departed",
          home: "/home/greg",
          umask: "0022",
        },
        files: {
          ...files,
          "/etc/motd": {
            ...(files["/etc/motd"] as Record<string, unknown>),
            mode: "0400",
          },
        },
      },
    });
    const state = reduce({
      cartridge,
      seed: SEED,
      events: [
        {
          type: "mind.belief-set",
          payload: {
            belief: {
              kind: "file-contents",
              path: "/etc/motd",
              contents: "wrong",
            },
          },
        },
      ],
    });

    expect(readVfs(readVfsSlice(state), "/etc/motd")).toMatchObject({
      ok: false,
      code: "EACCES",
    });
    expect(beliefDivergence(state)).toEqual([
      {
        kind: "file-contents",
        path: "/etc/motd",
        believed: "wrong",
        actual: "This system is load-bearing.\n",
      },
    ]);
  });

  it("keeps mind events out of VFS, Git, and world, and foreign events out of mind", () => {
    const base = fold([]);
    const minded = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
      },
    ]);
    const foreign = fold([
      {
        type: "mind.belief-set",
        payload: {
          belief: { kind: "file-exists", path: "/etc/motd", exists: true },
        },
      },
      {
        type: "vfs.write",
        payload: { path: "/production/service/new.txt", contents: "x" },
      },
      { type: "world.env-set", payload: { name: "MIND_TEST", value: "x" } },
    ]);

    expect(serialize(readVfsSlice(minded))).toBe(serialize(readVfsSlice(base)));
    expect(serialize(readGitSlice(minded))).toBe(serialize(readGitSlice(base)));
    expect(serialize(readWorldSlice(minded))).toBe(
      serialize(readWorldSlice(base)),
    );
    expect(readMindSlice(foreign)).toEqual(readMindSlice(minded));
  });
});
