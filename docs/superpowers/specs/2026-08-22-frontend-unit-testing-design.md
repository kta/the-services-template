# Frontend Unit Testing Design

**Date:** 2026-08-22
**Status:** Approved in chat; awaiting written-spec review

## Context

The repository has strong Hono Worker integration and unit coverage, but the React applications under `services/admin/src/web` and `services/example_service/src/web` have no unit or component tests. `packages/ui` has typechecking only. Playwright smoke tests cover representative end-to-end flows, but they do not provide fast, isolated feedback for frontend state, error handling, accessibility, or component behavior.

This is also inconsistent with the service agent documentation, which requires UI changes to pass a unit gate. The template must demonstrate the intended practice rather than merely describe it.

## Decision

All production development in this repository follows TDD: write a focused failing test, confirm the expected failure, implement the minimum behavior, then refactor while green. This applies to Worker, shared library, contract, React frontend, and shared UI code.

Add a dedicated React testing layer based on:

- Vitest
- jsdom
- Testing Library for React and DOM assertions
- `@testing-library/user-event` for user interactions

Do not adopt Playwright Component Testing. The existing Playwright suite remains the end-to-end boundary, while Vitest owns fast component and frontend-unit feedback.

## Test architecture

Worker and web tests remain separate execution environments.

- Existing `test` scripts continue to run Worker tests in workerd through `@cloudflare/vitest-pool-workers`.
- New `test:web` scripts run React tests in jsdom.
- Service-level `test:all` scripts run Worker and web tests.
- The root test/check path invokes `test:all` where present so frontend tests cannot be skipped by CI, pre-push, or `pnpm check`.
- `packages/ui` gains its own jsdom test command.

Each React-capable package gets a small dedicated Vitest web configuration rather than mixing jsdom and Workers pools in one configuration. Shared setup installs DOM matchers and deterministic cleanup. Tests live next to web code as `*.test.ts` or `*.test.tsx`, keeping ownership visible.

## Coverage policy

Web coverage is measured separately from Worker coverage. Initial gates must be meaningful and pass because important behavior is covered, not because broad paths are excluded.

- Include production code under `src/web/**` for each React service and `src/**` for `packages/ui`.
- Exclude non-behavioral bootstrap entrypoints, generated files, declarations, and stylesheet-only files.
- Do not exclude a file merely because it is difficult to test.
- Establish package-level line, statement, function, and branch thresholds after the initial test matrix is implemented.
- Thresholds become ratchets: future changes may raise them and must not silently lower them.

Coverage is a backstop, not the test-design target. Assertions focus on observable behavior and meaningful branch outcomes.

## Admin test matrix

Admin tests cover the frontend boundaries most likely to fail silently:

1. API client
   - successful JSON and empty responses
   - known structured errors
   - malformed or unknown errors
   - unauthenticated responses and status preservation
2. Authentication/session state
   - successful login and token state
   - refresh/session restoration
   - expired or rejected refresh
   - logout and credential clearing
   - concurrent or repeated initialization where applicable
3. Toast state
   - enqueue, explicit dismiss, ordering, and generated IDs
   - automatic dismissal with fake timers
   - timer cleanup and subscriber notification
4. Error-message mapping
   - known domain codes
   - HTTP status fallback
   - unknown and missing values
5. Login and protected navigation
   - validation and disabled/loading states
   - successful navigation
   - API failure feedback
   - unauthenticated redirect behavior
6. Organization operations
   - render/list/empty/loading/error states
   - create organization
   - invite user
   - plan change and disable flows
   - failed mutations leave understandable UI state

Large route components may be split into small modules only when that exposes a genuine responsibility boundary. Tests must not cause test-only production APIs.

## Example service test matrix

Example service tests establish the copyable baseline for future domain services:

1. API client
   - token grant, list, and create success
   - structured and unknown failures
   - authorization failure behavior
2. Workspace opening
   - valid workspace ID
   - empty/invalid input
   - dev-grant rejection and visible recovery state
   - loading and repeated submission protection
3. Item ledger
   - initial loading, empty state, populated state, and fetch failure
   - create validation
   - successful create and list refresh/state update
   - create failure without false success
   - workspace change resets tenant-specific UI state
4. Accessibility-facing behavior
   - controls are reachable by role and accessible name
   - validation and server errors use appropriate visible/alert semantics

The tests become part of the `example_service` template contract: a new service copies and adapts them instead of deleting them.

## Shared UI test matrix

For each exported UI primitive with runtime behavior, verify:

- representative render and semantic element/role
- children and forwarded standard attributes
- supported variants and disabled state where relevant
- ref forwarding where exposed
- accessible naming or labeling behavior

Avoid snapshot-only tests and assertions over long Tailwind class strings. Small targeted class assertions are allowed only when a variant's output is itself the public contract.

## Test quality rules

- Prefer queries by role, label, and visible text.
- Exercise real state transitions with `user-event`; use direct event dispatch only when browser behavior requires it.
- Mock at external boundaries such as `fetch`, navigation, or time. Do not mock the unit's own implementation details.
- Use fake timers only for time-dependent behavior and always restore them.
- Every production bug fix starts with a regression test that fails for the observed reason.
- Tests must be deterministic: no real wall clock, network, random IDs, or cross-test state.
- One test should communicate one behavior even when table-driven cases share setup.
- Do not chase test count. Add cases for distinct behavior, branch, boundary, or failure mode.

## Documentation and enforcement

Update the following with the implemented commands and ownership:

- root `AGENTS.md`
- `README.md`
- `docs/testing/TEST_RULE.md`
- `docs/howto/agent-development.md`
- service-level `AGENTS.md`
- `CODEMAP.md` where the verification flow is described

CI and local gates must execute the same frontend unit suite. The agent compatibility check should continue to verify service instruction files and their `CLAUDE.md` symlinks.

## Acceptance criteria

- Both React services contain meaningful unit/component tests covering their primary state, client, success, validation, and failure paths.
- `packages/ui` contains focused tests for its exported runtime primitives.
- Worker and frontend tests can run independently and together.
- `pnpm check` executes frontend tests and enforces web coverage.
- Playwright E2E remains green and covers the integrated smoke flows.
- Documentation names commands that exist and gates that actually run.
- No production behavior changes except narrowly justified refactoring required to expose real responsibility boundaries.
- The complete dependency-modernization branch remains green after the testing layer is added.
