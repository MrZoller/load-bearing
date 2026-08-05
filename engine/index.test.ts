import { describe, expect, it } from "vitest";

import { ENGINE_VERSION } from "./index.js";

describe("engine", () => {
  it("exposes a version", () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs headless — no DOM in the engine's environment", () => {
    expect(globalThis).not.toHaveProperty("document");
    expect(globalThis).not.toHaveProperty("window");
  });
});
