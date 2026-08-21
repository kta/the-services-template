# Repository Agent Hardening and Code Map Design

## Goal

Keep this template easy for people and coding agents to navigate while making
the remote CI, rather than optional local hooks, the authoritative enforcement
point for linting, type safety, and unit-test coverage.

## Context

The repository already has a canonical `AGENTS.md`, a lightweight Copilot
pointer, task-specific documents, pinned toolchain versions, and local
Lefthook gates. The missing pieces are a compact architectural entry point and
remote enforcement for checks that can otherwise be bypassed with
`--no-verify`.

## Decisions

### 1. Add a committed, human- and agent-readable code map

Create `CODEMAP.md` at the repository root. It will describe:

- the dependency and data-ownership boundaries between Workers and packages;
- each service's responsibility, runtime bindings, and primary entry points;
- the standard request, notification, and operational flows;
- the shortest route to common development tasks and their validation command;
- an explicit maintenance rule: update the map when a service, package,
  binding, deploy target, or cross-service flow changes.

Keep it architectural rather than a generated symbol index. Source files and
GitHub already provide symbol navigation; duplicating it would become stale
quickly. Link the map from `README.md`, `docs/README.md`, and `AGENTS.md`.

### 2. Make CI the non-bypassable quality gate

Enable the existing `pnpm -r --if-present test` step in the `verify` job.
The command already includes each package's coverage threshold. Lefthook stays
in place for fast local feedback, but CI becomes the final gate before merge
and deployment.

### 3. Check agent compatibility in CI

Run `scripts/check-agent-compat.sh` in the `verify` job. This validates the
canonical-instruction and skill-directory links relied on by Claude Code,
Codex, and Copilot before a branch can merge.

### 4. Make the remote gate required for `main`

Configure GitHub branch protection for `main` so the `verify` status check is
required and must be current before merge. CI workflow configuration alone
cannot prevent a merge; this repository setting makes the remote quality gate
non-bypassable. As of 2026-08-21, administrators are included in enforcement.

## Non-goals

- No new runtime or development dependency.
- No generated code index, language server, or external indexing service.
- No changes to Worker APIs, D1 schemas, deployment targets, or authentication.
- No expansion of always-loaded instructions; `AGENTS.md` remains the concise
  rule source and links to details progressively.

## Files

| File | Change |
| --- | --- |
| `CODEMAP.md` | New architectural map and maintenance contract. |
| `AGENTS.md` | Add the map to the repository overview and reading guidance. |
| `README.md` | Link developers to the map. |
| `docs/README.md` | List the map as the architecture/navigation entry point. |
| `docs/testing/TEST_RULE.md` / `lefthook.yml` | Keep quality-gate documentation aligned with CI as the final gate and hooks as local feedback. |
| `.github/workflows/ci.yml` | Run agent compatibility and coverage-gated unit tests in `verify`. |
| `docs/superpowers/specs/2026-08-21-repository-agent-hardening-design.md` | This approved design record. |

## Verification

1. Run `pnpm exec biome check .` after documentation and workflow edits.
2. Run `bash scripts/check-agent-compat.sh`.
3. Run `pnpm check` to exercise lint, typechecking, unit tests, and coverage
   gates locally.
4. Inspect the CI workflow to confirm `verify` runs both agent compatibility
   and tests before `deploy` can start.
5. Confirm GitHub branch protection requires the current `verify` status check
   on `main`.

## Sources informing the design

- GitHub recommends concise, repository-specific agent instructions with clear
  project structure, contribution guidance, and validation commands.
  <https://docs.github.com/en/copilot/tutorials/cloud-agent/improve-a-project>
- GitHub recommends keeping persistent instructions short and specific, moving
  focused workflows into dedicated instructions or skills.
  <https://docs.github.com/en/copilot/tutorials/optimize-ai-usage>
- GitHub documents `AGENTS.md` for shared agent rules and path-specific
  instructions for scoped rules.
  <https://docs.github.com/en/copilot/concepts/agents/code-review>
