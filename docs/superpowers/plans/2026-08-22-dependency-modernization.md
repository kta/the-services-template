# Dependency Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全workspaceの直接依存とpnpmを最新安定版へ移行し、不要依存検査、正確な運用文書、全サービス固有のエージェント指示を備えたgreenなテンプレートを作る。

**Architecture:** `pnpm-workspace.yaml` のcatalogを共有依存の単一バージョンソースとして維持し、メジャー更新は契約層、Cloudflare実行層、開発ツール層の順に適合させる。`knip` を既存の `pnpm check` に統合して依存整合性を継続検査し、各サービスの `AGENTS.md` はルート規約を継承しながらローカル境界だけを詳述する。

**Tech Stack:** pnpm 11.22.0, TypeScript 7.0.2, Zod 4.4.3, Hono 4.13.3, React 19.2.8, Vite 8.2.2, Wrangler 4.125.0, Vitest 4.1.11, Knip 6.32.2, Biome 2.5.10, Lefthook 2.1.10.

**Spec:** `docs/superpowers/specs/2026-08-22-dependency-modernization-design.md`

## Global Constraints

- 2026-08-22時点のnpm registry最新安定版を使い、pre-releaseは使わない。
- 互換性エラーは旧版への据え置きではなく、公式移行手順に沿ってコードと設定を直す。
- API契約、DB schema、認証、通知保証、テナント境界、UIの見た目は変更しない。
- shared dependencyのversionは `pnpm-workspace.yaml` のcatalogだけに置く。
- `packageManager` と `mise.toml` のpnpm versionは `11.22.0` に一致させる。
- 新しい品質ゲートは `knip@6.32.2` だけとし、runtime dependencyは追加しない。
- `CLAUDE.md` は同階層の `AGENTS.md` を指すsymlinkとし、内容を複製しない。
- 完了には `deps:check`、`pnpm check`、build、2 SPAのe2e、`pnpm outdated -r` がgreenであることを要する。

---

### Task 1: Toolchain and Catalog Upgrade

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`, `mise.toml`, `pnpm-lock.yaml`
- Modify if current schemas require it: `biome.json`, `lefthook.yml`, `commitlint.config.cjs`
- Modify: `packages/ui/package.json`

**Interfaces:**
- Consumes: current catalog references in every workspace manifest.
- Produces: one pnpm 11 lockfile and current tool binaries used by every later task.

- [ ] **Step 1: Capture the registry baseline**

```sh
pnpm outdated -r --format json > /tmp/dependency-outdated-before.json || true
pnpm view pnpm version
pnpm view knip version
```

Expected: pnpm is `11.22.0`, Knip is `6.32.2`, and the JSON identifies all stale direct dependencies.

- [ ] **Step 2: Update every version source**

Set pnpm to `11.22.0`. Set the catalog to: TypeScript 7.0.2; Hono 4.13.3; Hono Zod validator 0.9.0; Zod 4.4.3; Drizzle ORM 0.45.2; Drizzle Kit 0.31.10; Wrangler 4.125.0; Workers Types 5.20260822.1; Vitest and Istanbul coverage 4.1.11; Workers pool 0.22.0; Playwright 1.62.1; Vite 8.2.2; React plugin 6.1.0; Cloudflare Vite plugin 1.53.1; Tailwind packages 4.3.3; React packages 19.2.8; React Router 8.3.0; React types 19.2.18/19.2.4; Biome 2.5.10. Set root-only commitlint packages to 21.2.2 and Lefthook to 2.1.10. Set both Fontsource packages to 5.3.0.

- [ ] **Step 3: Regenerate with the pinned pnpm**

```sh
mise install
mise exec -- pnpm install
```

Expected: pnpm 11.22.0 succeeds and the lockfile contains no stale direct resolution.

- [ ] **Step 4: Validate migrated tool configs**

```sh
mise exec -- pnpm exec biome check .
mise exec -- pnpm exec lefthook version
printf 'chore: verify commitlint\n' | mise exec -- pnpm exec commitlint
```

Expected: all exit 0. Replace removed config keys only with their documented current equivalents, preserving hook order and lint policy.

- [ ] **Step 5: Commit**

```sh
git add package.json pnpm-workspace.yaml mise.toml pnpm-lock.yaml packages/ui/package.json
git add biome.json lefthook.yml commitlint.config.cjs 2>/dev/null || true
git commit -m "chore: upgrade repository toolchain"
```

### Task 2: TypeScript 7 and Zod 4 Migration

**Files:**
- Modify: `tsconfig.base.json` and diagnosed workspace `tsconfig.json` files
- Test: `packages/contracts/test/auth.contract.test.ts`
- Modify as migration requires: `packages/contracts/src/*.ts`, affected Worker routes

**Interfaces:**
- Consumes: exported Zod schemas and Hono `zValidator` routes.
- Produces: unchanged parsed shapes and `AppType` accepted by existing `hc<AppType>` clients.

- [ ] **Step 1: Establish focused Red diagnostics**

```sh
pnpm --filter @app/contracts typecheck
pnpm --filter @app/contracts test
pnpm --filter @app/shared typecheck
pnpm --filter @app/admin typecheck
pnpm --filter @app/example_service typecheck
```

Expected: all migration incompatibilities are visible before source edits.

- [ ] **Step 2: Add Zod 4-sensitive regression coverage**

Extend the contract tests with table rows proving omitted required fields fail, optional fields remain omittable, unknown-key behavior is unchanged, and exported schemas return the same output keys. Run `pnpm --filter @app/contracts test`; any behavior change must fail before its implementation fix.

- [ ] **Step 3: Apply documented migrations**

Keep `target`, `module`, `moduleResolution`, `types`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, and `noEmit` explicit. Add `rootDir` only when diagnosed. Search:

```sh
rg -n '\.(errors|format|flatten|deepPartial|nonstrict|merge)\b|z\.record\([^,)]*\)' packages services
```

Replace removed Zod APIs with `.issues`, `z.treeifyError`, object spread/`.extend()`, and two-argument `z.record(key, value)`. Preserve schema names and payload shapes.

- [ ] **Step 4: Verify and commit**

```sh
pnpm --filter @app/contracts test
pnpm --filter @app/contracts typecheck
pnpm --filter @app/shared test
pnpm --filter @app/shared typecheck
pnpm --filter @app/admin typecheck
pnpm --filter @app/example_service typecheck
git add tsconfig.base.json packages services
git commit -m "refactor: migrate to TypeScript 7 and Zod 4"
```

Exclude coverage and dist artifacts before committing.

### Task 3: Cloudflare, Vitest, and Runtime Compatibility

**Files:**
- Modify: `services/*/vitest.config.ts`
- Modify: `services/{admin,example_service}/vite.config.ts`
- Regenerate if changed: `services/*/worker-configuration.d.ts`
- Test: existing `services/*/test/**/*.test.ts`

**Interfaces:**
- Consumes: Wrangler configs, D1 migrations, KV/R2/service-binding test doubles.
- Produces: current plugins preserving `cloudflare:test`, D1 setup, Workflows, coverage, and Env types.

- [ ] **Step 1: Run each Worker suite against the new pool**

```sh
pnpm --filter @app/example_service test
pnpm --filter @app/admin test
pnpm --filter @app/notifier test
pnpm --filter @app/ops test
```

Expected: incompatibilities are isolated per service.

- [ ] **Step 2: Migrate configs without weakening coverage**

Use installed type declarations and official Workers Vitest docs. Preserve every binding, stub, migration reader, setup file, include, Istanbul provider, and threshold exactly.

- [ ] **Step 3: Regenerate types and verify runtime**

```sh
pnpm -r --if-present cf-typegen
pnpm --filter @app/example_service test
pnpm --filter @app/admin test
pnpm --filter @app/notifier test
pnpm --filter @app/ops test
pnpm build
```

Expected: no binding disappears; all suites/builds pass.

- [ ] **Step 4: Commit**

```sh
git add services
git commit -m "chore: update Cloudflare development stack"
```

### Task 4: Continuous Dependency Audit and Cleanup

**Files:**
- Modify: `package.json`, workspace manifests, `pnpm-lock.yaml`
- Create: `knip.jsonc`
- Modify: `.github/workflows/ci.yml`, `lefthook.yml`

**Interfaces:**
- Consumes: all workspace scripts, entries, exports, configs, and generated declarations.
- Produces: `pnpm deps:check` in local check, pre-push, and CI verify.

- [ ] **Step 1: Add Knip and establish Red**

```sh
pnpm add -Dw knip@6.32.2
pnpm exec knip
```

Expected: initial false positives plus real unused/missing dependency findings.

- [ ] **Step 2: Configure workspace-aware analysis**

Create `knip.jsonc` using schema `https://unpkg.com/knip@6/schema.json`. Configure package/Worker/SPA/config/seed entries and workspace projects. Ignore only generated Worker types, migrations, dist, coverage, `.wrangler`, and mockups. Never ignore dependency issue types globally.

- [ ] **Step 3: Add the gate**

Set root scripts exactly:

```json
{
  "check": "pnpm run lint && pnpm run deps:check && pnpm run typecheck && pnpm run test",
  "deps:check": "knip"
}
```

Run dependency audit after Biome and before typecheck in pre-push and CI verify. Keep pre-commit unchanged.

- [ ] **Step 4: Fix every real issue**

For every finding, use `rg`, scripts, and configs to prove runtime/dev/peer/missing/unused classification. Remove unused, add missing direct declarations, and move misclassified declarations. Run `pnpm install`; leave no unexplained ignore.

- [ ] **Step 5: Verify and commit**

```sh
pnpm deps:check
pnpm lint
git diff --check
git add package.json pnpm-lock.yaml pnpm-workspace.yaml knip.jsonc packages services .github/workflows/ci.yml lefthook.yml
git commit -m "chore: enforce dependency hygiene"
```

### Task 5: Service-Local Agent Contracts

**Files:**
- Create: `services/{example_service,admin,notifier,ops}/AGENTS.md`
- Create symlinks: each service `CLAUDE.md` → `AGENTS.md`
- Modify: `scripts/check-agent-compat.sh`, `.github/workflows/agent-compat.yml`

**Interfaces:**
- Consumes: root rules, Code Map, package scripts, bindings, implementation, and tests.
- Produces: path-scoped authoritative instructions with mechanically verified links.

- [ ] **Step 1: Extend compatibility checks first and verify Red**

Require each service's regular `AGENTS.md`, exact `CLAUDE.md` symlink, and readable target. Add service instruction globs to both workflow path filters.

```sh
scripts/check-agent-compat.sh
```

Expected: FAIL because all four pairs are absent.

- [ ] **Step 2: Write all four substantial service contracts**

Each file must include: root inheritance; mission/non-goals; directory and entry map; owned data/binding direction; API/auth/tenant/secret invariants; exact existing commands; required test matrix; documentation triggers; completion checklist. Example service explains copying/replacement; admin details auth/org source; notifier details fail-close/idempotency; ops details backup/monitoring/injected time.

- [ ] **Step 3: Create and verify symlinks**

```sh
ln -s AGENTS.md services/example_service/CLAUDE.md
ln -s AGENTS.md services/admin/CLAUDE.md
ln -s AGENTS.md services/notifier/CLAUDE.md
ln -s AGENTS.md services/ops/CLAUDE.md
scripts/check-agent-compat.sh
```

Expected: `agent-compat: ok`. After staging, `git ls-files -s services/*/CLAUDE.md` shows mode `120000`.

- [ ] **Step 4: Commit**

```sh
git add services/*/AGENTS.md services/*/CLAUDE.md scripts/check-agent-compat.sh .github/workflows/agent-compat.yml
git commit -m "docs: add service agent contracts"
```

### Task 6: Documentation and Renovate Accuracy

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CODEMAP.md`, `docs/README.md`
- Modify: `docs/howto/agent-development.md`, `docs/testing/TEST_RULE.md`
- Create: `docs/howto/dependency-management.md`
- Modify: `renovate.json`, and `Makefile` only if commands change

**Interfaces:**
- Consumes: final scripts, pins, Knip config, service instructions, Renovate behavior.
- Produces: one discoverable maintenance workflow matching the repository exactly.

- [ ] **Step 1: Find stale claims**

```sh
rg -n 'pnpm 10|lint \+ typecheck \+ test|依存更新|dependency|AGENTS\.md|CLAUDE\.md|toolchain' README.md AGENTS.md CODEMAP.md docs renovate.json Makefile
```

- [ ] **Step 2: Write the dependency runbook**

Document catalog ownership, `pnpm outdated -r`, major migration research, install, `deps:check`, dependency classification, lockfile policy, Renovate review, validation, peer-conflict recovery, and the ban on unexplained Knip ignores with copy-pasteable commands.

- [ ] **Step 3: Update every entry point**

Update README to Node 22/pnpm 11 and define check as lint + dependency audit + typecheck + coverage tests. Link the runbook from README, docs index, root AGENTS, and agent-development. Add service-local AGENTS navigation to CODEMAP. Update testing gate descriptions.

- [ ] **Step 4: Validate Renovate policy**

Keep production and major changes human-reviewed; intentionally group catalog updates; expose/synchronize pnpm pins; retain scheduled lock maintenance; classify Knip as dev tooling.

```sh
pnpm dlx renovate-config-validator renovate.json
```

Expected: valid with no semantic warnings.

- [ ] **Step 5: Verify and commit**

```sh
rg -n 'pnpm 11|deps:check|dependency-management|services/.*/AGENTS\.md' README.md AGENTS.md CODEMAP.md docs
pnpm deps:check
git diff --check
git add README.md AGENTS.md CODEMAP.md docs renovate.json Makefile
git commit -m "docs: document dependency maintenance"
```

### Task 7: Full Verification, Audit, and PR

**Files:**
- Modify only for proven failures: files already in scope
- Review: every change from `origin/main`

**Interfaces:**
- Consumes: all tasks.
- Produces: a reviewable branch with no stale direct dependencies and evidence for each gate.

- [ ] **Step 1: Run deterministic gates**

```sh
pnpm deps:check
pnpm check
pnpm build
scripts/check-agent-compat.sh
```

Expected: all pass; unit count is at least the 317-test baseline and every coverage threshold passes.

- [ ] **Step 2: Run both e2e suites**

```sh
pnpm --filter @app/example_service e2e
pnpm --filter @app/admin e2e
```

Expected: both pass. If Chromium is missing, run `pnpm exec playwright install chromium` and rerun.

- [ ] **Step 3: Prove freshness and lock consistency**

```sh
pnpm outdated -r --format json
pnpm install --frozen-lockfile
pnpm list -r --depth 0
```

Expected: no stale direct rows, frozen install changes nothing, all direct dependencies resolve.

- [ ] **Step 4: Complete self-review**

```sh
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- package.json pnpm-workspace.yaml renovate.json knip.jsonc
git diff origin/main...HEAD -- README.md AGENTS.md CODEMAP.md docs services/*/AGENTS.md
```

Prove every design requirement; confirm no secret, generated build/coverage, weakened threshold, deployment, or unrelated feature change.

- [ ] **Step 5: Commit review fixes and prepare PR text**

If fixes exist, stage only reviewed files and commit `chore: finalize dependency modernization`. Prepare a Conventional Commit PR title and body containing the user-provided US/task ID, update/removal/migration/doc summaries, and exact verification results. Do not push.

- [ ] **Step 6: Obtain external-action approval, push, and create PR**

After specific approval:

```sh
git push -u origin chore/modernize-dependencies
gh pr create --title "chore: modernize repository dependencies" --body-file /tmp/dependency-modernization-pr.md
gh pr view --json url,title,body,headRefName,baseRefName,statusCheckRollup
```

Expected: a PR targeting `main`, with the task ID in its body.
