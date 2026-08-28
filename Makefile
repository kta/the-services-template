.DEFAULT_GOAL := help
SHELL := /bin/bash
WORKTREE_NAME := $(name)
export WORKTREE_NAME

## init: install deps + generate types + apply local DB migrations + seed
init:
	pnpm install
	$(MAKE) dev-vars
	pnpm -r --if-present cf-typegen
	$(MAKE) db/migrate/local
	$(MAKE) db/seed/local

## dev-vars: copy each service's .dev.vars.example to .dev.vars (no overwrite)
dev-vars:
	@node scripts/prepare-dev-vars.mjs

## db/seed/local: seed local D1s with dev data (services with a db:seed:local script)
db/seed/local:
	pnpm -r --if-present db:seed:local

## dev/example_service: run example_service — SPA + API in one dev server (:5173)
dev/example_service:
	pnpm --filter @app/example_service dev

## dev/example_service/tauri: run example_service Tauri desktop dev (Worker + native window)
dev/example_service/tauri:
	pnpm --filter @app/example_service tauri dev

## build/example_service/tauri: build the example_service static Tauri frontend bundle
build/example_service/tauri:
	pnpm --filter @app/example_service build:tauri

## dev/admin: run admin — SPA + API in one dev server (:5174)
dev/admin:
	pnpm --filter @app/admin dev

## dev/admin/tauri: run admin Tauri desktop dev (Worker + native window)
dev/admin/tauri:
	pnpm --filter @app/admin tauri dev

## build/admin/tauri: build the admin static Tauri frontend bundle
build/admin/tauri:
	pnpm --filter @app/admin build:tauri

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

## build: build all packages
build:
	pnpm -r --if-present build

## test: run the root combined test gate (Worker/web coverage + traceability)
test:
	pnpm run test

## typecheck: typecheck all packages
typecheck:
	pnpm -r --if-present typecheck

## lint: Biome + native boundary check
lint:
	pnpm run lint

## check: lint + dependency audit + typecheck + combined test (the "definition of done")
check:
	pnpm run check

## infra/check: Terraform format, provider initialization, and validation
infra/check:
	pnpm run infra:check

## worktree/new: isolated worktree for a parallel agent (name=<branch>)
worktree/new:
	node scripts/worktree.mjs new

## worktree/rm: remove a worktree + its branch (name=<branch>)
worktree/rm:
	node scripts/worktree.mjs rm

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[36m%-26s\033[0m %s\n", $$1, $$2}'

.PHONY: init dev/example_service dev/example_service/tauri build/example_service/tauri dev/admin dev/admin/tauri build/admin/tauri dev/all dev/notifier db/generate db/migrate/local db/seed/local \
	build test typecheck lint check infra/check dev-vars \
	worktree/new worktree/rm help
