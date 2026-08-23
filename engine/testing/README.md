# The determinism harness

`state = reduce(cartridge, seed, eventLog)` is only true if something checks.
Two mechanisms do: the **purity gate** stops the engine from acquiring a source
of nondeterminism, and **golden replay fixtures** prove that identical input
still produces identical output.

Both run in CI on every push, and on a pull request when it opens
(`.github/workflows/ci.yml` — one run per commit, from the first commit rather
than from whenever a PR is opened).
Locally, `npm run verify` runs the same checks in the same order.

The test step runs the whole suite twice, under `TZ=UTC` and `TZ=Asia/Tokyo`
(`npm run test:timezones`). The engine has no `Date` to read a host timezone
with, which is the claim being checked: a timestamp that started depending on
one would pass in CI's UTC and fail on a laptop. A guard in
`engine/clock/civil.test.ts` asserts the non-UTC run really is non-UTC, so a
typo in that script cannot silently degrade it to running UTC twice.

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

| field         | meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | must equal the directory name                                           |
| `description` | what this fixture protects, for the human reading a failure             |
| `seed`        | seed material for the PRNG                                              |
| `cartridge`   | fixture name, or the explicit allowlisted production incident reference |
| `events`      | the append-only event log to fold                                       |

`cartridge` is a **reference, not an inlined world**. Existing fixtures use a
name under `engine/__fixtures__/cartridges/`; a production golden may use only
`{ "kind": "incident", "id": "incident-001" }` (or the explicitly registered
`phase-1-demo`). The resolver has no path
traversal or open-ended incident lookup. Every fixture replays the same
committed cartridge, so a change to that world shows up in all of their
recordings at once; embedded copies would drift, and a shared contract that
holds in one recording and not the others is not a contract. The named file is
parsed and then run through `loadCartridge`, so every fixture exercises the
validator on the way in and records the _normalized_ world.

The recorded artifacts are written by the canonical serializer
(`engine/serialize/canonical.ts`): keys sorted by UTF-16 code unit, exact
number formatting, LF endings, one trailing newline. Comparison is byte for
byte — a single changed byte fails the suite, with a diff of the region that
moved.

Those bytes belong to the serializer, so the recordings are in
`.prettierignore` along with `content/schema/cartridge.v0.json`. Prettier
collapses a short array onto one line and the serializer always expands it;
the two agreed by accident until a recording first held a non-empty array.
Whichever tool writes a file owns its formatting.

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

### The fixtures so far

| fixture                               | what it pins                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001-engine-smoke`                    | the loop itself: an input triple folds, records, and compares. The shared cartridge is written with unsorted keys, so a key-ordering regression fails here                   |
| `002-random-clock`                    | the seed hash, the mulberry32 constants, `fork`'s path derivation, `int`'s rejection window, `weightedPick`'s distribution, and the UTC calendar arithmetic                  |
| `003-cartridge-load`                  | load to initial state with an empty event log — normalization alone, isolated from the fold                                                                                  |
| `004-reducer-core`                    | the reducer's machinery at readable size: a stamped payload schema version, dispatch across two modules, a slice accumulating, transcript index and stamps                   |
| `005-vfs-lifecycle`                   | VFS create, overwrite, chmod, delete, and persistence of deletion across a later event                                                                                       |
| `006-vfs-git`                         | VFS edits reflected in Git status/diff, dirty checkout refusal, and atomic clean checkout across Git and VFS slices                                                          |
| `007-world-state`                     | environmental hydration plus replayable process, service, log, environment, and history transitions                                                                          |
| `008-command-shell`                   | unlogged shell expansion plus stable stream-tagged builtin, override, unknown, and blank command results                                                                     |
| `009-filesystem-commands`             | shell-driven VFS creation, cwd persistence, deletion observed by later commands, and permission-denied output                                                                |
| `010-git-commands`                    | bounded Git command rendering and coherent shell-driven branch, index, working-tree, commit, blame and checkout transitions                                                  |
| `011-system-commands`                 | world inspection, raw shell history, exact endpoint responses, and persistent environment, service and process transitions                                                   |
| `012-test-runner-reactions`           | authored test outcomes and durations before/after a shell edit, plus ordered persistent service, process, health and dual-log reactions                                      |
| `013-agent-mind`                      | timestamped exact permission and intentionally false file/service beliefs, preserving an induced divergence through replay                                                   |
| `014-full-session`                    | one Phase 0 session spanning VFS mutation, Git restore, test failure and recovery, service/process reactions, permission, and belief divergence                              |
| `015-terminal-modes`                  | terminal mode and model transitions, then shell-driven incident-matched resume and the authored bare-exit refusal                                                            |
| `016-agent-artifacts`                 | authored response instantiation plus stable message/tool/thinking/todo identities, semantic updates, and stage-selected replayable activity                                  |
| `017-agent-intents`                   | recognized and fallback agent turns plus shell passthrough replaying through the shared shell event path                                                                     |
| `018-shared-machine-awareness`        | mode changes around a shared-machine mutation, resume divergence acknowledgment, and compacted belief replacement                                                            |
| `019-pending-permissions`             | authored exact-capability consent, simulated-time resolution, atomic prompt clearing, and a durable standing grant                                                           |
| `020-incident-001-story`              | Incident #001's shared graph: ordered reveal/callback facts, exact waiver ledger timestamp, belief-selected variant, non-terminal ending discovery, and continued input      |
| `021-incident-001-load-balancer`      | Incident #001's operator-permitted route replacement and undo: ordered npm test and health-endpoint evidence, service-health reactions, and cp -p metadata preservation      |
| `022-story-consequences`              | one logged outer story beat atomically updates its counter, VFS file, service, process and log through trusted owner events, while a reaction observes the derived VFS event |
| `023-atomic-permission-continuations` | grant, deny, always-allow and standing permission continuations plus denied and exact simulated-time waiver consent through unlogged atomic envelopes                        |

`002` records 1000 raw draws eight to a line with their index, so a divergence
names the draw it started at rather than reporting that a file changed.

`003` exists so two contracts can fail apart. A change to the reducer moves
`001`, `002` and `004` and leaves `003` alone; a diff in `003` means
normalization changed — a default filled differently, a section defaulting to
something other than empty, or key ordering moving.

T32's closed story contract is covered directly by
`engine/story/conditions.test.ts`, `engine/story/story.test.ts`, the loader/schema
tests, and `020`'s focused replay assertions. `020` uses the low-level
`mind.waiver-consent-recorded` event only to prove the ledger's replay contract;
it does not imply visitor-facing waiver capture, which remains T34. Its replay
also proves the selected shared story state is unchanged when a different
Incident #001 model is initial, rather than allowing model-owned graphs. Later
tasks still author the visitor routes and consequences for the other matrix rows.

T33's closed consequence union is covered by `engine/story/actions.test.ts`,
the loader's reference/cycle/work-limit cases, and `022`'s semantic replay
assertion. The fixture deliberately keeps the one outer `story.beat-reached`
event visible while recording the staged cross-owner state it alone caused.

### Why the transcript appears in both artifacts

The transcript is _state_: the reducer folds a `TranscriptEntry` per logged event into
`SessionState.transcript`, because `state = reduce(cartridge, seed, eventLog)`
has to be the whole session and a transcript accumulated on the side would not
be reproducible from a snapshot. So `state.json` holds the structured entries
and `transcript.txt` holds the rendering of them
(`engine/events/transcript.ts`).

That is one contract recorded twice, not two contracts. The duplication is the
price of being able to say that a divergence is in the _entry_ — a summary, a
detail line, an event's stamped instant — rather than in a formatter, and
`engine/session.test.ts` asserts the rendering is a function of the entries so
the two can never drift apart.

### Cartridge fixtures

`engine/__fixtures__/cartridges/` holds the worlds, not the sessions:

```
minimal.json                  baseline loader and reducer world
reactive.json                 focused test-runner and reaction-cascade world
commands/filesystem/git/world focused subsystem worlds
invalid/*.json                one malformed cartridge per rejection worth asserting
```

These live here rather than under `content/incidents/` because they are not
incidents and must never appear in the archive.

The `invalid/` set is exercised by `engine/cartridge/load.test.ts`, which
asserts each one's full issue list — pointer, expectation and what was found —
rather than just that it threw. A validator that rejects for the wrong reason
is a validator that will accept the wrong thing later.

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

## VFS and Git coverage

`npm run test:coverage` measures every production implementation file under
`engine/vfs/` and `engine/git/` per file. Tests, declarations, and the type-only
`types.ts` modules are excluded; any new runtime source file in either tree is
included automatically. The floors are 93% statements and lines, 75% branches,
and 100% functions.

Those percentages are an anti-regression inventory gate, not the definition of
full filesystem and Git behavior. The named semantic tests listed in
`engine/README.md` carry that contract.

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
| `caught-error-coercion`     | interpolating, `String()`-ing, or concatenating a catch binding    | 2         |
| `identifier-escape`         | `D\u0061te` and every other escaped identifier                     | 2         |
| `symlinked-source`          | any symbolic link under a scanned tree, directories included       | 3         |
| `computed-import-target`    | `import(x)` where `x` is not a literal                             | 3         |
| `specifier-escape`          | a `\u` escape inside a module specifier                            | 3         |
| `host-capability`           | `Atomics`, `SharedArrayBuffer`                                     | 2         |
| `async-scheduling`          | `Promise`, `queueMicrotask`, `async`, `await`                      | 2         |
| `computed-member`           | `x["constructor"]`, `x["stack"]`, and the other banned members     | 2         |
| `ambient-declaration`       | `declare const/function/class/enum/global/…`                       | 3         |
| `type-suppression`          | `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`                    | 3         |
| `prototype-mutation`        | `setPrototypeOf`, `__proto__`, `defineProperty(X.prototype, …)`    | 4         |
| `exponentiation`            | `**` and `**=`, which `Math.pow`'s ban implies                     | 2         |
| `missing-runtime-module`    | an import satisfied only by a `.d.ts`                              | 3         |
| `regexp-statics`            | any `RegExp` reference that is not `new RegExp(…)`                 | 2         |
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

The date half of that is already built: `engine/clock/civil.ts` turns epoch
milliseconds into UTC calendar fields and carries the C-locale `MONTH_NAMES`
and `WEEKDAY_NAMES` tables that `git log` and `ls -l` print. Build those
formats from `CivilTime` — do not reach for `Date` or `Intl`, which is what
the gate is stopping.

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
specific rule, with a written reason. It has two entries, and each earns it
differently.

`engine/testing/fixtures.ts` reads fixture files from disk, which is the one
legitimate use of `node:fs` under `engine/` — it is test infrastructure, never
imported by simulation code, and never bundled for the browser. The pure half
of the harness (`replay.ts`) has no such dependency.

`engine/globals.d.ts` declares `structuredClone`, and nothing else. The
engine's program is `lib: ["ES2022"]` with `types: []`, so an ambient
declaration is the only way to reach a host global — which is exactly what the
`ambient-declaration` rule exists to stop, and why this file is one line long.

It earns the exemption by closing something no alternative can. The serializer
has to answer whether a value is really plain data, and a prototype can be
re-pointed, so `getPrototypeOf` can be lied to. Structured clone reads internal
slots instead: it either refuses the value or returns a copy wearing the true
prototype. Every other approach is an enumeration of named built-ins —
incomplete by construction, and unable to name the constructors this gate
itself bans (`SharedArrayBuffer`, `Promise`, `WeakRef`,
`FinalizationRegistry`). Before it, a `Map` with a re-pointed prototype was
caught and a `Promise` with one was not, for no better reason than which
identifiers the gate permits.

Adding a _second_ global to that file would not be a formality. The paragraph
above is the shape a new one has to match.

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

Adding a third entry should feel like a design decision worth arguing about,
because it is one. The second took ten rounds of review to argue for, and the
argument that won was not "this is inconvenient" — it was that the alternative
was incomplete in a way no amount of care could fix.
