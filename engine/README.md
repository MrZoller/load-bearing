# Engine API

The engine is the headless, deterministic boundary that later runtimes render.
It is pure TypeScript with no DOM or Node dependency and no runtime packages.
Callers provide parsed cartridge data, seed material, and events; the engine
returns frozen plain data. It never reads files, the host clock, a host
timezone, randomness, or the network.

Import the public surface from `engine/index.ts`.

## Session entry points

- `loadCartridge(input: unknown)` validates and normalizes parsed JSON into a
  frozen `LoadedCartridge`. Invalid input throws `CartridgeValidationError`,
  whose ordered `issues` report every schema failure as data.
- `bootstrap({ cartridge, seed, registry? })` creates the zero-event
  `SessionState`. The cartridge must already have passed `loadCartridge`.
- `step(state, event, registry?)` applies one event and returns a new frozen
  state. A state must be stepped with the same registry that bootstrapped it;
  changing the registry changes slice ownership and event semantics.
- `reduce({ cartridge, seed, events, registry? })` is the canonical fold:
  `state = reduce(cartridge, seed, eventLog)`.
- `replaySession(input)` wraps `reduce` and returns both the final `state` and
  transcript lines rendered from `state.transcript`. This is the normal
  whole-session entry point for runtimes and tests.

`ENGINE_EVENT_REGISTRY` is the built-in registry. Custom registries exist for
isolated engine tests and extensions; production session code should not swap
one during a fold.

## Agent state

`engine/agent/` registers the replayable Phase 1 agent slice. It stores bounded
plain-JSON messages, tool calls, thinking blocks, todos, activity, and authored
response instance records. `agent.response-recorded` references cartridge
content by response id and derives artifact ids from its stable instance id;
runtime code does not copy authored behavior. Status updates follow closed
forward-only transitions, and hostile snapshots are checked for exact fields,
bounds, unique ids, response references, and matching response messages.

`engine/agent/awareness.ts` plans resume and compact transitions from only the
loaded cartridge and replayed `SessionState`. Opening beliefs are installed on
the first resume; later resumes select authored unchanged/changed responses from
`beliefDivergence`, while compact replaces the complete belief set before
recording its authored acknowledgment.

Disclosure state, focused controls, animation frames, and wall-time spinner
progress are presentation concerns and do not belong in this slice.

## Replay and purity contracts

Golden fixtures under `engine/__fixtures__/replay/` record canonical
`state.json` and `transcript.txt` bytes. The replay suite folds the same
cartridge, seed, and event log and compares both artifacts byte for byte. See
`engine/testing/README.md` before adding or deliberately re-recording one.

`npm run gate:purity` scans production engine sources for ambient time,
randomness, DOM, Node built-ins, network access, asynchronous scheduling, and
other host-dependent behavior. `npm run typecheck` also compiles the engine as
its own program without Node or DOM globals. `npm run verify` runs those gates,
coverage, golden replays, and the full suite under UTC and Asia/Tokyo.

## Filesystem and Git coverage

“Full unit coverage” is semantic, not a claim that a percentage proves
correctness. Named tests cover path-resolution edges, permission denial,
`mkdir -p`, copy and rename, persistent deletion, branch behavior, commit and
checkout coherence, and log/blame agreement. Those behaviors are the Phase 0
definition of full filesystem and Git coverage.

CI additionally measures every production implementation file under
`engine/vfs/` and `engine/git/`, excluding tests, declarations, and the
type-only `types.ts` modules. A newly extracted runtime file therefore enters
the measured inventory automatically. Each file must retain at least 93%
statements and lines, 75% branches, and 100% functions. These floors stop one
weak file from hiding behind an aggregate and prevent silent regression; they
do not replace the named semantic tests. Floors may be raised as coverage
improves.
