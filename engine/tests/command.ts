import { stampEvent } from "../events/log.js";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { planTestRun } from "./planner.js";

export const NPM_COMMAND: CommandDefinition = Object.freeze({
  name: "npm",
  execute(context: CommandContext) {
    if (context.argv.length !== 2 || context.argv[1] !== "test")
      return {
        stdout: [],
        stderr: ["npm: only `npm test` is supported"],
        exitCode: 2,
        events: [],
      };
    const plan = planTestRun(context.state);
    return {
      // tests.run owns the visible test output and advances the simulated
      // clock. Returning it here too would make shell.result duplicate every
      // line in the transcript after the child event has rendered it.
      stdout: [],
      stderr: [],
      exitCode: plan.exitCode,
      events: [stampEvent({ type: "tests.run", payload: {} }, "npm test")],
    };
  },
});
