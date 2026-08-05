# Load Bearing

A daily interactive comedy wearing the costume of a serious developer tool —
a deterministic terminal simulation where everything is load-bearing.

Each day, visitors investigate a new fictional production incident inside a
coding-agent TUI. Ordinary engineering actions reveal that everything is
load-bearing, that the agent has made the situation worse, or that the agent
itself is deteriorating. The costume is real: commands affect shared state,
files can be inspected and changed, git history stays coherent, tests and
services react, and switching models changes what happens next.

The joke is not the deteriorating agent. The joke is the moment a visitor
realizes the world is real.

## Design

- [`ROADMAP.md`](ROADMAP.md) — phase order and definitions of done
- [`docs/DESIGN.md`](docs/DESIGN.md) — experience design and comedy bible
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — engine, cartridge spec, pipeline
- [`CLAUDE.md`](CLAUDE.md) — invariants and working agreements

The two that govern everything else: the runtime owns mechanics and
cartridges own worlds, and `state = reduce(cartridge, seed, eventLog)` — no
wall-clock time and no unseeded randomness anywhere in the engine.

## Setup

```
npm install
```

## Development

- Test: `npm test`
- Format: `npm run format`
- Typecheck: `npm run typecheck`

## Status

Phase 0 — headless state engine. Nothing renders yet.

## License

MIT
