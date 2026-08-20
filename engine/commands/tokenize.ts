/** A shell input error whose wording is deterministic engine data. */
export class ShellSyntaxError extends Error {
  readonly reason:
    | "dangling escape"
    | "unterminated single quote"
    | "unterminated double quote";

  constructor(reason: ShellSyntaxError["reason"]) {
    super(`shell syntax: ${reason}`);
    this.name = "ShellSyntaxError";
    this.reason = reason;
  }
}

/**
 * Split one command line with the quoting rules Phase 0 needs.
 *
 * Whitespace separates unquoted words, quotes may create empty arguments, and
 * a backslash quotes the next character outside or inside double quotes. There
 * is deliberately no expansion, globbing, operator parsing, or host shell.
 */
export function tokenizeShell(input: string): readonly string[] {
  const argv: string[] = [];
  let word = "";
  let active = false;
  let quote: "single" | "double" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        index += 1;
        if (index >= input.length)
          throw new ShellSyntaxError("dangling escape");
        const escaped = input[index] as string;
        if (escaped === "\n") continue;
        word +=
          escaped === '"' ||
          escaped === "\\" ||
          escaped === "$" ||
          escaped === "`"
            ? escaped
            : `\\${escaped}`;
      } else {
        word += character;
      }
      continue;
    }

    if (
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r"
    ) {
      if (active) {
        argv.push(word);
        word = "";
        active = false;
      }
    } else if (character === "'") {
      active = true;
      quote = "single";
    } else if (character === '"') {
      active = true;
      quote = "double";
    } else if (character === "\\") {
      active = true;
      index += 1;
      if (index >= input.length) throw new ShellSyntaxError("dangling escape");
      const escaped = input[index] as string;
      if (escaped !== "\n") word += escaped;
    } else {
      active = true;
      word += character;
    }
  }

  if (quote === "single")
    throw new ShellSyntaxError("unterminated single quote");
  if (quote === "double")
    throw new ShellSyntaxError("unterminated double quote");
  if (active) argv.push(word);
  return Object.freeze(argv);
}
