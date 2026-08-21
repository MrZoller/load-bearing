export interface TestCaseResult {
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

export interface TestRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly cases: readonly TestCaseResult[];
  readonly exitCode: number;
}

export interface TestsSlice {
  readonly runs: readonly TestRun[];
}

export interface TestRunPlan extends TestRun {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}
