/** Stateful simulated test runs and their snapshot contract. */

import { formatTimestamp, parseTimestamp } from "../clock/civil.js";
import { defineEventModule } from "../events/module.js";
import { requirePayload } from "../events/payload.js";
import { readSlice } from "../events/state.js";
import type { SessionState, TranscriptOutput } from "../events/state.js";
import { planTestRun } from "./planner.js";
import type { TestCaseResult, TestRun, TestsSlice } from "./types.js";

function record(
  value: unknown,
  where: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where}: must be an object`);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0)
    throw new Error(`${where}: must contain exactly ${fields.join(", ")}`);
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length)
    throw new Error(`${where}: must be a dense array`);
  return value;
}

function integer(value: unknown, where: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum)
    throw new Error(`${where}: must be an integer at least ${String(minimum)}`);
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where}: must be a string`);
  return value;
}

function validateCase(value: unknown, where: string): TestCaseResult {
  const item = record(value, where, ["id", "name", "passed", "durationMs"]);
  const passed = item["passed"];
  if (typeof passed !== "boolean")
    throw new Error(`${where}.passed: must be a boolean`);
  return {
    id: string(item["id"], `${where}.id`),
    name: string(item["name"], `${where}.name`),
    passed,
    durationMs: integer(item["durationMs"], `${where}.durationMs`, 0),
  };
}

function validateRun(value: unknown, where: string): TestRun {
  const run = record(value, where, [
    "startedAt",
    "finishedAt",
    "durationMs",
    "cases",
    "exitCode",
  ]);
  const startedAt = string(run["startedAt"], `${where}.startedAt`);
  const finishedAt = string(run["finishedAt"], `${where}.finishedAt`);
  try {
    if (
      formatTimestamp(parseTimestamp(startedAt)) !== startedAt ||
      formatTimestamp(parseTimestamp(finishedAt)) !== finishedAt
    )
      throw new Error("noncanonical timestamp");
  } catch {
    throw new Error(
      `${where}: timestamps must be real fixed-width UTC instants`,
    );
  }
  const exitCode = integer(run["exitCode"], `${where}.exitCode`, 0);
  if (exitCode > 1) throw new Error(`${where}.exitCode: must be 0 or 1`);
  const durationMs = integer(run["durationMs"], `${where}.durationMs`, 0);
  const cases = array(run["cases"], `${where}.cases`).map((item, index) =>
    validateCase(item, `${where}.cases[${String(index)}]`),
  );
  if (parseTimestamp(finishedAt) - parseTimestamp(startedAt) !== durationMs)
    throw new Error(`${where}: timestamps must span durationMs exactly`);
  if (cases.reduce((total, item) => total + item.durationMs, 0) !== durationMs)
    throw new Error(`${where}: case durations must sum to durationMs`);
  const expectedExit = cases.every((item) => item.passed) ? 0 : 1;
  if (exitCode !== expectedExit)
    throw new Error(`${where}.exitCode: must agree with case results`);
  return {
    startedAt,
    finishedAt,
    durationMs,
    cases,
    exitCode,
  };
}

export function validateTestsSlice(slice: unknown, where: string): TestsSlice {
  const root = record(slice, where, ["runs"]);
  array(root["runs"], `${where}.runs`).forEach((run, index) =>
    validateRun(run, `${where}.runs[${String(index)}]`),
  );
  return slice as TestsSlice;
}

export function readTestsSlice(state: SessionState): TestsSlice {
  return validateTestsSlice(
    readSlice(state, "tests"),
    "session state: slices.tests",
  );
}

export const TESTS_MODULE = defineEventModule<TestsSlice>({
  namespace: "tests",
  description: "Simulated test execution and deterministic run history.",
  initialSlice: () => ({ runs: [] }),
  validateSlice: validateTestsSlice,
  events: {
    "tests.run": {
      version: 0,
      apply(context, slice) {
        const payload = requirePayload(context);
        const unknown = Object.keys(payload);
        if (unknown.length > 0)
          throw new Error(
            `${context.where}: tests.run takes no payload fields`,
          );
        const plan = planTestRun(context.state);
        context.clock.advance(plan.durationMs);
        const output: TranscriptOutput[] = plan.stdout.map((text) => ({
          stream: "stdout",
          text,
        }));
        const run: TestRun = {
          startedAt: plan.startedAt,
          finishedAt: plan.finishedAt,
          durationMs: plan.durationMs,
          cases: plan.cases,
          exitCode: plan.exitCode,
        };
        return {
          slice: { runs: [...slice.runs, run] },
          output,
          exitCode: plan.exitCode,
        };
      },
    },
  },
});
