# Contributing

Issues and pull requests are welcome. [The README](README.md#contributing) lists
what this needs most, and [`docs/roadmap.md`](docs/roadmap.md) has the full
list with the reasoning behind each gap.

## Before you start

```bash
bun install
make check && make check-clean && make test
```

`make dev` runs the app against a real herdr with HMR. No herdr to hand?
`bun run build:web && bun src/server/index.ts --demo` serves synthetic agents.

## Four house rules

Each of these has already caught a real mistake in this repo.

**1. This repo is public.** Never commit hostnames, home paths, usernames,
employer terms, or real agent names — including in comments, commit messages
and branch names. `make check-clean` enforces it and runs in CI. If it fails,
**fix the content; never add the string to a denylist.** Silencing the scanner
is the failure mode the scanner exists to prevent.

**2. Screenshots come from the demo build, never a live session.** Images
cannot be scanned, so the only safe source is data that was invented to begin
with. Fixtures and demo data use invented agent names (`api-refactor`,
`flaky-test-fix`, `docs-cleanup`, `schema-migration`).

**3. Measure rather than assume.** [`docs/gotchas.md`](docs/gotchas.md) is a
list of things that turned out to be false once checked against a live herdr.
If you are about to write "this should be fast" or "this cannot happen",
measure it, and put the number in the commit message.

**4. Prove a test can fail.** Break the thing it guards and watch it go red
before you trust it. A test that cannot fail is worse than none, because it
reads as coverage. Several in this repo exist because a mutation revealed the
original was checking nothing.

## Commits and pull requests

Say **why**, not just what — the reasoning is the part that survives. If a
change is driven by a measurement, include the measurement. If it fixes
something subtle, describe the failure it prevents so the next person does not
reintroduce it.

Keep pull requests focused. CI runs types, the public-repo scan, the full suite
and a demo build on every PR.
