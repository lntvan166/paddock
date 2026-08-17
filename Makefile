export UID := $(shell id -u)
export GID := $(shell id -g)

.PHONY: dev types check check-clean build-web test build up down logs restart

dev:
	bun run dev:server & bun run dev:web; kill %1

types:
	bun run scripts/gen-herdr-types.ts

check:
	bunx tsc --noEmit

check-clean:
	bash scripts/check-private.sh .

build-web:
	bun run build:web

# The UI is built FIRST. Part of the suite reads real build output —
# dist/assets, dist/index.html — and running the tests before the build meant
# those tests found nothing to check and passed by skipping, which on a clean
# checkout (i.e. CI) was every run. They now fail rather than skip, so this
# ordering is load-bearing: use `make test`, not a bare `bun test`.
test: build-web
	bun test

build: check check-clean test
	bun build --compile --target=bun src/server/index.ts --outfile paddock

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart
