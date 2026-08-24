export UID := $(shell id -u)
export GID := $(shell id -g)

PADDOCK_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
PADDOCK_BUILD_TIME ?= $(shell date -u +"%Y-%m-%d %H:%M UTC")
export PADDOCK_COMMIT
export PADDOCK_BUILD_TIME

# No `2>/dev/null`. CLAUDE.md forbids it, this branch's own
# tests/install-script.test.ts enforces against it in install.sh, and a
# Makefile that breaks the rule while the tests enforce it is the repo
# contradicting itself. `git describe --exact-match` writes to stderr on any
# untagged commit — the normal case — which is why the old form silenced it.
# `git tag --points-at HEAD` answers the same question with an empty stdout
# and no error at all, so nothing needs suppressing. Outside a git work tree
# it still says so on stderr, and VERSION falls back; that message is
# information, not noise.
#
# The leading `v` is stripped, matching .github/workflows/release.yml's
# `${GITHUB_REF_NAME#v}` — otherwise a local build of tag v0.2.0 would report
# `v0.2.0` while the released binary for the same tag reports `0.2.0`.
TAG := $(firstword $(shell git tag --points-at HEAD))
VERSION := $(if $(TAG),$(TAG:v%=%),0.0.0-dev)

.PHONY: dev types icons check check-clean embed build-web test build formula up down logs restart

# A real directory target, deliberately NOT in .PHONY: make compares its mtime
# against package.json and bun.lock, so this installs on a fresh clone or after
# a dependency change and is a no-op otherwise. `touch` because bun does not
# always bump the directory's mtime when it decides there is nothing to do,
# which would re-run the install on every single target.
#
# Only the targets that actually need a dependency depend on this. `types` and
# `embed` import nothing outside Bun and node builtins, and keeping them free
# of it means the herdr type generator still runs on a clone with no install.
node_modules: package.json bun.lock
	bun install
	touch node_modules

# scripts/dev.sh regenerates src/server/embedded.ts before it starts the
# server — deliberately inside the script rather than as a prerequisite here,
# so that running the script directly works too. See the comment there.
dev: node_modules
	bash scripts/dev.sh

types:
	bun run scripts/gen-herdr-types.ts

# Redraw every icon from assets/logo.svg. Deliberately NOT part of `make build`:
# the rasters are committed so the server can ship them and GitHub can render the
# README without a build step, and this needs an SVG rasteriser that CI has no
# reason to install. Run it when the mark changes, then review the PNGs.
icons:
	bash scripts/build-icons.sh

# Regenerates src/server/embedded.ts (gitignored — see scripts/gen-embedded.ts
# for why). Writes an EMPTY map when dist/ has not been built yet, which is
# what lets `make check` typecheck on a fresh clone before anything is built.
embed:
	bun run scripts/gen-embedded.ts

# NOT `bunx tsc`. With node_modules absent, bunx resolves TypeScript from the
# REGISTRY instead of the pin in package.json, so a fresh clone typechecked
# against whatever major is newest — TS 7, which has REMOVED `baseUrl`. That
# turned the fresh-clone path the `embed` comment above exists to support into
# a hard `error TS5102` on a tsconfig.json that is correct for the pinned
# compiler. Running the binary out of node_modules is what makes the `^5.7.0`
# in package.json the thing that actually decides.
check: node_modules embed
	./node_modules/.bin/tsc --noEmit

check-clean:
	bash scripts/check-private.sh .

build-web: node_modules
	bun run build:web

# The UI is built FIRST. Part of the suite reads real build output —
# dist/assets, dist/index.html — and running the tests before the build meant
# those tests found nothing to check and passed by skipping, which on a clean
# checkout (i.e. CI) was every run. They now fail rather than skip, so this
# ordering is load-bearing: use `make test`, not a bare `bun test`.
#
# `embed` reruns AFTER build-web, not before: an earlier `make check` may have
# already written an EMPTY map (no dist/ yet at that point), and that stale
# empty map would otherwise sit on disk while the tests run, embedding nothing
# into the standalone binary tests/embedded.test.ts compiles.
test: build-web
	bun run scripts/gen-embedded.ts
	bun test

build: check check-clean test
	bun run build:web
	$(MAKE) embed
	bun build --compile --target=bun \
	  --define 'process.env.PADDOCK_VERSION="$(VERSION)"' \
	  src/server/index.ts --outfile paddock

# Renders the tap formula so it can be eyeballed without cutting a release.
# The release workflow runs the same script against the real SHA256SUMS; point
# this at any sums file:  make formula SUMS=/tmp/SHA256SUMS
SUMS ?= out/SHA256SUMS
FORMULA_OUT ?= out/paddock.rb
formula:
	bun run scripts/render-formula.ts $(VERSION) $(SUMS) $(FORMULA_OUT)

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart
