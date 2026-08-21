# Copilot instructions

This repo's agent guidance lives in [`AGENTS.md`](../AGENTS.md) — read it first.

Essentials:
- Cloudflare-only TS monorepo: each service is ONE Worker serving its React SPA + Hono API (same origin, no CORS) with its own D1. `services/example_service` is the copy-me template.
- **Definition of done: `pnpm check`** (lint + typecheck + test) must pass.
- Zod (`packages/contracts`) is the single source of truth — no hand-written API types, no `any`. API via Hono RPC (chained routes → `AppType`).
- Design goes through tokens only (`packages/ui/src/theme.css`): no Tailwind default palette, no arbitrary values. Before UI work, read `docs/frontend/DESIGN_RULE.md`.
- Every DB query is tenant-scoped by `organization_id`. One service = one D1; no cross-D1 joins (reconcile in app code).
- Conventional Commits. Tests-first (TDD). Behavior-changing work needs a spec (`docs/spec-workflow/SPEC_WORKFLOW.md`).
