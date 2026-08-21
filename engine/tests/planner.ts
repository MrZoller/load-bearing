/** Pure test evaluation shared by the event handler and the npm command. */

import { formatTimestamp } from "../clock/civil.js";
import type { FilePredicate } from "../cartridge/types.js";
import type { SessionState } from "../events/state.js";
import { readVfsSlice } from "../vfs/module.js";
import { readVfs, statVfs } from "../vfs/vfs.js";
import type { VfsSlice } from "../vfs/types.js";
import type { TestRunPlan } from "./types.js";

export function evaluateFilePredicate(
  predicate: FilePredicate,
  vfs: VfsSlice,
): boolean {
  if (predicate.kind === "file-exists")
    return statVfs(vfs, predicate.path).ok === predicate.exists;
  const result = readVfs(vfs, predicate.path);
  return result.ok && result.value.contents === predicate.equals;
}

export function planTestRun(state: SessionState): TestRunPlan {
  const startedMs = state.clock.startMs + state.clock.elapsedMs;
  const vfs = readVfsSlice(state);
  const cases = state.cartridge.repository.tests.map((test) => ({
    id: test.id,
    name: test.name,
    passed: evaluateFilePredicate(test.predicate, vfs),
    durationMs: test.durationMs,
  }));
  const durationMs = cases.reduce((total, test) => total + test.durationMs, 0);
  const failed = cases.filter((test) => !test.passed).length;
  const passed = cases.length - failed;
  return {
    startedAt: formatTimestamp(startedMs),
    finishedAt: formatTimestamp(startedMs + durationMs),
    durationMs,
    cases,
    exitCode: failed === 0 ? 0 : 1,
    stdout: [
      ...cases.map(
        (test) =>
          `${test.passed ? "PASS" : "FAIL"} ${test.name} (${String(test.durationMs)}ms)`,
      ),
      `Tests: ${String(passed)} passed, ${String(failed)} failed, ${String(cases.length)} total`,
      `Time: ${String(durationMs)}ms`,
    ],
    stderr: [],
  };
}
