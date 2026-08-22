.DEFAULT_GOAL := help
SHELL := /bin/bash

## init: install deps + generate types + apply local DB migrations + seed
init:
	pnpm install
	$(MAKE) dev-vars
	pnpm -r --if-present cf-typegen
	$(MAKE) db/migrate/local
	$(MAKE) db/seed/local

## dev-vars: copy each service's .dev.vars.example to .dev.vars (no overwrite)
dev-vars:
	@for f in services/*/.dev.vars.example; do \
		d="$${f%.example}"; \
		[ -f "$$d" ] || { cp "$$f" "$$d"; echo "created $$d"; }; \
	done

## db/seed/local: seed local D1s with dev data (services with a db:seed:local script)
db/seed/local:
	pnpm -r --if-present db:seed:local

## dev/example_service: run example_service — SPA + API in one dev server (:5173)
dev/example_service:
	pnpm --filter @app/example_service dev

## dev/admin: run admin — SPA + API in one dev server (:5174)
dev/admin:
	pnpm --filter @app/admin dev

## dev/notifier: run the notifier Worker (sync send API)
dev/notifier:
	pnpm --filter @app/notifier dev

## dev/all: run admin (:5174) + example_service (:5173) together — service bindings resolve across dev servers
dev/all:
	@echo "starting admin (:5174) + example_service (:5173); Ctrl-C stops both"
	@trap 'kill 0' EXIT; \
		pnpm --filter @app/admin dev & \
		pnpm --filter @app/example_service dev & \
		wait

## db/generate: generate Drizzle migrations from schemas
db/generate:
	pnpm -r --if-present db:generate

## db/migrate/local: apply all migrations to local D1
db/migrate/local:
	pnpm -r --if-present db:migrate:local

## db/migrate/remote: apply all migrations to remote D1
db/migrate/remote:
	pnpm -r --if-present db:migrate:remote

## build: build all packages
build:
	pnpm -r --if-present build

## test: run the root combined test gate (Worker/web coverage + traceability)
test:
	pnpm run test

## typecheck: typecheck all packages
typecheck:
	pnpm -r --if-present typecheck

## lint: biome check
lint:
	pnpm exec biome check .

## check: lint + dependency audit + typecheck + combined test (the "definition of done")
check:
	pnpm run check

# NOTE: example_service は雛形なので本番 deploy ターゲットを持たない(CI matrix からも除外)。
## deploy/admin: build + deploy the admin Worker (SPA + API)
deploy/admin:
	pnpm --filter @app/admin run deploy

## deploy/notifier: deploy the notifier Worker (sync send API)
deploy/notifier:
	pnpm --filter @app/notifier run deploy

## deploy/ops: deploy the ops Worker (backup + monitoring)
deploy/ops:
	pnpm --filter @app/ops run deploy

## worktree/new: isolated worktree for a parallel agent (name=<branch>)
worktree/new:
	git worktree add -b "$(name)" "../$(notdir $(CURDIR))-worktrees/$(name)" HEAD
	cd "../$(notdir $(CURDIR))-worktrees/$(name)" && pnpm install

## worktree/rm: remove a worktree + its branch (name=<branch>)
worktree/rm:
	git worktree remove "../$(notdir $(CURDIR))-worktrees/$(name)" && git worktree prune && git branch -D "$(name)"

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[36m%-26s\033[0m %s\n", $$1, $$2}'

.PHONY: init dev/example_service dev/admin dev/all dev/notifier db/generate db/migrate/local db/migrate/remote db/seed/local \
	build test typecheck lint check dev-vars deploy/admin deploy/notifier deploy/ops \
	worktree/new worktree/rm help
