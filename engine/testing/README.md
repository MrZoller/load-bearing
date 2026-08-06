# The determinism harness

`state = reduce(cartridge, seed, eventLog)` is only true if something checks.
Two mechanisms do: the **purity gate** stops the engine from acquiring a source
of nondeterminism, and **golden replay fixtures** prove that identical input
still produces identical output.

Both run in CI on every push, and on a pull request when it opens
(`.github/workflows/ci.yml` — one run per commit, from the first commit rather
than from whenever a PR is opened).
Locally, `npm run verify` runs the same four checks in the same order.

---

## Golden replay fixtures

A fixture is a directory under `engine/__fixtures__/replay/`:

```
001-engine-smoke/
  fixture.json      the input triple  — committed by hand
  state.json        recorded state    — generated
  transcript.txt    recorded output   — generated
```

`fixture.json`:

| field         | meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `name`        | must equal the directory name                               |
| `description` | what this fixture protects, for the human reading a failure |
| `seed`        | seed material for the PRNG                                  |
| `cartridge`   | the world                                                   |
| `events`      | the append-only event log to fold                           |

The recorded artifacts are written by the canonical serializer
(`engine/serialize/canonical.ts`): keys sorted by UTF-16 code unit, exact
number formatting, LF endings, one trailing newline. Comparison is byte for
byte — a single changed byte fails the suite, with a diff of the region that
moved.

### Adding one

1. Create the directory and write `fixture.json`. Name it `NNN-what-it-proves`;
   the numeric prefix is what makes the suite's order readable.
2. Run `npm run fixtures:update`.
3. **Read the recording.** This is the step that matters. The artifacts are
   about to become the contract, so anything wrong in them is now the expected
   answer.
4. Commit all three files together.

Every Phase 0 subsystem PR adds at least one fixture. A subsystem with unit
tests and no fixture is tested against its own idea of correct rather than
against the replay contract.

### When one fails

Either the engine changed behavior it should not have, or it changed behavior
it should have. Only you know which.

- **Unintended:** fix the engine. The fixture is right.
- **Intended:** re-record with `npm run fixtures:update`, review the diff, and
  **justify the change in the PR description**. Golden replay fixtures are
  contracts (CLAUDE.md → Working agreements); a recording that changes without
  explanation is a determinism regression that got waved through.

CI never re-records. A harness that refreshed its own baselines would convert
the one signal it exists to raise into a silent diff.

To re-record a single fixture: `npm run fixtures:update -- 001-engine-smoke`.

---

## The purity gate

`npm run gate:purity` scans non-test sources under `engine/` and fails the
build on:

| rule                        | catches                                                            | invariant |
| --------------------------- | ------------------------------------------------------------------ | --------- |
| `math-nondeterministic`     | every `Math` member outside the exact allowlist                    | 2         |
| `math-alias`                | any `Math` reference that is not an immediate dotted access        | 2         |
| `locale-sensitive`          | `Intl`, `toLocaleString`, `localeCompare`, `toLocale*`             | 2         |
| `gc-timing`                 | `WeakRef`, `FinalizationRegistry`                                  | 2         |
| `dynamic-eval`              | `eval`, `Function` (value or type), `.constructor`                 | 2         |
| `error-stack`               | `.stack`, `{ stack } =`, `captureStackTrace`                       | 2         |
| `host-error-message`        | `.message` on an error — built-in text is unstandardized           | 2         |
| `identifier-escape`         | `D\u0061te` and every other escaped identifier                     | 2         |
| `symlinked-source`          | any symbolic link under a scanned tree, directories included       | 3         |
| `computed-import-target`    | `import(x)` where `x` is not a literal                             | 3         |
| `specifier-escape`          | a `\u` escape inside a module specifier                            | 3         |
| `host-capability`           | `Atomics`, `SharedArrayBuffer`                                     | 2         |
| `computed-member`           | `x["constructor"]`, `x["stack"]`, and the other banned members     | 2         |
| `ambient-declaration`       | `declare const/function/class/enum/global/…`                       | 3         |
| `type-suppression`          | `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`                    | 3         |
| `prototype-mutation`        | `setPrototypeOf`, `__proto__`, `defineProperty(X.prototype, …)`    | 4         |
| `exponentiation`            | `**` and `**=`, which `Math.pow`'s ban implies                     | 2         |
| `missing-runtime-module`    | an import satisfied only by a `.d.ts`                              | 3         |
| `regexp-statics`            | `RegExp.$1`, `RegExp.lastMatch`, any `RegExp.` static              | 2         |
| `global-object`             | `globalThis`                                                       | 3         |
| `proxy-reflection`          | `Proxy`, `Reflect`                                                 | 2         |
| `bare-package-import`       | any dependency not in `APPROVED_PACKAGES` (currently none)         | 6         |
| `test-module-import`        | a production import of a `*.test.*` module                         | 3         |
| `unscanned-import`          | a relative import leaving the scanned tree, or into `__fixtures__` | 3         |
| `import-meta`               | `import.meta`                                                      | 3         |
| `allowlisted-module-import` | a production import of an allowlisted module                       | 3         |
| `crypto-random`             | the `crypto` global — `subtle.generateKey` as much as `randomUUID` | 2         |
| `wall-clock-date`           | the `Date` global                                                  | 2         |
| `wall-clock-performance`    | the `performance` global — `timeOrigin` as much as `now`           | 2         |
| `wall-clock-timer`          | `setTimeout`, `setInterval`, `setImmediate`, and their `clear`s    | 2         |
| `ambient-process`           | the `process` global                                               | 3         |
| `node-global`               | `Buffer`, `__dirname`, `__filename`, `global`, `require`           | 3         |
| `dom-global`                | `document`, `window`, `navigator`, `localStorage`, `jsdom`, …      | 3         |
| `node-builtin-import`       | `node:fs`, bare `path`, `fs/promises`, and every other built-in    | 3         |
| `ambient-types-reference`   | `/// <reference types/lib/path="…" />`                             | 3         |
| `network`                   | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`              | 6         |

Every rule bans a whole global rather than a call site: `Date`, not `Date.now`;
`crypto`, not `crypto.randomUUID`; `fetch`, not `fetch(`. `const later = Date`
and `const schedule = setTimeout` are the same leaks with an extra step, and an
enumeration of members always misses one — `performance.timeOrigin` and
`crypto.subtle.generateKey` both got through an earlier version.

`crypto`, `performance`, `process`, and the `node-global` set matter most,
because they need no import: nothing in the file header hints they are there.

**`Math` is the exception**, and inverted: `Math.floor`, `max`, `imul`, `PI`
and the rest of the exactly-specified members are allowed, everything else is
not. Two reasons. `random` is reachable without ever being spelled
(`const { random } = Math`, `Math["random"]`), so `math-alias` bans any `Math`
reference that is not an immediate dotted access. And the transcendentals —
`sin`, `cos`, `tan`, `pow`, `exp`, `log`, `hypot`, `cbrt` — are
implementation-approximated: `Math.tan(1e300)` differs in its last two digits
between V8 and JavaScriptCore, which is a byte difference in `state.json`
between a Chrome session and a Safari one. Invariant 3 requires the engine to
run on both.

The allowlist is drawn from what the spec pins, not from what engines happen to
agree on today — which is why `sqrt` is absent even though IEEE 754 requires it
to be correctly rounded and every engine defers to the hardware. ECMA-262 still
calls it implementation-approximated, and nothing in a terminal simulation
needs a square root, so the cheap answer is to not have the argument.

Three bans exist because the gate's own design creates the opening. Blanking
string literal text is what makes simulated shell output cheap to write — and
it is exactly what lets a string become code or a property name again:

- `eval("Math.random()")` and `Function("return Date.now()")` turn ignored text
  straight back into running code, so `dynamic-eval` bans both primitives,
  aliases included.
- `globalThis["Date"].now()` reaches wall-clock time with no banned identifier
  anywhere in the code view, because the property name is a string. A headless
  engine has no reason to touch the global object, so `globalThis` is banned
  outright.

And an error's `.stack` is host-formatted and carries absolute paths, so
recording one would put a developer's filesystem into replayed state.

**Consequence for issues #5, #9, and #10:** `ls` ordering, `ls -l` timestamps,
and `git log` dates must be formatted and sorted by hand. `localeCompare` sorts
`å` before `z` in Swedish and after it in German, so a directory listing would
differ between a laptop and CI. A bare `sort()` is UTF-16 code-unit order and
is fine.

**Naming consequence:** because `process` is banned as a whole identifier,
engine code must not name a local `process` — the simulated process model's
locals are `proc`, `entry`, or `row`. Enumerating `process` members instead
would not work: the ones a simulated `ps` row carries (`pid`, `ppid`, `title`,
`uptime`) are exactly the ones a real leak reads.

Every hit reports `file:line:column`, the offending line, and the invariant it
breaks. Run it against another directory to see it work:

```
node scripts/gate-purity.mjs scripts/gate-purity-samples
```

### What the gate reads

Comments, string literal _text_, and regex literals are blanked before the
rules run. So a doc comment explaining why a module avoids `Date.now` is fine,
and so is the `"Date:   "` column header that simulated `git log` output needs
— that string is mechanics, and mechanics live in engine source.

Template _interpolations_ survive the blanking: `` `${Date.now()}` `` is
caught. Blanking a template wholesale would hide the one thing inside it worth
catching.

Import specifiers are strings, so the module-specifier rule reads a second view
of the file with strings left intact — then cross-checks the first, requiring
the `from` / `import` / `require` keyword to be real code. That way
`const example = 'import "node:fs"'` is not mistaken for an import.

### Known limits

Two, both stated rather than papered over.

A regex literal immediately following a keyword (`return /a\/\/b/`) is read as
division by the regex-versus-division heuristic. Assign such regexes to a
constant.

And a member name assembled at runtime — `["con", "structor"].join("")` — is
out of reach. Catching it would mean evaluating the program, which no static
analysis does; a syntax-aware rewrite of this gate would not help either. The
literal spellings are rejected, which covers the accident; this gate's threat
model is a plausible mistake, not an adversary with commit access. The
serializer's own rejections are the backstop if one ever gets through.

`ambient-types-reference` is the exception to all of the above — it is matched
against raw source, because the thing it looks for lives inside a comment and
means something to the compiler anyway.

The two `import`-shaped rules and `symlinked-source` share a shape worth
naming: the scanner decides what to read by walking directories, while
TypeScript and every bundler decide by following imports. Anything the walk
skips but an import reaches is a hole, and those are the three ways it happens.

### The engine's own tsconfig

`tsconfig.json` covers the whole repository and pulls in `@types/node`, because
the tooling around the engine genuinely needs it. TypeScript's global type
scope is per _program_, though, so inside that program `Buffer.from(…)`,
`__dirname`, and `global` typecheck happily in engine sources that must run in
a browser.

`tsconfig.engine.json` is the engine's own program with `types: []`, and
`npm run typecheck` runs both. Its exclusions are exactly the purity gate's
allowlist plus its test-file pattern — one concept with two enforcement points,
with `engine/testing/fixtures.ts` the single documented exception in each.

Note that `types: []` alone would not be enough: an explicit
`/// <reference types="node" />` inside any file of the program loads Node's
globals for every file in it. That is what the `ambient-types-reference` rule
is guarding.

`allowJs` and `checkJs` are on because the gate scans `.js`, `.jsx`, `.mjs`,
and `.cjs` under `engine/`. Without them a JavaScript engine source would be
checked by a text grep alone, and a grep cannot know that `location.origin` is
a browser ambient.

The engine program also has no `console`, `URL`, `TextEncoder`, or
`structuredClone`, since `lib` is `ES2022` and nothing supplies the rest.
Nothing needs them yet. When something does, add a curated
`engine/globals.d.ts` rather than putting `"DOM"` in `lib`, which would hand
the engine `document`, `window`, and `fetch` types along with it.

### Allowlist

`ALLOWLIST` in `scripts/gate-purity.mjs` exempts a specific file from a
specific rule, with a written reason. It currently has one entry:
`engine/testing/fixtures.ts` reads fixture files from disk, which is the one
legitimate use of `node:fs` under `engine/` — it is test infrastructure, never
imported by simulation code, and never bundled for the browser. The pure half
of the harness (`replay.ts`) has no such dependency.

Entries that point at a missing file, or that no longer suppress anything, fail
the gate. An allowlist that rots is worse than no allowlist.

The entry's justification is always some form of "nothing in the engine imports
this", so `allowlisted-module-import` enforces exactly that: a production
engine module importing an allowlisted file is a violation at the import, not
at the allowlisted file. Specifiers are compared by module identity, so the
extensionless spelling `moduleResolution: "bundler"` permits cannot walk past
it. Note that `tsconfig.engine.json`'s `exclude` does not help here —
TypeScript still follows an import into an excluded file, and so would a
bundler.

`test-module-import` is the same idea for the other exemption: a test module
is skipped by the scanner, which is only safe while nothing production imports
it. `unscanned-import` completes the set — a relative path that leaves the
scanned tree is followed by TypeScript and by every bundler while nothing
checks it.

`APPROVED_PACKAGES` is the same idea for dependencies, and is empty. A
package's own code is never scanned, so approving one means asserting by hand
that it reads no clock, draws no randomness, and touches no network.

### What the gate cannot do

A `Proxy` cannot be detected from inside JavaScript: reflecting over one runs
its traps, so the canonical serializer cannot refuse one before it has already
executed user code. Two things narrow that. The serializer takes a single
`Object.getOwnPropertyDescriptors` snapshot and reads everything from it, so a
hostile proxy gets one opportunity to lie rather than one per check. And the
`proxy-reflection` rule stops engine code creating a proxy at all — which is
the realistic defence, since cartridges arrive as JSON and cannot carry one.

Adding a second entry should feel like a design decision worth arguing about,
because it is one.
