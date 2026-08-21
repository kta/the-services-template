# Security policy

## ⚠️ This is a template with intentional, documented insecure defaults
Before any real deployment, address the items in [`docs/howto/deploy.md`](./docs/howto/deploy.md):
- **admin API is unauthenticated** (`/api/organizations`).
- **`/api/auth/token` is a dev grant** (mints a JWT for any org, no credential check).
- `INTERNAL_KEY` / `JWT_SECRET` ship as dev placeholders — rotate to real secrets via `wrangler secret put`.

## Reporting a vulnerability
For issues in this template's code (not the intentional defaults above), please use
GitHub's private vulnerability reporting (repo → Security → "Report a vulnerability")
rather than a public issue.
