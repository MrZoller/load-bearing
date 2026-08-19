/**
 * The runtime's own events.
 *
 * One module, one event: time moves. Everything else the engine will ever do —
 * files, git, processes, tests, the agent's mind — belongs to a subsystem with
 * its own module (issues #5 through #13), because a "core" that accumulates
 * world semantics is the monolithic switch this design exists to avoid, wearing
 * a different name.
 *
 * `clock.tick` is here rather than in a subsystem because the clock is not a
 * subsystem: it is one timeline every module shares, and an event log needs a
 * way to say "time passed" that belongs to nobody in particular. Which events
 * advance it *incidentally* — a simulated test run taking four seconds — is a
 * judgement for the module raising them, per docs/ARCHITECTURE.md.
 *
 * This module holds no slice, and so declares no `validateSlice`: the clock's
 * position lives in `SessionState.clock`, where `restoreClock` already
 * validates it on the way back from a snapshot. `createRegistry` refuses a
 * `validateSlice` on a stateless module, because it could never run.
 * `engine/events/probe.ts` is the worked example of the hook.
 */

import { defineEventModule } from "./module.js";
import { readInteger, requirePayload } from "./payload.js";

/**
 * The longest a single tick may be: one day.
 *
 * A bound is required by `readInteger`, and this is the defensible one. A
 * session lasting more than a day is not a session, and an event log that
 * advances the clock by a decade is a generation bug the fold should report
 * rather than render as a plausible-looking date.
 */
export const MAX_TICK_MS = 86400000;

export const CLOCK_MODULE = defineEventModule({
  namespace: "clock",
  description: "Simulated time, which advances only when an event says so.",
  events: {
    "clock.tick": {
      version: 0,
      apply(context) {
        const payload = requirePayload(context);
        const ms = readInteger(payload, "ms", 0, MAX_TICK_MS, context.where);
        context.clock.advance(ms);
        return { summary: `ms=${String(ms)}` };
      },
    },
  },
});
