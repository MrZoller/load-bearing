/**
 * Load Bearing simulation engine.
 *
 * Headless by requirement: pure TypeScript, zero DOM dependencies, runnable
 * in Node and the browser. The Phase 5 playtester agents drive this same
 * module in CI, so anything that needs a document object belongs in
 * /runtime instead. See docs/ARCHITECTURE.md.
 */

export const ENGINE_VERSION = "0.0.0";
