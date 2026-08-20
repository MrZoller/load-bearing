import { describe, expect, it } from "vitest";

import { ShellSyntaxError, tokenizeShell } from "./tokenize.js";

describe("tokenizeShell", () => {
  it.each([
    ["", []],
    ["  \t echo   one  two ", ["echo", "one", "two"]],
    ["echo 'one two'", ["echo", "one two"]],
    ['echo "one two"', ["echo", "one two"]],
    ["echo one\\ two", ["echo", "one two"]],
    ["echo '' \"\"", ["echo", "", ""]],
    ["echo a'b c'd", ["echo", "ab cd"]],
    ['echo "a\\"b"', ["echo", 'a"b']],
    ['echo "a\\qb"', ["echo", "a\\qb"]],
    ["echo one\\\ntwo", ["echo", "onetwo"]],
  ])("tokenizes %j", (input, expected) => {
    expect(tokenizeShell(input)).toEqual(expected);
  });

  it.each([
    ["echo '", "unterminated single quote"],
    ['echo "', "unterminated double quote"],
    ["echo \\", "dangling escape"],
  ])("rejects %j", (input, reason) => {
    expect(() => tokenizeShell(input)).toThrow(ShellSyntaxError);
    try {
      tokenizeShell(input);
      expect.unreachable("the tokenizer should reject malformed quoting");
    } catch (error) {
      expect(error).toMatchObject({ reason });
    }
  });
});
