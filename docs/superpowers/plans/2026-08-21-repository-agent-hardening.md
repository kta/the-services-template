# Repository Agent Hardening and Code Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maintainable repository code map and make remote CI enforce the full quality and agent-compatibility gates.

**Architecture:** `CODEMAP.md` is a concise, committed map of stable ownership boundaries and flows; it deliberately does not mirror source-level symbol indexes. Existing entry points link to it. The `verify` workflow runs the existing compatibility script and the same coverage-gated unit-test command that Lefthook runs locally, before deployment.

**Tech Stack:** Markdown, GitHub Actions, pnpm 10, Biome, Vitest, Bash.

**Spec:** `docs/superpowers/specs/2026-08-21-repository-agent-hardening-design.md`

## Global Constraints

- Add no dependencies, runtime bindings, APIs, schemas, or deployment targets.
- Preserve `AGENTS.md` as the canonical cross-agent instruction source; keep detailed guidance progressively disclosed.
- `CODEMAP.md` must document its update triggers so it is maintained with architectural changes.
- CI must run `bash scripts/check-agent-compat.sh` and `pnpm -r --if-present test` in `verify` before `deploy`.
- Verify with `pnpm check`; do not commit or push without explicit user direction.

---

### Task 1: Add the repository Code Map

**Files:**
- Create: `CODEMAP.md`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: service boundaries in `AGENTS.md`, worker entry points, and the runtime topology documented in `docs/architecture/infra.md`.
- Produces: a stable root-level `CODEMAP.md` linked by both people- and agent-facing entry points.

- [ ] **Step 1: Define acceptance assertions for the map**

Write the map so it has all of these testable sections: `System at a glance`, `Ownership and entry points`, `Core flows`, `Where to change what`, and `Keep this map current`. Include the exact paths `services/admin`, `services/notifier`, `services/ops`, `services/example_service`, `packages/contracts`, `packages/shared`, `packages/ui`, and `infra/terraform`.

- [ ] **Step 2: Verify the assertions fail before implementation**

Run: `test -f CODEMAP.md`

Expected: exit status 1 because the map does not yet exist.

- [ ] **Step 3: Write the smallest complete Code Map**

Create `CODEMAP.md` with the required sections. Describe only durable architecture and routes to source code; link to detailed instructions rather than repeating policy. State that map updates are required when services, packages, bindings, deploy order, or cross-service flows change.

- [ ] **Step 4: Link the map from existing entry points**

Add one concise link in each of `README.md`, `docs/README.md`, and `AGENTS.md`. Use it as the architectural/navigation entry point without expanding always-loaded instructions.

- [ ] **Step 5: Verify map content and links**

Run:

```sh
rg -n '^## (System at a glance|Ownership and entry points|Core flows|Where to change what|Keep this map current)' CODEMAP.md
rg -n 'CODEMAP\.md' README.md docs/README.md AGENTS.md
```

Expected: all five headings and all three links are present.

### Task 2: Make remote CI enforce the full quality contract

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `scripts/check-agent-compat.sh`, root `pnpm -r --if-present test`, and the existing `verify` → `deploy` job dependency.
- Produces: a `verify` job that rejects incompatible agent metadata and failing coverage-gated unit tests before deployment.

- [ ] **Step 1: Define the workflow assertions**

The `verify` job must include a step named `Check agent compatibility` that runs `bash scripts/check-agent-compat.sh`, and a step named `Test (with coverage gates)` that runs `pnpm -r --if-present test`. Both must occur before the job completes, so `deploy` remains blocked by `needs: [verify]`.

- [ ] **Step 2: Verify the test-step assertion fails before implementation**

Run:

```sh
rg -n -- '- name: Test \(with coverage gates\)' .github/workflows/ci.yml
```

Expected: no match because the test step is still commented out.

- [ ] **Step 3: Add the two minimal CI steps**

After dependency installation and before linting, add the compatibility command. Replace the commented test guidance with the active coverage-gated unit-test step. Keep e2e manual-only and leave deployment configuration unchanged.

- [ ] **Step 4: Verify the workflow structure**

Run:

```sh
rg -n -- 'Check agent compatibility|bash scripts/check-agent-compat\.sh|Test \(with coverage gates\)|pnpm -r --if-present test|needs: \[verify\]' .github/workflows/ci.yml
```

Expected: all required commands and the existing deployment dependency are present.

### Task 3: Validate the repository-wide change

**Files:**
- Verify: `CODEMAP.md`
- Verify: `README.md`
- Verify: `docs/README.md`
- Verify: `AGENTS.md`
- Verify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: all output from Tasks 1 and 2.
- Produces: evidence that repository metadata, style, type checks, tests, and coverage gates remain valid.

- [ ] **Step 1: Run the agent compatibility check**

Run: `bash scripts/check-agent-compat.sh`

Expected: `agent-compat: ok (the-services)`.

- [ ] **Step 2: Run formatting and static checks**

Run: `pnpm exec biome check .`

Expected: exit status 0.

- [ ] **Step 3: Run the complete project gate**

Run: `pnpm check`

Expected: lint, typecheck, all package tests, and coverage thresholds pass.

- [ ] **Step 4: Inspect the final worktree**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; changes are limited to the Code Map, its links, CI, and the approved design/plan documents.

### Task 4: Reconcile policy documentation and complete the Code Map

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/testing/TEST_RULE.md`
- Modify: `lefthook.yml`
- Modify: `CODEMAP.md`

**Interfaces:**
- Consumes: the active `verify` workflow, each service's `wrangler.jsonc`, and notifier's documented KV deduplication behavior.
- Produces: one consistent account of local and remote quality gates plus a Code Map that accurately presents bindings, dependency direction, and notification guarantees.

- [ ] **Step 1: Replace obsolete CI-only-local wording**

State in each policy location that Lefthook supplies early local feedback and CI `verify` is the final remote lint, typecheck, and coverage-gated unit-test gate. Preserve the existing manual-only e2e policy.

- [ ] **Step 2: Add compact runtime-boundary detail to the Code Map**

List the stable bindings for `admin` (D1, AUTH_RL KV, EXAMPLE_SERVICE, NOTIFIER, Cron), `example_service` (D1, NOTIFIER), `notifier` (DEDUPE KV), and `ops` (BACKUPS R2, BACKUP_WF, ADMIN, NOTIFIER, Cron). State that services consume contracts/shared (and SPA services consume ui) without reversing that dependency.

- [ ] **Step 3: Correct notification semantics**

Describe notification deduplication as 24-hour best-effort using KV and the provider idempotency key, not exactly-once delivery.

- [ ] **Step 4: Verify the documentation contract**

Run:

```sh
rg -n 'CI.*(coverage|カバレッジ)|24-hour|best-effort|Runtime bindings|verify' AGENTS.md docs/testing/TEST_RULE.md lefthook.yml CODEMAP.md
git diff --check
```

Expected: active policy and Code Map wording agree, and there are no whitespace errors.
