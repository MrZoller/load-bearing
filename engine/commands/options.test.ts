import { describe, expect, it } from "vitest";

import { CommandOptionError, parseCommandOptions } from "./options.js";

const SPECS = [
  { key: "all", short: "a", long: "all" },
  { key: "long", short: "l", long: "long" },
  { key: "output", short: "o", long: "output", value: "required" },
] as const;

describe("parseCommandOptions", () => {
  it("parses clusters, long options, attached values, and duplicate occurrences", () => {
    expect(
      parseCommandOptions(
        ["-la", "--all", "-ofile", "--output=other", "path"],
        SPECS,
      ),
    ).toEqual({
      options: {
        all: [null, null],
        long: [null],
        output: ["file", "other"],
      },
      operands: ["path"],
    });
  });

  it("uses the next argument as a required value", () => {
    expect(
      parseCommandOptions(["-o", "file"], SPECS).options["output"],
    ).toEqual(["file"]);
  });

  it("treats everything after -- as an operand", () => {
    expect(parseCommandOptions(["-a", "--", "-l", "--all"], SPECS)).toEqual({
      options: { all: [null], long: [], output: [] },
      operands: ["-l", "--all"],
    });
  });

  it.each([
    [["-z"], /unknown short option/],
    [["--missing"], /unknown long option/],
    [["-o"], /missing required value/],
    [["--all=yes"], /takes no value/],
  ] as const)("rejects malformed options", (argv, expected) => {
    expect(() => parseCommandOptions(argv, SPECS)).toThrow(expected);
  });

  it("rejects ambiguous option specifications", () => {
    expect(() =>
      parseCommandOptions(
        [],
        [
          { key: "one", short: "x" },
          { key: "two", short: "x" },
        ],
      ),
    ).toThrow(CommandOptionError);
  });
});
