import type { CommandOptionSpec, ParsedCommandOptions } from "./types.js";

export class CommandOptionError extends Error {
  readonly token: string;
  readonly detail: string;

  constructor(token: string, detail: string) {
    super(`option ${JSON.stringify(token)}: ${detail}`);
    this.name = "CommandOptionError";
    this.token = token;
    this.detail = detail;
  }
}

/** Parse short/long options, clusters, required values, and the `--` terminator. */
export function parseCommandOptions(
  argv: readonly string[],
  specs: readonly CommandOptionSpec[],
): ParsedCommandOptions {
  const byShort = new Map<string, CommandOptionSpec>();
  const byLong = new Map<string, CommandOptionSpec>();
  const keys = new Set<string>();
  const values: [string, (string | null)[]][] = [];

  for (const declared of specs) {
    const key = declared.key;
    const short = declared.short;
    const long = declared.long;
    const value = declared.value ?? "none";
    if (key === "" || keys.has(key)) {
      throw new CommandOptionError(
        key,
        "option keys must be non-empty and unique",
      );
    }
    if (short === undefined && long === undefined) {
      throw new CommandOptionError(
        key,
        "an option needs a short or long spelling",
      );
    }
    if (short !== undefined && (short.length !== 1 || short === "-")) {
      throw new CommandOptionError(
        short,
        "short options are one character other than '-'",
      );
    }
    if (
      long !== undefined &&
      (long === "" || long.includes("=") || long.startsWith("-"))
    ) {
      throw new CommandOptionError(
        long,
        "long options omit leading dashes and '='",
      );
    }
    if (value !== "none" && value !== "required") {
      throw new CommandOptionError(key, "value must be 'none' or 'required'");
    }
    if (short !== undefined && byShort.has(short)) {
      throw new CommandOptionError(short, "duplicate short option");
    }
    if (long !== undefined && byLong.has(long)) {
      throw new CommandOptionError(long, "duplicate long option");
    }
    const spec = Object.freeze({ key, short, long, value });
    keys.add(key);
    if (short !== undefined) byShort.set(short, spec);
    if (long !== undefined) byLong.set(long, spec);
    values.push([key, []]);
  }

  const options = Object.fromEntries(values) as Record<
    string,
    (string | null)[]
  >;
  const operands: string[] = [];
  let terminated = false;

  const add = (spec: CommandOptionSpec, value: string | null): void => {
    const list = options[spec.key];
    if (list === undefined)
      throw new CommandOptionError(spec.key, "unregistered option key");
    list.push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (terminated || token === "-" || !token.startsWith("-")) {
      operands.push(token);
      continue;
    }
    if (token === "--") {
      terminated = true;
      continue;
    }
    if (token.startsWith("--")) {
      const spelling = token.slice(2);
      const equal = spelling.indexOf("=");
      const name = equal < 0 ? spelling : spelling.slice(0, equal);
      const inline = equal < 0 ? undefined : spelling.slice(equal + 1);
      const spec = byLong.get(name);
      if (spec === undefined)
        throw new CommandOptionError(token, "unknown long option");
      if ((spec.value ?? "none") === "none") {
        if (inline !== undefined)
          throw new CommandOptionError(token, "this option takes no value");
        add(spec, null);
      } else if (inline !== undefined) {
        add(spec, inline);
      } else {
        index += 1;
        const next = argv[index];
        if (next === undefined)
          throw new CommandOptionError(token, "missing required value");
        add(spec, next);
      }
      continue;
    }

    const cluster = token.slice(1);
    for (let offset = 0; offset < cluster.length; offset += 1) {
      const short = cluster[offset] as string;
      const spec = byShort.get(short);
      if (spec === undefined)
        throw new CommandOptionError(`-${short}`, "unknown short option");
      if ((spec.value ?? "none") === "none") {
        add(spec, null);
        continue;
      }
      const attached = cluster.slice(offset + 1);
      if (attached !== "") {
        add(spec, attached);
      } else {
        index += 1;
        const next = argv[index];
        if (next === undefined)
          throw new CommandOptionError(`-${short}`, "missing required value");
        add(spec, next);
      }
      break;
    }
  }

  return Object.freeze({
    options: Object.freeze(
      Object.fromEntries(
        Object.entries(options).map(([key, occurrences]) => [
          key,
          Object.freeze([...occurrences]),
        ]),
      ),
    ),
    operands: Object.freeze(operands),
  });
}
