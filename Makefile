.DEFAULT_GOAL := help
SHELL := /bin/bash

# SPA + API services started together by `make dev/all`.
# Add each new domain service here; notifier and ops are Worker-only services.
DEV_ALL_SERVICES := admin example_service

# Services that may be deployed with `make deploy/<service>`.
# example_service is the scaffold and must remain excluded.
DEPLOYABLE_SERVICES := admin notifier ops

## init: install deps + generate types + apply local DB migrations + seed
# `pnpm -r` and the services wildcard intentionally discover newly added services.
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

## dev/<service>: run one service's dev server (SPA + API or Worker)
dev/%: FORCE
	pnpm --filter @app/$* dev

## dev/all: run all SPA + API services listed in DEV_ALL_SERVICES together
dev/all:
	@echo "starting $(DEV_ALL_SERVICES); Ctrl-C stops all"
	@trap 'kill 0' EXIT; \
		for service in $(DEV_ALL_SERVICES); do \
			$(MAKE) --no-print-directory dev/$$service & \
		done; \
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

# NOTE: example_service は雛形なので DEPLOYABLE_SERVICES に含めない。
## deploy/<service>: build + deploy one service listed in DEPLOYABLE_SERVICES
deploy/%: FORCE
	@case " $(DEPLOYABLE_SERVICES) " in \
		*" $* "*) ;; \
		*) echo "error: $* is not in DEPLOYABLE_SERVICES"; exit 2 ;; \
	esac
	pnpm --filter @app/$* run deploy

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

.PHONY: FORCE init dev/all db/generate db/migrate/local db/migrate/remote db/seed/local \
	build test typecheck lint check dev-vars worktree/new worktree/rm help

FORCE:
