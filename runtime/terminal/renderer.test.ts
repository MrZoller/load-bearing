import { describe, expect, it } from "vitest";

import cartridgeDocument from "../../content/incidents/phase-1-demo.json";
import {
  createAgentInputEvents,
  createShellExecuteEvent,
} from "../../engine/index.js";
import { createRuntimeSession } from "../session.js";
import { renderTerminalTranscript } from "./renderer.js";

interface FakeElement {
  className: string;
  textContent: string;
  readonly children: FakeElement[];
  append(...children: FakeElement[]): void;
}

function fakeDocument(): Document {
  return {
    createElement: () => {
      const children: FakeElement[] = [];
      return {
        className: "",
        textContent: "",
        children,
        append(...next: FakeElement[]) {
          children.push(...next);
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
  });
});
