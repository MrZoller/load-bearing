import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createAgentInputEvents,
  createShellExecuteEvent,
} from "../../engine/index.js";
import { createRuntimeSession } from "../session.js";
import { renderTerminalTranscript } from "./renderer.js";

interface FakeElement {
  readonly tagName: string;
  className: string;
  textContent: string;
  readonly children: FakeElement[];
  readonly dataset: Record<string, string>;
  readonly attributes: ReadonlyMap<string, string>;
  append(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) => {
      const children: FakeElement[] = [];
      const attributes = new Map<string, string>();
      return {
        tagName,
        className: "",
        textContent: "",
        children,
        dataset: {},
        attributes,
        append(...next: FakeElement[]) {
          children.push(...next);
        },
        setAttribute(name: string, value: string) {
          attributes.set(name, value);
        },
      } as unknown as HTMLElement;
    },
  } as unknown as Document;
}

describe("renderTerminalTranscript", () => {
  it("uses cartridge-authored opening copy rather than the simulated motd", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const entries = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      session.current(),
    ) as unknown as FakeElement[];

    expect(entries).toHaveLength(1);
    expect(entries[0]?.children.map((line) => line.textContent)).toEqual([
      "Last login: maintenance window still open.",
      "Load Bearing incident shell attached.",
      "visitor@load-bearing:/production/service$",
    ]);
    expect(
      entries[0]?.children.map((line) => line.textContent).join("\n"),
    ).not.toContain("This file remains discoverable");

    const afterCommand = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      session.dispatch(createShellExecuteEvent("pwd")),
    );
    expect(afterCommand).toHaveLength(2);
  });

  it("renders cartridge-authored opening copy when the VFS has no motd", () => {
    const document = structuredClone(cartridgeDocument) as Record<
      string,
      unknown
    >;
    const repository = document["repository"] as Record<string, unknown>;
    const files = repository["files"] as Record<string, unknown>;
    delete files["/etc/motd"];
    const session = createRuntimeSession(document);

    const entries = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      session.current(),
    ) as unknown as FakeElement[];
    expect(entries[0]?.children.map((line) => line.textContent)).toEqual([
      "Last login: maintenance window still open.",
      "Load Bearing incident shell attached.",
      "visitor@load-bearing:/production/service$",
    ]);
  });

  it("renders authored visitor turns and responses alongside their planned shell effects", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const state = session.current().state;
    const snapshot = session.dispatchMany(
      createAgentInputEvents(session.cartridge, state, "inspect it"),
    );

    const entries = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      snapshot,
    ) as unknown as FakeElement[];

    expect(
      entries.flatMap((entry) =>
        entry.children.map((line) => line.textContent),
      ),
    ).toEqual(
      expect.arrayContaining([
        "inspect it",
        "I will inspect the sentinel before changing the forces currently passing through it.",
        "cat src/ready.stale",
        "remove me",
      ]),
    );
    const agentEntry = entries.find(
      (entry) =>
        entry.className === "transcript__entry transcript__entry--agent" &&
        entry.children[0]?.textContent ===
          "I will inspect the sentinel before changing the forces currently passing through it.",
    );
    expect(agentEntry?.children[1]).toMatchObject({
      tagName: "section",
      className: "artifacts",
    });
    expect(agentEntry?.children[1]?.children[0]?.children[0]).toMatchObject({
      tagName: "summary",
      textContent: "Tool: Read src/ready.stale — succeeded",
    });
  });

  it("renders a shell command before its expanded agent response", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const snapshot = session.dispatch(
      createShellExecuteEvent("loadbearing --resume incident-000"),
    );
    const entries = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      snapshot,
    ) as unknown as FakeElement[];

    expect(entries.map((entry) => entry.className)).toEqual([
      "transcript__entry transcript__entry--login",
      "transcript__entry transcript__entry--exchange",
      "transcript__entry transcript__entry--agent",
    ]);
    expect(entries[1]?.children[0]?.textContent).toBe(
      "loadbearing --resume incident-000",
    );
    expect(entries[2]?.children[0]?.textContent).toContain(
      "temporary readiness sentinel",
    );
    expect(entries[1]?.children[0]?.attributes.get("aria-label")).toBe(
      "Shell command: loadbearing --resume incident-000",
    );
    expect(entries[2]?.children[0]?.attributes.get("aria-label")).toContain(
      "Agent: ",
    );
    expect(entries[2]?.dataset["announcement"]).toBe(
      "Agent: I found the temporary readiness sentinel. Its age suggests removal now requires a structural survey.",
    );
  });

  it("labels shell streams textually and exposes only output for announcement", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const entries = renderTerminalTranscript(
      fakeDocument(),
      session.cartridge,
      session.dispatch(createShellExecuteEvent("pwd")),
    ) as unknown as FakeElement[];
    const exchange = entries[1];

    expect(exchange?.children[1]?.attributes.get("aria-label")).toBe(
      "Shell output: /production/service",
    );
    expect(exchange?.dataset["announcement"]).toBe(
      "Shell output: /production/service",
    );
    expect(exchange?.dataset["announcement"]).not.toContain("pwd");
  });

  it("rejects transcript shell results without their replayed input", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const snapshot = session.dispatch(createShellExecuteEvent("pwd"));

    expect(() =>
      renderTerminalTranscript(fakeDocument(), session.cartridge, {
        eventLog: [],
        state: snapshot.state,
      }),
    ).toThrow(/shell result has no replayed input/i);
  });

  it("rejects replayed shell inputs whose stored result is missing", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const snapshot = session.dispatch(createShellExecuteEvent("pwd"));

    expect(() =>
      renderTerminalTranscript(fakeDocument(), session.cartridge, {
        eventLog: snapshot.eventLog,
        state: { ...snapshot.state, transcript: [] },
      }),
    ).toThrow(/shell commands and replayed results are out of step/i);
  });

  it("rejects agent transcript events without replayed messages", () => {
    const session = createRuntimeSession(cartridgeDocument);
    const snapshot = session.dispatch(
      createShellExecuteEvent("loadbearing --resume incident-000"),
    );
    const agentEntry = snapshot.state.transcript.find(
      (entry) => entry.type === "agent.response-recorded",
    );
    if (agentEntry === undefined) throw new Error("missing agent entry");

    expect(() =>
      renderTerminalTranscript(fakeDocument(), session.cartridge, {
        eventLog: snapshot.eventLog,
        state: {
          ...snapshot.state,
          transcript: [...snapshot.state.transcript, agentEntry],
        },
      }),
    ).toThrow(/replayed agent message is missing/i);
  });
});
