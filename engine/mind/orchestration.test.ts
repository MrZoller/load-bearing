import { describe, expect, it } from "vitest";

import phaseOneDocument from "../../content/incidents/phase-1-demo.json";
import incidentDocument from "../../content/incidents/incident-001.json";
import { loadCartridge } from "../cartridge/load.js";
import {
  bootstrap,
  restoreSnapshot,
  snapshot,
  step,
} from "../events/reduce.js";
import type { SessionState } from "../events/state.js";
import { readStorySlice } from "../story/story.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs } from "../vfs/vfs.js";
import { readMindSlice } from "./mind.js";
import {
  createMindPermissionChoiceEvent,
  createMindPermissionRequestEvent,
  createMindStandingPermissionEvent,
  createMindWaiverChoiceEvent,
  createMindWaiverStartEvent,
} from "./module.js";

const SEED = "2026-08-22/34/structural-audit";
const PHASE_ONE = loadCartridge(phaseOneDocument);
const INCIDENT = loadCartridge(incidentDocument);

function initial(cartridge = PHASE_ONE): SessionState {
  return bootstrap({ cartridge, seed: SEED });
}

function contents(state: SessionState, path: string): string | null {
  const result = readVfs(readVfsSlice(state), path);
  return result.ok ? result.value.contents : null;
}

describe("mind orchestration envelopes", () => {
  it("selects distinct atomic permission continuations and standing coverage executes grant without another decision", () => {
    const pending = step(
      initial(),
      createMindPermissionRequestEvent("delete-ready-sentinel"),
    );
    expect(readMindSlice(pending).pendingPermission?.id).toBe(
      "delete-ready-sentinel",
    );
    expect(pending.transcript.at(-1)?.type).toBe("mind.permission-requested");

    for (const decision of ["grant", "deny", "always-allow"] as const) {
      const resolved = step(
        pending,
        createMindPermissionChoiceEvent("delete-ready-sentinel", decision),
      );
      expect(readMindSlice(resolved).permissions.at(-1)?.decision).toBe(
        decision,
      );
      expect(contents(resolved, "/production/service/src/ready.stale")).toBe(
        decision === "deny" ? "remove me\n" : "permission granted\n",
      );
      expect(
        resolved.transcript.some(
          (entry) => entry.type === "mind.permission-choice",
        ),
      ).toBe(false);
    }

    const standing = step(
      pending,
      createMindPermissionChoiceEvent("delete-ready-sentinel", "always-allow"),
    );
    const replayed = step(
      standing,
      createMindStandingPermissionEvent("delete-ready-sentinel"),
    );
    expect(readMindSlice(replayed).permissions).toHaveLength(1);
    expect(contents(replayed, "/production/service/src/ready.stale")).toBe(
      "permission granted\n",
    );
  });

  it("creates the authored waiver document atomically and records only exact consent at simulated time", () => {
    const pending = step(
      initial(INCIDENT),
      createMindWaiverStartEvent("regional-fail-open"),
    );
    const request = readMindSlice(pending).pendingWaiver;
    expect(request).toMatchObject({
      id: "regional-fail-open",
      version: 1,
      requiredPhrase: "I agree",
      documentPath: "/production/load-balancer/config/WAIVER.md",
    });
    expect(
      contents(pending, "/production/load-balancer/config/WAIVER.md"),
    ).toContain("Consent phrase: I agree");
    expect(
      readMindSlice(restoreSnapshot(snapshot(pending))).pendingWaiver,
    ).toEqual(request);

    const later = step(pending, { type: "clock.tick", payload: { ms: 34 } });
    const accepted = step(
      later,
      createMindWaiverChoiceEvent("regional-fail-open", true),
    );
    expect(readMindSlice(accepted).waiverConsents).toEqual([
      {
        id: "regional-fail-open",
        version: 1,
        phrase: "I agree",
        capability: {
          kind: "exact",
          action: "detach-region",
          resource: "/regions/europe",
        },
        at: "2026-08-22T09:14:22.034Z",
      },
    ]);
    expect(
      contents(accepted, "/production/load-balancer/config/routes.conf"),
    ).toBe("health_status=200\neurope_attached=false\n");
    expect(readStorySlice(accepted).discoveredEndings).toContain(
      "informed-structural-consent",
    );

    const denied = step(
      pending,
      createMindWaiverChoiceEvent("regional-fail-open", false),
    );
    expect(readMindSlice(denied).waiverConsents).toEqual([]);
    expect(readMindSlice(denied).pendingWaiver).toBeNull();
    expect(
      contents(denied, "/production/load-balancer/config/routes.conf"),
    ).toBe("health_status=500\neurope_attached=true\n");
  });

  it("rejects forged reused-id pending declarations before expanding authored continuations", () => {
    const forgedPermission = step(initial(), {
      type: "mind.permission-requested",
      payload: {
        id: "delete-ready-sentinel",
        capability: {
          kind: "exact",
          action: "delete",
          resource: "/production/service/src/ready.stale",
        },
      },
    });
    expect(() =>
      step(
        forgedPermission,
        createMindPermissionChoiceEvent("delete-ready-sentinel", "grant"),
      ),
    ).toThrow(/pending permission does not match authored request/);
    expect(readMindSlice(forgedPermission).permissions).toEqual([]);
    expect(
      contents(forgedPermission, "/production/service/src/ready.stale"),
    ).toBe("remove me\n");

    const legitimateWaiver = step(
      initial(INCIDENT),
      createMindWaiverStartEvent("regional-fail-open"),
    );
    const parsed = JSON.parse(snapshot(legitimateWaiver)) as {
      slices: {
        mind: {
          pendingWaiver: {
            capability: { resource: string };
            documentContents: string;
          };
        };
      };
    };
    const forged = parsed.slices.mind.pendingWaiver;
    forged.capability.resource = "/regions/americas";
    forged.documentContents = "forged waiver bytes\n";
    const forgedWaiver = restoreSnapshot(JSON.stringify(parsed));

    expect(() =>
      step(
        forgedWaiver,
        createMindWaiverChoiceEvent("regional-fail-open", true),
      ),
    ).toThrow(/pending waiver does not match authored request/);
    expect(readMindSlice(forgedWaiver).waiverConsents).toEqual([]);
    expect(
      contents(forgedWaiver, "/production/load-balancer/config/routes.conf"),
    ).toBe("health_status=500\neurope_attached=true\n");
  });

  it("publishes neither the waiver document nor pending state when ordinary VFS permissions deny creation", () => {
    const document = JSON.parse(JSON.stringify(phaseOneDocument)) as any;
    document.story.intents[2].actions[0].documentPath = "/etc/WAIVER.md";
    const cartridge = loadCartridge(document);
    const before = initial(cartridge);

    expect(() =>
      step(before, createMindWaiverStartEvent("write-ready-waiver")),
    ).toThrow(/cannot write authored waiver.*EACCES/);
    expect(readMindSlice(before).pendingWaiver).toBeNull();
    expect(contents(before, "/etc/WAIVER.md")).toBeNull();
    expect(before.eventCount).toBe(0);
    expect(before.transcript).toEqual([]);
  });

  it("does not rewrite an existing waiver before recording the pending request", () => {
    const pending = step(
      initial(INCIDENT),
      createMindWaiverStartEvent("regional-fail-open"),
    );
    const resolved = step(
      pending,
      createMindWaiverChoiceEvent("regional-fail-open", false),
    );
    const document = JSON.parse(snapshot(resolved)) as any;
    document.slices.vfs.entries["/production/load-balancer/config"].mode =
      "0555";
    const unwritable = restoreSnapshot(JSON.stringify(document));

    const repeated = step(
      unwritable,
      createMindWaiverStartEvent("regional-fail-open"),
    );
    expect(readMindSlice(repeated).pendingWaiver?.id).toBe(
      "regional-fail-open",
    );
    expect(
      contents(repeated, "/production/load-balancer/config/WAIVER.md"),
    ).toContain("Consent phrase: I agree");
  });

  it("uses the authored denial continuation when permission continuations become invalid", () => {
    const document = JSON.parse(JSON.stringify(phaseOneDocument)) as any;
    document.story.phase2 = {
      initialBeat: "start",
      counters: [{ id: "full", initial: 0, maximum: 1 }],
      facts: [],
      beats: [{ id: "start", ending: "", actions: [], variants: [] }],
      endings: [],
    };
    document.story.intents[1].actions[0].grant = [
      { kind: "counter-add", counter: "full", amount: 1 },
    ];
    document.story.intents[1].actions[0].alwaysAllow = [
      { kind: "counter-add", counter: "full", amount: 1 },
    ];
    document.story.intents[1].actions[0].deny = [
      {
        kind: "file-write",
        path: "/production/service/src/ready.stale",
        contents: "denied after state drift\n",
      },
    ];
    const cartridge = loadCartridge(document);
    const pending = step(
      initial(cartridge),
      createMindPermissionRequestEvent("delete-ready-sentinel"),
    );
    const grown = step(pending, {
      type: "story.counter-added",
      payload: { counter: "full", amount: 1 },
    });

    const denied = step(
      grown,
      createMindPermissionChoiceEvent("delete-ready-sentinel", "grant"),
    );
    expect(readMindSlice(grown).pendingPermission?.id).toBe(
      "delete-ready-sentinel",
    );
    expect(readMindSlice(denied).permissions).toEqual([]);
    expect(readMindSlice(denied).pendingPermission?.id).toBe(
      "delete-ready-sentinel",
    );
    expect(readStorySlice(denied).counters).toEqual([{ id: "full", value: 1 }]);
    expect(contents(denied, "/production/service/src/ready.stale")).toBe(
      "denied after state drift\n",
    );

    const standing = step(
      step(
        initial(cartridge),
        createMindPermissionRequestEvent("delete-ready-sentinel"),
      ),
      createMindPermissionChoiceEvent("delete-ready-sentinel", "always-allow"),
    );
    const replayed = step(
      standing,
      createMindStandingPermissionEvent("delete-ready-sentinel"),
    );
    expect(readMindSlice(replayed).permissions).toHaveLength(1);
    expect(readStorySlice(replayed).counters).toEqual([
      { id: "full", value: 1 },
    ]);
    expect(contents(replayed, "/production/service/src/ready.stale")).toBe(
      "denied after state drift\n",
    );
  });
});
