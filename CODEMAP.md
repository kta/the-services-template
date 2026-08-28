# Repository Code Map

This is the architectural navigation entry point for the repository. It points
to durable ownership and source locations; working rules live in
[`AGENTS.md`](./AGENTS.md), and detailed operational guidance lives in
[`docs/`](./docs/README.md).

## System at a glance

This Cloudflare-only monorepo uses one Worker per service. Application services
serve their React SPA and Hono API from the same origin and own a domain D1
database. `admin` is the source of truth for organizations and authentication;
domain services receive organization data through service bindings. `notifier`
provides synchronous notification delivery with 24-hour best-effort duplicate
suppression, while `ops` performs scheduled backup and monitoring work.
Terraform owns Cloudflare resources and Wrangler owns Worker code and bindings.
See
[`docs/architecture/infra.md`](./docs/architecture/infra.md) for the runtime
topology and ownership boundary.

Access JWTs use RS256: admin alone owns `JWT_PRIVATE_KEY`, while admin and each
domain Worker receive `JWT_PUBLIC_KEY` for verification. Tauri shells receive
neither key. Production deploy is limited to a protected `main` push and the
GitHub `production` environment; local deploy entry points fail closed outside
that CI context. Existing secret provisioning, seed, and restore are separate
operator operations tied to a clean published `main` checkout. First-Worker
secret bootstrap uses only the dedicated protected-main
`production-bootstrap.yml` workflow and its reviewer gate. The template
`example_service` is never a production target.
Service-binding authentication uses a distinct secret for each direction:
`ADMIN_TO_<DOMAIN>_KEY` (the scaffold uses `ADMIN_TO_EXAMPLE_SERVICE_KEY`),
`ADMIN_TO_NOTIFIER_KEY`, `DOMAIN_TO_NOTIFIER_KEY`, and
`OPS_TO_NOTIFIER_KEY`; `DOMAIN_TO_ADMIN_KEY` is the dedicated domain-to-admin
live-session introspection credential, held only by that boundary's two ends.
A compromised domain Worker therefore cannot reuse another caller's internal
credential or the admin JWT signing key.

## Ownership and entry points

| Area | Owner and entry point | Responsibility |
|---|---|---|
| [`services/admin`](./services/admin) | [`src/worker/index.ts`](./services/admin/src/worker/index.ts) | Operator SPA/API, organization source of truth, authentication, invitations, and organization reconciliation. |
| [`services/example_service`](./services/example_service) | [`src/worker/index.ts`](./services/example_service/src/worker/index.ts), [`src-tauri/src/lib.rs`](./services/example_service/src-tauri/src/lib.rs) | Template domain Worker: same-origin SPA/API, tenant-scoped items, received organization records, and the optional Tauri v2 native shell. |
| [`services/notifier`](./services/notifier) | [`src/index.ts`](./services/notifier/src/index.ts) | Internal notification endpoint, KV deduplication, and Resend delivery. |
| [`services/ops`](./services/ops) | [`src/index.ts`](./services/ops/src/index.ts) | Cron and Workflow entry points for D1 backup, freshness/capacity checks, and service health checks. |
| [`packages/contracts`](./packages/contracts) | [`src/index.ts`](./packages/contracts/src/index.ts) | Zod API contracts shared by Workers and web clients. |
| [`packages/shared`](./packages/shared) | [`src/index.ts`](./packages/shared/src/index.ts) | Shared authentication, internal-call, date, and analytics utilities. |
| [`packages/ui`](./packages/ui) | [`src/theme.css`](./packages/ui/src/theme.css), [`src/index.ts`](./packages/ui/src/index.ts) | Design tokens and shared UI primitives. |
| [`infra/terraform`](./infra/terraform) | [`cloudflare/`](./infra/terraform/cloudflare) | Cloudflare resource definitions and Terraform outputs consumed by Wrangler configuration. |

Service-local deployment and binding configuration is in each service's
`wrangler.jsonc`; migrations, tests, and web sources live beside that service.
Each service also has a local `AGENTS.md` describing its invariants, commands,
and required tests; the sibling `CLAUDE.md` is a symlink to that same source.

### Runtime bindings and dependency direction

| Service | Runtime bindings |
|---|---|
| `admin` | D1, `EXAMPLE_SERVICE`, `NOTIFIER`, Cron（login lockout は D1 の原子的カウンタ） |
| `example_service` | D1, `NOTIFIER` |
| `notifier` | `DEDUPE` KV |
| `ops` | `BACKUPS` R2, `BACKUP_WF`, `ADMIN`, `NOTIFIER`, Cron |

All services consume `packages/contracts` and `packages/shared`; SPA services
(`admin` and `example_service`) also consume `packages/ui`. These packages do
not depend on services.

## Core flows

- **Browser to application:** an SPA application service Worker serves its SPA
  and handles its `/api/*` routes on the same origin. The Hono route chain
  exports `AppType` for the typed client, with contracts defined in
  `packages/contracts`.
- **Native to application:** example_service's Tauri React bundle sends API
  requests through the Rust `api_request` command. The command uses a
  build-time fixed API origin and an `/api/` method/header allowlist; it does
  not expose response cookies. Native access tokens are memory-only because
  the example service has no refresh endpoint. See
  [`docs/howto/tauri-example-service.md`](./docs/howto/tauri-example-service.md).
- **Organizations and authorization:** `admin` manages organizations and
  credentials. It synchronizes organization records to a domain Worker through
  an internal service binding; each record carries a monotonic `version`, and the
  receiving Worker conditionally accepts only the newest version before applying
  tenant scope to its own D1 queries.
- **Notifications:** application Workers call `notifier` through the internal
  `POST /api/internal/send` service-binding endpoint with a caller-specific
  key and caller header. The notifier allows only the notification types owned
  by that caller, then uses a KV key and the Resend idempotency key for
  24-hour best-effort duplicate suppression; this is not exactly-once delivery.
  If KV is unavailable, the behavior falls back toward at-least-once delivery.
- **Operations:** `ops` Cron handlers start backup workflows, inspect D1 backup
  freshness and capacity, and call service `/api/health` endpoints through
  bindings. Backup streams are size-bounded, the private R2 bucket is checked at
  the deployment boundary, reviewed account/bucket/D1 identities are checked
  before credentials are used, and `latest.json` is signed with an ops-only RSA
  key pair plus non-secret resource metadata. Alerts follow the same notifier
  flow; failed alerts are retained in R2 when the fallback is available.
- **Provision and deploy:** Terraform provisions D1, KV, and R2; its outputs
  are reflected in service `wrangler.jsonc` files. Wrangler deploys
  Workers, their bindings, Cron triggers, and Workflows. Details and order are
  in [`docs/howto/deploy.md`](./docs/howto/deploy.md).
- **Local commands:** `make dev/example_service` runs the browser Worker,
  `make dev/example_service/tauri` runs its Tauri dev window, and
  `make build/example_service/tauri` builds the isolated native frontend
  bundle. `make help` lists all repository targets.

## Where to change what

| Change | Start here |
|---|---|
| Add or modify a domain API or data model | The target `services/<name>/src/worker/`, then [`packages/contracts`](./packages/contracts) and the service migrations. |
| Change login, authorization, JWT, or internal-call helpers | [`packages/shared`](./packages/shared) and [`services/admin`](./services/admin). |
| Add or adjust organization synchronization | [`services/admin/src/worker/sync.ts`](./services/admin/src/worker/sync.ts), [`services/admin/src/worker/reconcile.ts`](./services/admin/src/worker/reconcile.ts), and the receiving domain Worker's internal routes. |
| Change notification delivery | [`services/notifier`](./services/notifier) and [`packages/contracts/src/notification.ts`](./packages/contracts/src/notification.ts). |
| Change backup, monitoring, or scheduled operations | [`services/ops/src/index.ts`](./services/ops/src/index.ts) and [`services/ops/wrangler.jsonc`](./services/ops/wrangler.jsonc). |
| Change shared visual language or UI primitives | [`packages/ui/src/theme.css`](./packages/ui/src/theme.css) and [`packages/ui/src`](./packages/ui/src). |
| Change example_service's native shell or Web/native transport boundary | [`services/example_service/src/web/platform/transport.ts`](./services/example_service/src/web/platform/transport.ts), [`services/example_service/src-tauri/src/api.rs`](./services/example_service/src-tauri/src/api.rs), and [`scripts/check-tauri-boundary.mjs`](./scripts/check-tauri-boundary.mjs). |
| Change Cloudflare resources, bindings, or deployment configuration | [`infra/terraform`](./infra/terraform), affected `wrangler.jsonc`, then [`docs/architecture/infra.md`](./docs/architecture/infra.md). |
| Change production deploy protection or secret placement | [`scripts/check-deploy-boundary.mjs`](./scripts/check-deploy-boundary.mjs), [`.github/workflows/ci.yml`](./.github/workflows/ci.yml), [`.github/workflows/production-bootstrap.yml`](./.github/workflows/production-bootstrap.yml), and [`docs/howto/deploy.md`](./docs/howto/deploy.md). |

### Development and verification

Use `pnpm check` as the repository-wide completion gate; it covers lint,
dependency hygiene, typechecking, the explicit combined Worker/web coverage-gated
test path, and Approved UC/AC E2E traceability. React services expose `test`
(Worker), `test:web` (jsdom), and `test:all` (both); the root `pnpm test` invokes
`test:all` exactly once for each React service. For a focused web test, run
`pnpm --filter <pkg> exec vitest run --config vitest.web.config.ts -t "<name>"`.
When changing UI or API behavior, run `pnpm --filter <pkg> e2e` for the affected
package. The mapping convention and current baseline are in
[`docs/testing/E2E_TRACEABILITY.md`](./docs/testing/E2E_TRACEABILITY.md).

For implementation rules and required checks, use the task-specific guide in
[`AGENTS.md`](./AGENTS.md), rather than expanding this map with policy.

## Keep this map current

Update this map whenever services, packages, bindings, deploy order, or
cross-service flows change. Keep it focused on durable ownership, entry points,
and navigation; link to detailed documentation instead of duplicating it.
