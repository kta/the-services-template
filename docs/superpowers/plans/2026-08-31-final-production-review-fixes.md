# Final Production Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task explicitly forbids subagents.

**Goal:** Close the final production bootstrap, restore, catalog authorization, domain-readiness, and single-domain provisioning findings without adding an unapproved token issuer or multi-domain key architecture.

**Architecture:** Every legacy production entry point will authorize its target through the validated repository service catalog and require `deployable: true`. Bootstrap remains a credential-bearing inline shell boundary, but gains exact RSA/key-fixture checks before any file write and an exact admin migration step. Domain production and multi-domain bootstrap remain fail-closed until separately approved designs provide executable positive authentication proof and a complete multi-domain key bundle.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, GitHub Actions YAML, Bash/OpenSSL/JQ, pnpm 11, Cloudflare Wrangler, Rust/Tauri

**Spec:** `docs/superpowers/specs/2026-08-30-tauri-template-separation-design.md`, `specs/infra/features/002-tauri-template-separation/spec.md`, `specs/infra/features/001-protected-production-deploy/spec.md`, `specs/shared/features/001-asymmetric-access-token/spec.md`

## Global Constraints

- No new dependency and no production deploy, push, or external API write.
- Do not add a domain token issuer, exchange endpoint, gateway, IdP, or key-sharing design without human approval.
- A production target must be present in the validated `service-catalog.json` and have `deployable: true`.
- Bootstrap supports at most one deployable domain until an approved bundle can validate all domain-specific key values together.
- Production behavior changes follow Red → Green → Refactor, with the expected failure observed before implementation.
- Final verification includes `pnpm check`, both example E2E suites, Rust fmt/test/clippy, Tauri static builds, and repository hooks before commit.

---

### Task 1: Catalog authorization and fail-closed domain provisioning

**Files:**
- Modify: `scripts/service-catalog.mjs`
- Modify: `scripts/production-service.mjs`
- Modify: `scripts/production-deploy.mjs`
- Modify: `scripts/production-migrate.mjs`
- Modify: `scripts/require-production-domain-auth.mjs`
- Modify: `scripts/check-production-secrets.mjs`
- Modify: `scripts/verify-worker-artifact.mjs`
- Modify: corresponding `scripts/*.test.mjs`

**Interfaces:**
- Consumes: `loadServiceRepositoryCatalog(root)` and catalog SPA/worker-only entries.
- Produces: `requireCatalogDeployableService(catalog, directory, options)` for exact shared authorization; all executable production selectors use the validated loader before config, artifact, remote inspection, migration, or deploy work.

- [ ] **Step 1: Write failing catalog-entry tests**

Add table-driven tests that send `example_service`, `example_tauri_service`, and `unknown_service` through deploy, migration, domain-auth, remote-secret, and artifact selectors. Each selector must reject because the target is not a catalog entry with `deployable: true`.

- [ ] **Step 2: Run catalog-entry tests and verify Red**

Run:

```sh
node --test scripts/production-service.test.mjs scripts/production-deploy.test.mjs scripts/production-migrate.test.mjs scripts/require-production-domain-auth.test.mjs scripts/check-production-secrets.test.mjs scripts/verify-worker-artifact.test.mjs
```

Expected: failures show `example_tauri_service` or an unknown service is still accepted by at least one legacy selector.

- [ ] **Step 3: Add one catalog deployable guard and route every entry through it**

Implement one helper in `service-catalog.mjs` that validates syntax, registration, package identity already established by the validated loader, `deployable === true`, and optional SPA/domain constraints. Replace local filesystem/name allowlists at all five legacy entry points with the shared helper.

- [ ] **Step 4: Make domain readiness and multi-domain bootstrap explicitly fail closed**

Require a catalog deployable SPA domain first. Return readiness false until an approved issuer/gateway and executable positive fixture prove success, wrong audience, missing `sid`, logout/revoke, user/org invalidation, and admin-binding 503. Make `guard-domain` reject catalog topologies containing more than one deployable domain; retain the existing single-domain key-duplication checks.

- [ ] **Step 5: Run catalog/domain tests and verify Green**

Run the Step 2 command plus:

```sh
node --test scripts/put-production-secret.test.mjs scripts/check-deploy-boundary.test.mjs
```

Expected: all tests pass; zero-domain current catalog and multi-domain fixtures are rejected by bootstrap readiness.

### Task 2: Bootstrap credential policy and admin migration order

**Files:**
- Modify: `.github/workflows/production-bootstrap.yml`
- Modify: `scripts/service-wiring.mjs`
- Modify: `scripts/service-wiring.test.mjs`
- Create: `scripts/production-bootstrap-secret-policy.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the exact parsed `Bootstrap production Workers with fixed secret bundles` run body.
- Produces: a pre-write policy requiring RSA private/public material, modulus length at least 2048 bits, matching JWT and backup pairs, distinct JWT/backup material, and rejection of fingerprint `f713e9c9261b62444d73646bdfa2c75794a1782d8ec8139369bd3658cd6ea188`; an exact bootstrap sequence containing exactly one admin migration before admin deploy.

- [ ] **Step 1: Write failing exact-policy and committed-key fixture tests**

Parse the real workflow step, execute its exact shell body with the normalized committed JWT pair, and assert failure occurs before `production-secret-bundles` is created. Mutate the RSA-bit and committed-fingerprint checks out of the step and assert `validateServiceWiringSources` rejects the body.

- [ ] **Step 2: Write failing admin migration sequence tests**

Require exactly one `Apply admin remote migrations` step between `Bootstrap notifier` and `Bootstrap admin`; test missing, duplicate, and post-deploy placements.

- [ ] **Step 3: Run workflow tests and verify Red**

Run:

```sh
node --test scripts/service-wiring.test.mjs scripts/production-bootstrap-secret-policy.test.mjs
```

Expected: the committed key fixture is accepted or fails for the wrong reason, and the bootstrap sequence lacks admin migration.

- [ ] **Step 4: Harden the exact inline step and workflow sequence**

Use OpenSSL inside the credential-bearing step to validate RSA type and extract modulus length for JWT private/public and backup private/reviewed public keys. Compare semantic public fingerprints, reject the committed fingerprint, perform all checks before `key_dir` creation, then add `production-service.mjs admin migrate` exactly once before admin bootstrap. Update the exact run digest and ordered policy.

- [ ] **Step 5: Run workflow tests and verify Green**

Run the Step 3 command and `node scripts/service-catalog.mjs validate-repository`.

Expected: all pass, with the real committed pair rejected before write and admin migration fixed in order.

### Task 3: Restore CLI preflight integration

**Files:**
- Modify: `scripts/restore-d1.mjs`
- Modify: `scripts/restore-d1.test.mjs`

**Interfaces:**
- Consumes: CLI argv, environment, service-config resolver, child-process runner, Wrangler runner, and filesystem helpers through an injectable runtime.
- Produces: `runRestoreCli(argv, dependencies)` and `runRestorePreflight(service, options, dependencies)`; production defaults remain the current real implementations.

- [ ] **Step 1: Add failing CLI integration cases for every operation**

Create fixtures for `time-travel-info`, `time-travel-restore`, `export-before-restore`, `download-backup`, `create-restore-db`, and `import-backup`. Each case records the provisioning guard, production config check, R2 privacy check, and final fixed Wrangler command; destructive cases use owner-only temporary SQL/JSON files and signed manifest data.

- [ ] **Step 2: Run restore tests and verify Red**

Run:

```sh
node --test scripts/restore-d1.test.mjs
```

Expected: CLI integration cannot run because `productionStaticEnvironment` is undefined and the entry point cannot accept injected runners.

- [ ] **Step 3: Import the static environment helper and extract the injectable CLI**

Import `productionStaticEnvironment`; move the current direct-entry body into `runRestoreCli`; route guard/config/R2 child calls and Wrangler execution through injected functions while preserving production defaults, confirmation checks, provenance validation, owner-only files, and fixed commands.

- [ ] **Step 4: Run restore tests and verify Green**

Run the Step 2 command.

Expected: all six operations reach the exact guard → config → R2 → fixed-command path; malformed inputs still stop before a Wrangler command.

### Task 4: Runbook, authoritative spec, and report

**Files:**
- Modify: `docs/howto/deploy.md`
- Modify: `docs/architecture/infra.md`
- Modify: `docs/howto/cloudflare-setup.md`
- Modify: `specs/infra/00_infra-spec.md`
- Create: `.superpowers/sdd/2026-08-30-tauri-template-separation/final-production-fix.md`

**Interfaces:**
- Consumes: the implemented workflow order and fail-closed capability limits.
- Produces: documentation that states notifier → admin migration → admin bootstrap → one domain migration/bootstrap → ops, blocks domain production until a human-approved issuer/gateway plus executable positive session proof exists, and limits bootstrap/rotation to at most one deployable domain.

- [ ] **Step 1: Correct bootstrap and rotation claims**

Remove the unsupported “topology-wide multi-domain bundle” guarantee. Document one-domain maximum, per-run all-key duplicate checking, non-atomic Worker writes, maintenance window, rollback bundle, and the need for a separately approved complete multi-domain bundle design.

- [ ] **Step 2: Correct domain readiness and workflow order**

State that current template has zero deployable domains and domain production bootstrap is impossible until the issuer/gateway and positive live-session fixture are approved and implemented. Record admin migration before admin bootstrap/deploy.

- [ ] **Step 3: Remove infra spec patch markers and write the fix report**

Replace the two literal leading `+` characters with Markdown list markers. Record changed files, Red/Green evidence, final verification, and any remaining intentional fail-closed limitations in `final-production-fix.md`.

### Task 5: Full verification and commit

**Files:**
- Modify only files required by failures caused by Tasks 1–4.

**Interfaces:**
- Consumes: completed implementation and documentation.
- Produces: fresh evidence for repository, browser, Rust, Tauri, and git-hook gates plus one Conventional Commit.

- [ ] **Step 1: Run focused production gates**

```sh
pnpm run test:boundary
pnpm run test:deploy-boundary
```

- [ ] **Step 2: Run the complete repository gate**

```sh
pnpm check
```

- [ ] **Step 3: Run E2E and native verification**

```sh
pnpm --filter @app/example_service e2e
pnpm --filter @app/example_tauri_service e2e
cargo fmt --check --manifest-path services/example_tauri_service/src-tauri/Cargo.toml
cargo test --locked --manifest-path services/example_tauri_service/src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path services/example_tauri_service/src-tauri/Cargo.toml -- -D warnings
make build/admin/tauri
make build/example_tauri_service/tauri
```

- [ ] **Step 4: Run hooks, review the diff, and commit**

```sh
pnpm exec lefthook run pre-commit
pnpm exec lefthook run pre-push
git diff --check
git status --short
git commit -m "fix: close production provisioning review gaps"
```

Expected: every command exits 0 and the commit contains no secret value, generated local state, or unrelated change.
