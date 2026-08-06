import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned, not defaulted. `jsdom` or `happy-dom` here would hand the engine
    // a `document` and quietly retire invariant 3 — the "no DOM in the
    // engine's environment" test in engine/index.test.ts only means something
    // because the environment is bare Node.
    environment: "node",
    include: ["engine/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      // Deliberately impure fixtures for the purity gate's own tests.
      "scripts/gate-purity-samples/**",
    ],
  },
});
