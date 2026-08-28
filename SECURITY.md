# Security policy

## ⚠️ This is a template with intentional, documented insecure defaults
Before any real deployment, address the items in [`docs/howto/deploy.md`](./docs/howto/deploy.md):
- **the development grant route is intentionally unauthenticated** (`/api/auth/token` only when explicitly enabled); operator APIs such as `/api/organizations` require an authenticated platform-admin JWT.
- **`/api/auth/token` is a dev grant** (mints a JWT for any org, no credential check).
- Local `.dev.vars.example` files contain caller-specific development placeholders only, and local JWT fixtures are checked in for tests only — generate independent production values for each internal API direction and each domain, store them in GitHub's protected `production` environment, and let the reviewed bootstrap/rotation workflow register `JWT_PRIVATE_KEY` only on admin and `JWT_PUBLIC_KEY` on admin/domain Workers. Production domain requests also pass `requireLiveDomainSession`, which checks `sid/sub/org` against admin's current refresh session and user/org state; an admin binding failure returns 503 fail closed. `scripts/put-production-secret.mjs` is validation-only and never invokes `wrangler secret put` locally.

## Reporting a vulnerability
For issues in this template's code (not the intentional defaults above), please use
GitHub's private vulnerability reporting (repo → Security → "Report a vulnerability")
rather than a public issue.
