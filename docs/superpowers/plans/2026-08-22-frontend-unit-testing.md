# Frontend Unit Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meaningful, enforced unit and component coverage for both React services and the shared UI package.

**Architecture:** Keep the existing Workers-pool suites intact and add one jsdom Vitest configuration per React-capable package. Package scripts expose Worker and web suites independently, while `test:all` and the recursive root test gate make both mandatory. Tests assert observable behavior at API, state-store, session, route, and shared-component boundaries.

**Tech Stack:** TypeScript 7, React 19, Vitest 4, jsdom, Testing Library React/DOM, `@testing-library/user-event`, Istanbul coverage

**Spec:** `docs/superpowers/specs/2026-08-22-frontend-unit-testing-design.md`

## Global Constraints

- Every production behavior change follows Red → confirm expected failure → Green → Refactor.
- Worker tests remain in workerd; React and UI tests run in jsdom.
- `pnpm check` must execute both suites and enforce separate web coverage thresholds.
- Tests query by role, label, or visible behavior and mock only external boundaries.
- No real network, wall clock, random ID, or shared cross-test state.
- Do not add test-only production APIs; refactor only around genuine responsibility boundaries.
- Do not lower an established coverage threshold to make a failing change pass.

---

### Task 1: Install and wire the shared frontend test toolchain

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `services/admin/package.json`
- Modify: `services/example_service/package.json`
- Modify: `packages/ui/package.json`
- Create: `services/admin/vitest.web.config.ts`
- Create: `services/example_service/vitest.web.config.ts`
- Create: `packages/ui/vitest.config.ts`
- Create: `services/admin/src/web/test/setup.ts`
- Create: `services/example_service/src/web/test/setup.ts`
- Create: `packages/ui/src/test/setup.ts`

**Interfaces:**
- Produces: package scripts `test:web` and `test:all`; jsdom globals plus jest-dom matchers and automatic cleanup.
- Consumes: existing Worker `test` scripts without changing their environment.

- [ ] **Step 1: Add catalog dependencies and package scripts**

Add latest stable `@testing-library/dom`, `@testing-library/jest-dom`, `@testing-library/react`, `@testing-library/user-event`, and `jsdom` versions to the workspace catalog. Reference them from each React-capable package. Keep `test` as the Worker command in services; add:

```json
"test:web": "vitest run --config vitest.web.config.ts --coverage",
"test:all": "pnpm run test && pnpm run test:web"
```

For `packages/ui`, make `test` the jsdom coverage command.

- [ ] **Step 2: Create the web test configurations**

Each service configuration uses `@vitejs/plugin-react`, `environment: 'jsdom'`, `globals: true`, a package-local setup file, and includes `src/web/**/*.test.{ts,tsx}`. Coverage includes `src/web/**/*.{ts,tsx}` and excludes `main.tsx`, declarations, test helpers, and CSS. Start thresholds at zero until Tasks 3–6 establish measured, reviewed gates; zero must not be committed as the final state.

The UI configuration follows the same pattern with `src/**/*.test.{ts,tsx}` and covers runtime `.ts/.tsx` files while excluding `index.ts`, test setup, and stylesheet files.

- [ ] **Step 3: Create shared package-local setup**

Each setup file contains:

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
```

- [ ] **Step 4: Prove the new runners execute**

Run each `test:web`/UI `test` command. Expected: failure with “No test files found”, proving the new configuration—not the Worker suite—is selected.

- [ ] **Step 5: Commit the test foundation**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml services/admin services/example_service packages/ui
git commit -m "test: add frontend unit test foundation"
```

### Task 2: Test shared UI primitives by public behavior

**Files:**
- Test: `packages/ui/src/cn.test.ts`
- Test: `packages/ui/src/components.test.tsx`
- Test: `packages/ui/src/dialog.test.tsx`
- Modify only if a failing public-behavior test reveals a defect: `packages/ui/src/cn.ts`, `packages/ui/src/components.tsx`, `packages/ui/src/dialog.tsx`

**Interfaces:**
- Consumes: exported `cn`, `Button`, `Card`, `Chip`, `Field`, `Notice`, `Select`, `Textarea`, `TextInput`, and `Dialog`.
- Produces: copyable semantic/accessibility test examples and a UI coverage gate.

- [ ] **Step 1: Write failing utility and primitive tests**

Cover `cn` filtering/joining; button semantic type, variants, disabled state, attributes, and ref; input/select/textarea labels and attributes; Field error alert and `aria-describedby`; Notice tone semantics; Card and Chip children/variants. Assert roles and accessible names rather than full class snapshots.

- [ ] **Step 2: Run UI tests and confirm RED**

Run: `pnpm --filter @app/ui test`

Expected: the suite executes and any incorrect assumption fails against the real public contract. Adjust invalid expectations, not production behavior; if an accessibility contract is genuinely absent, retain the failing test before the minimal fix.

- [ ] **Step 3: Add Dialog interaction tests**

Test closed state, open content, accessible title/description, close button, Escape, backdrop behavior if supported, focus placement/return, and forwarded child actions. Use `userEvent.setup()`.

- [ ] **Step 4: Implement only verified accessibility fixes**

For each retained failure, make the smallest production change and rerun the single named test until green.

- [ ] **Step 5: Establish and verify UI coverage thresholds**

Set thresholds no lower than the measured coverage rounded down to a stable whole number, with a target of at least 85% lines/statements and 80% functions/branches. Run `pnpm --filter @app/ui test` and confirm all tests and gates pass.

- [ ] **Step 6: Commit**

```bash
git add packages/ui
git commit -m "test: cover shared ui primitives"
```

### Task 3: Test admin frontend pure boundaries and stores

**Files:**
- Test: `services/admin/src/web/client.test.ts`
- Test: `services/admin/src/web/lib/errorMessages.test.ts`
- Test: `services/admin/src/web/store/toast.test.ts`
- Modify: `services/admin/src/web/client.ts`
- Modify: `services/admin/src/web/lib/errorMessages.ts`
- Modify: `services/admin/src/web/store/toast.ts`

**Interfaces:**
- Consumes: HTTP response unwrapping, domain error mapping, toast store behavior.
- Produces: testable public factory or pure functions only where they are genuine module contracts used by tests and runtime.

- [ ] **Step 1: Write API response tests and confirm RED**

Cover successful JSON, empty success, structured API error, unknown JSON, non-JSON response, and status/code preservation. Run the exact test file with the web config and confirm failures identify unhandled branches.

- [ ] **Step 2: Implement the minimum client corrections and verify GREEN**

Keep `unknown` at the parse boundary; do not introduce `any`. Rerun `client.test.ts`.

- [ ] **Step 3: Write table-driven error-message tests**

Cover every known code, representative 400/401/403/404/409/429/500 fallbacks, and missing/unknown input. Confirm the test fails if the internal mapper is inaccessible; export the mapper only if it is a stable pure module boundary used to keep callers consistent.

- [ ] **Step 4: Write toast store tests with deterministic IDs and timers**

Cover show helpers, ordering, duplicate suppression, timer restart, explicit dismiss, unknown dismiss, clear, subscribe/unsubscribe, zero auto-dismiss, and automatic dismissal using fake timers. Export `createToastStore` as the legitimate constructor for isolated store instances.

- [ ] **Step 5: Run the admin pure-boundary subset**

Run the three test files together, restore real timers in `afterEach`, and confirm no open timer or act warnings.

- [ ] **Step 6: Commit**

```bash
git add services/admin/src/web/client.ts services/admin/src/web/client.test.ts services/admin/src/web/lib services/admin/src/web/store
git commit -m "test: cover admin frontend boundaries"
```

### Task 4: Test admin authentication and routing behavior

**Files:**
- Test: `services/admin/src/web/auth/session.test.ts`
- Test: `services/admin/src/web/auth/useSession.test.tsx`
- Test: `services/admin/src/web/routes/Login.test.tsx`
- Test: `services/admin/src/web/App.test.tsx`
- Modify only after RED: matching production modules under `services/admin/src/web/`

**Interfaces:**
- Consumes: session client, `useSession`, router composition, login route.
- Produces: deterministic session/fetch/navigation behavior tests.

- [ ] **Step 1: Test the session module at the fetch boundary**

Cover access-token memory, login success/failure, refresh success/rejection, logout clearing, authorization headers, and single retry behavior if implemented. Stub `globalThis.fetch` with typed `Response` values and reset module state between tests.

- [ ] **Step 2: Confirm session RED then implement minimal fixes**

Run only `session.test.ts`; retain failures that demonstrate the documented auth contract, fix minimally, and rerun green.

- [ ] **Step 3: Test `useSession` lifecycle**

Render a small probe component. Cover initializing, restored authenticated state, rejected refresh, login transition, logout transition, and unmount protection. Use deferred promises to assert loading states without wall-clock sleeps.

- [ ] **Step 4: Test Login route behavior**

Render with a memory router and mocked session boundary. Cover empty/invalid fields, loading/disabled state, success navigation, 401/429/general error messages, and retry after failure.

- [ ] **Step 5: Test top-level route protection**

Cover initializing UI, unauthenticated redirect, authenticated organization route, invite path, unknown path, and logout navigation using `MemoryRouter` or the router shape actually consumed by `App`.

- [ ] **Step 6: Run the admin auth/component subset and commit**

```bash
pnpm --filter @app/admin exec vitest run --config vitest.web.config.ts src/web/auth src/web/routes/Login.test.tsx src/web/App.test.tsx
git add services/admin/src/web
git commit -m "test: cover admin auth ui flows"
```

### Task 5: Test admin organization operations

**Files:**
- Test: `services/admin/src/web/routes/Orgs.test.tsx`
- Test: `services/admin/src/web/routes/Invite.test.tsx`
- Test: `services/admin/src/web/components/Toaster.test.tsx`
- Test: `services/admin/src/web/components/AppShell.test.tsx`
- Modify only after RED: corresponding production components.

**Interfaces:**
- Consumes: admin API client, toast store, route parameters/navigation, organization and invitation contracts.
- Produces: representative frontend domain-operation coverage.

- [ ] **Step 1: Test organization list states**

Cover loading, empty, populated, request error, and unauthenticated outcomes with deferred/typed API responses.

- [ ] **Step 2: Test organization mutations**

Cover create validation/success/failure, invite validation/success/link fallback/failure, plan change, disable confirmation/cancel/success/failure, and preservation of user-entered values after failure.

- [ ] **Step 3: Test Invite route**

Cover missing token, loading, valid invitation, expired/rejected token, password validation, acceptance success, and server failure.

- [ ] **Step 4: Test shell and toast rendering**

Cover navigation/current user/logout controls, multiple toast tones, dismiss interaction, and live-region semantics.

- [ ] **Step 5: Run all admin web tests and establish thresholds**

Run: `pnpm --filter @app/admin test:web`

Set final web thresholds based on achieved coverage with a target of at least 80% lines/statements and 75% functions/branches. Do not exclude route files to reach the target.

- [ ] **Step 6: Commit**

```bash
git add services/admin
git commit -m "test: cover admin organization ui"
```

### Task 6: Test example service frontend behavior

**Files:**
- Test: `services/example_service/src/web/client.test.ts`
- Test: `services/example_service/src/web/App.test.tsx`
- Modify only after RED: `services/example_service/src/web/client.ts`, `services/example_service/src/web/App.tsx`

**Interfaces:**
- Consumes: shared `auth`, typed Hono client, item contract, analytics boundary.
- Produces: the copyable frontend-test baseline for new domain services.

- [ ] **Step 1: Write client/auth-boundary tests**

Cover token grant, stored authorization, list/create calls, successful JSON, structured failure, 401, malformed response, and logout behavior. Mock fetch at the network boundary and reset shared auth state.

- [ ] **Step 2: Confirm RED and make minimal client corrections**

Run only `client.test.ts`; implement only behavior required by the accepted template contract and rerun green.

- [ ] **Step 3: Write SignIn component behavior through `App`**

Cover initial signed-out render, whitespace validation, trimmed organization ID, busy state, successful ledger transition, grant rejection, retry, analytics success, and no success event on failure.

- [ ] **Step 4: Write Ledger load behavior**

Cover loading, empty, populated with optional body/timestamp, fetch rejection/non-OK, 401 logout, and explicit sign out.

- [ ] **Step 5: Write create behavior**

Cover empty and overlong title, optional body, busy state, successful create/reset/reload/analytics, non-OK preservation, network failure preservation, 401 logout, and repeated-submit protection.

- [ ] **Step 6: Run web tests and establish thresholds**

Run: `pnpm --filter @app/example_service test:web`

Set final thresholds with a target of at least 85% lines/statements and 80% functions/branches because the example frontend is compact. Keep `App.tsx` included.

- [ ] **Step 7: Commit**

```bash
git add services/example_service
git commit -m "test: cover example service frontend"
```

### Task 7: Enforce the combined gate and synchronize documentation

**Files:**
- Modify: `package.json`
- Modify: `lefthook.yml`
- Modify: `.github/workflows/ci.yml` if the recursive script does not already cover `test:all`
- Modify: `README.md`
- Modify: `CODEMAP.md`
- Modify: `AGENTS.md`
- Modify: `services/admin/AGENTS.md`
- Modify: `services/example_service/AGENTS.md`
- Modify: `docs/testing/TEST_RULE.md`
- Modify: `docs/howto/agent-development.md`
- Modify: `docs/howto/dependency-management.md`

**Interfaces:**
- Consumes: all package-level Worker/web/UI test commands and coverage gates.
- Produces: one mandatory local/pre-push/CI verification path with accurate documentation.

- [ ] **Step 1: Add the combined recursive test command**

Ensure the root test runner invokes `test:all` for React services, ordinary `test` for packages/services without that script, and UI tests exactly once. Prefer a root script that explicitly composes commands over relying on pnpm's `--if-present` selection ambiguity.

- [ ] **Step 2: Prove the gate catches a frontend failure**

Temporarily change one web assertion to fail, run the root test command, and confirm non-zero exit. Restore the assertion and rerun green. Do not commit the temporary failure.

- [ ] **Step 3: Update operational documentation**

Document exact `test`, `test:web`, `test:all`, targeted Vitest, coverage, and E2E responsibilities. State that all new production behavior—including frontend—requires a prior failing test. Make each service AGENTS file identify its required web test cases and commands.

- [ ] **Step 4: Commit the enforcement and documentation**

```bash
git add package.json lefthook.yml .github/workflows/ci.yml README.md CODEMAP.md AGENTS.md services/*/AGENTS.md docs
git commit -m "chore: enforce frontend unit tests"
```

### Task 8: Final verification and independent review

**Files:**
- Review only: all changes from `main...HEAD`

**Interfaces:**
- Consumes: completed implementation and documentation.
- Produces: evidence for PR readiness.

- [ ] **Step 1: Run targeted suites**

```bash
pnpm --filter @app/ui test
pnpm --filter @app/admin test:web
pnpm --filter @app/example_service test:web
```

Expected: all tests and each separate coverage gate pass.

- [ ] **Step 2: Run the full required gate and production build**

```bash
pnpm check
pnpm build
```

Expected: lint, Knip, typecheck, Worker tests, frontend tests, coverage gates, and builds all succeed.

- [ ] **Step 3: Run both integrated E2E suites**

```bash
make dev-vars
pnpm --filter @app/example_service e2e
pnpm --filter @app/admin e2e
```

Expected: example smoke 1/1 and admin smoke 2/2 pass.

- [ ] **Step 4: Verify dependency and repository hygiene**

```bash
pnpm install --frozen-lockfile
pnpm outdated -r --format json
scripts/check-agent-compat.sh
terraform -chdir=infra/terraform validate
git diff --check main...HEAD
git status --short
```

Expected: frozen install and compatibility checks pass, outdated prints `{}`, Terraform is valid, diff check is empty, and worktree has no uncommitted files.

- [ ] **Step 5: Request independent review**

Review `main...HEAD` for frontend test meaningfulness, mocking boundaries, coverage exclusions, TDD evidence, Worker regression, documentation accuracy, security invariants, and dependency hygiene. Fix all Critical/Important findings and repeat affected verification.

- [ ] **Step 6: Prepare PR only after explicit external-action approval**

Obtain the required US/AC/Task ID and immediate user approval before `git push` and `gh pr create`. Preserve the worktree for PR feedback.
