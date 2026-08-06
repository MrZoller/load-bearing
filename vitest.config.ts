import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pinned, not defaulted. `jsdom` or `happy-dom` here would hand the engine
    // a `document` and quietly retire invariant 3 — the "no DOM in the
    // engine's environment" test in engine/index.test.ts only means something
    // because the environment is bare Node.
    environment: "node",
    // These globs must stay in step with `TEST_FILE_PATTERN` in
    // scripts/gate-purity.mjs, which is what the purity gate uses to decide a
    // file is a test and skip it. A name the gate skips but these globs miss —
    // `engine/foo.spec.ts`, `engine/foo.test.tsx` — gets neither purity
    // scanning nor test execution, so a regression test could be added and
    // silently never run. A test asserts the two agree.
    // An explicit include replaces Vitest's repository-wide default, so every
    // source root the project layout declares has to be named or its tests are
    // silently never run.
    include: [
      "engine/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "runtime/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "content/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "pipeline/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    exclude: [
      "**/node_modules/**",
      // Deliberately impure fixtures for the purity gate's own tests.
      "scripts/gate-purity-samples/**",
    ],
  },
});
