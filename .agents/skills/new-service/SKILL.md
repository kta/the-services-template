---
name: new-service
description: Use when scaffolding a new SPA + Hono Worker + D1 service, with or without a Tauri native shell.
---

# New service

Follow `specs/README.md` and `AGENTS.md`. If no service name was supplied, ask for it.

## Required template choice

Before copying anything, ask the user to choose exactly one template and wait for the answer:

- **Web only (recommended and default):** after this answer, copy `services/example_service`.
- **Web + Tauri:** after this answer, copy `services/example_tauri_service`.

Do not copy either template before the user answers. Do not infer Tauri from the product idea or silently keep/remove native assets after copying. If the answer is ambiguous, ask again. Confirm the implementation plan before large changes (absolute rule #10: no unapproved architecture or library decisions).

## Web only branch

1. Copy tracked source from `services/example_service` to `services/<service-name>`, excluding `dist`, `node_modules`, `.wrangler`, `worker-configuration.d.ts`, generated coverage/Playwright output, local `.dev.vars`, and `migrations/*`.
2. Rename the package to `@app/<service-name>`, the D1 `database_name` to the underscored service name, the Wrangler Worker `name` to its hyphenated DNS-label form, storage keys, and dev/E2E ports. Keep same-origin browser transport and session storage. The generated service must not contain `src-tauri`, `@tauri-apps/*` dependencies, or `tauri` / `tauri:*` / `*:tauri` scripts.
3. Register the service in root `service-catalog.json` with its directory/package, `templateKind: "web"`, and explicit deployable/native flags. Worker-only entries stay outside the SPA array and use normalized `{ directory, package, deployable }` objects in `workerOnlyServices`. Run `node scripts/service-catalog.mjs validate` so the workspace and catalog cannot drift.
4. Verify this branch with:
   - `pnpm --filter @app/<service-name> test:all`
   - `pnpm --filter @app/<service-name> typecheck`
   - `pnpm --filter @app/<service-name> e2e`
   - `node scripts/check-tauri-boundary.mjs`

## Web + Tauri branch

1. Copy tracked source from `services/example_tauri_service` to `services/<service-name>`, excluding `dist`, `node_modules`, `.wrangler`, `worker-configuration.d.ts`, generated coverage/Playwright output, local `.dev.vars`, `migrations/*`, `src-tauri/gen`, and `src-tauri/target`.
2. Rename every Web and native identity: package, D1, hyphenated Worker name, dev/E2E ports, Tauri `productName` and `identifier`, Rust crate/library, fixed `TAURI_<SERVICE>_API_ORIGIN` build variable and release allowlist, navigation guard, native/browser storage keys, capability description, and Android/iOS/macOS overlays. Do not broaden the release-origin allowlist. Keep Vite `strictPort: true`; `TAURI_DEV_HOST` may affect development HMR only.
3. Register the service in root `service-catalog.json` with its directory/package, `templateKind: "tauri"`, `native: true`, the reviewed deployable flag, and a unique `nativeWorkflow`. Copy and rename the example Tauri manual artifact workflow to that exact path. Run `node scripts/service-catalog.mjs validate` and `node --test scripts/check-deploy-boundary.test.mjs` to prove CI Rust manifests, generic Make native targets, and artifact workflows match the validated catalog native set.
4. Verify this branch with:
   - `pnpm --filter @app/<service-name> test:all`
   - `pnpm --filter @app/<service-name> typecheck`
   - `pnpm --filter @app/<service-name> e2e`
   - `cargo fmt --check --manifest-path services/<service-name>/src-tauri/Cargo.toml`
   - `cargo test --locked --manifest-path services/<service-name>/src-tauri/Cargo.toml`
   - `cargo clippy --all-targets --manifest-path services/<service-name>/src-tauri/Cargo.toml -- -D warnings`
   - `make build/<service-name>/tauri`
   - `node scripts/check-tauri-boundary.mjs`

## Common service work

1. **Specify first:** copy `specs/_service-template` to `specs/<service-name>` and fill in `00_service-spec.md` (boundary, entity, API surface, owned D1).
2. **Contract:** add and export `packages/contracts/src/<service-name>.ts` using Zod as the single source.
3. **Domain implementation:** replace the example item routes, Drizzle schema, and UI. Write tests first. A production domain receives `JWT_PUBLIC_KEY` only; admin retains `JWT_PRIVATE_KEY`. Keep `AUTH_DEV_PRIVATE_KEY` / `AUTH_DEV_GRANT` local-only.
4. **Local wiring:** add the service to `DEV_ALL_SERVICES`; retain `dev` and `.dev.vars.example`; run `make dev-vars`, `make -n dev/<service-name>`, and `make -n dev/all`.
5. **DB and UI:** generate/apply local migrations, add Terraform D1/output, and follow `docs/frontend/DESIGN_RULE.md` before writing JSX.
6. **Platform services:** register ops monitoring/backups and add the admin production identity only for a catalog `deployable: true` domain. The identity follows one strict convention: catalog directory `booking_service`, Worker service `booking-service`, admin binding `BOOKING_SERVICE`, caller secret `ADMIN_TO_BOOKING_SERVICE_KEY`, and the matching `{directory,binding,secret}` entry in `ADMIN_DOMAIN_IDENTITIES`. Add the binding and secret to generated `Env` with `cf-typegen`. The non-deployable scaffold binding/key stay dev/test-only; when the catalog has no deployable domain, the production binding/secret sets and identity array stay empty.
7. **Repository wiring:** every SPA service goes in the root combined `test:all` chain and CI manual E2E matrix; every worker-only service uses the root `test` chain. If `deployable: true`, `node scripts/service-catalog.mjs require-deployable <service-name>` must pass before any bootstrap package selection or credential, and the service must appear exactly once in every ordered protected-main build, artifact verifier/tar/install, config, migration (D1 services), deploy, D1/service-binding/health/backup, remote-secret, and bootstrap surface. If `deployable: false`, keep it out of all production surfaces. Never add a local production deploy or remote-migration entry point. Run `node scripts/service-catalog.mjs validate-repository`; it parses actual workflow nodes and rejects omissions, extras, duplicates, comments used as registrations, and identity drift.
8. **Final verification:** run `pnpm install`, the selected branch verification above, `node scripts/service-catalog.mjs validate-repository`, and `pnpm check`.
