export UID := $(shell id -u)
export GID := $(shell id -g)

.PHONY: dev types check check-clean test build up down logs restart

dev:
	bun run dev:server & bun run dev:web; kill %1

types:
	bun run scripts/gen-herdr-types.ts

check:
	bunx tsc --noEmit

check-clean:
	bash scripts/check-private.sh .

test:
	bun test

build: check check-clean test
	bun run build:web
	bun build --compile --target=bun src/server/index.ts --outfile paddock

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

restart:
	docker compose restart
