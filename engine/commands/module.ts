import { defineEventModule } from "../events/module.js";
import { requirePayload, readString } from "../events/payload.js";
import { MAX_TRANSCRIPT_DETAIL_LINES } from "../events/transcript.js";
import type { TranscriptOutput } from "../events/state.js";
import { executeShell } from "./shell.js";

function readLines(
  payload: Readonly<Record<string, unknown>>,
  key: "stdout" | "stderr",
  where: string,
): readonly string[] {
  const raw: unknown = payload[key];
  if (!Array.isArray(raw)) throw new Error(`${where}: ${key} must be an array`);
  const lines: string[] = [];
  const count = raw.length;
  for (let index = 0; index < count; index += 1) {
    if (!(index in raw))
      throw new Error(`${where}: ${key}[${String(index)}] is a hole`);
    const line: unknown = raw[index];
    if (typeof line !== "string")
      throw new Error(`${where}: ${key}[${String(index)}] must be a string`);
    lines.push(line);
  }
  return lines;
}

export const SHELL_MODULE = defineEventModule<never>({
  namespace: "shell",
  description: "unlogged shell execution envelopes and logged command results",
  events: {
    "shell.execute": {
      version: 0,
      apply(context) {
        const payload = requirePayload(context);
        const input = readString(payload, "input", context.where);
        return { expansion: executeShell(context.state, input) };
      },
    },
    "shell.result": {
      version: 0,
      apply(context) {
        const payload = requirePayload(context);
        const stdout = readLines(payload, "stdout", context.where);
        const stderr = readLines(payload, "stderr", context.where);
        const exitCode: unknown = payload["exitCode"];
        if (
          typeof exitCode !== "number" ||
          !Number.isInteger(exitCode) ||
          exitCode < 0 ||
          exitCode > 255
        ) {
          throw new Error(
            `${context.where}: exitCode must be an integer in [0, 255]`,
          );
        }
        if (stdout.length + stderr.length > MAX_TRANSCRIPT_DETAIL_LINES) {
          throw new Error(
            `${context.where}: command output exceeds ${String(MAX_TRANSCRIPT_DETAIL_LINES)} lines`,
          );
        }
        const output: TranscriptOutput[] = [
          ...stdout.map((text) =>
            Object.freeze({ stream: "stdout" as const, text }),
          ),
          ...stderr.map((text) =>
            Object.freeze({ stream: "stderr" as const, text }),
          ),
        ];
        return { output: Object.freeze(output), exitCode };
      },
    },
  },
});
