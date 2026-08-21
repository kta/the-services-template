---
name: new-service
description: Scaffold a new service (one Worker serving SPA + API, with contracts + D1) from the example_service template.
---

Scaffold the service name supplied by the user, following `specs/README.md` and `AGENTS.md`. If no name was supplied, ask for it. Confirm the plan before large changes (absolute rule #10: no unapproved arch/library decisions).

1. **Specify first**: copy `specs/_service-template` to `specs/<service-name>`, fill in `00_service-spec.md` (boundary, entity, API surface, owned D1).
2. **Contract**: add `packages/contracts/src/<service-name>.ts` (Zod schemas) and export from `index.ts`.
3. **Service**: copy `services/example_service` to `services/<service-name>` (minus `dist`, `node_modules`, `.wrangler`, `worker-configuration.d.ts`, `migrations/*`). Rename: package to `@app/<service-name>`, D1 `database_name` to the service name (underscores OK), wrangler `name` to the **hyphenated** form (Worker names are DNS labels — e.g. dir `example_service` → name `example-service`), dev/e2e ports to unused ones. Copy `.dev.vars.example` too and run `make dev-vars`. Replace the `item` entity (worker routes, Drizzle schema, web UI) with the new domain's. **Write tests first** (`services/example_service/test` as a model).
4. **DB**: `pnpm --filter @app/<service-name> db:generate` then `db:migrate:local`; add a `cloudflare_d1_database` + output in `infra/terraform/cloudflare`.
5. **UI**: follow `docs/frontend/DESIGN_RULE.md` — produce the pass-1 token plan in text before writing JSX. Do NOT copy the ledger look from example_service; apply the process, not the visual.
6. **Wire the platform services**: add the new D1 to `services/ops` monitoring (one row in `opsTargets()` + `MYNAME_DB_ID` var + Bindings) so it gets backups + capacity + health checks. If admin should sync orgs to this service instead of the scaffold, swap admin's `EXAMPLE_SERVICE` binding target.
7. **Verify**: `pnpm install`, then `pnpm check` (must be green) and `pnpm --filter @app/<service-name> e2e`. Add `@app/<service-name>` to the **deploy** + e2e matrices in `.github/workflows/ci.yml` (example_service itself is never deployed — your service takes its place).
