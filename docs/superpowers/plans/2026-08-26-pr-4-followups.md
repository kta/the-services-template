# PR #4 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task with review checkpoints.

**Goal:** PR #4 の Tauri 実装を実際の Make/ドキュメント運用へつなぎ、同時に admin/domain の JWT 署名鍵と production deploy 境界を分離する。

**Architecture:** Web と Tauri の既存 transport は維持し、通常 Vite の固定 port と Tauri 用 bundle の起動条件を一致させる。認証は admin の RS256 private key 発行 + domain の public key 検証へ移行し、domain の `AUTH_DEV_GRANT` はローカル専用 private key に限定する。production deploy は protected `main` push + GitHub `production` environment を唯一の CI 経路とし、ローカル Make/package の production target は公開しない。

**Tech Stack:** TypeScript、Hono JWT/WebCrypto、Cloudflare Workers/Wrangler、Vite/Tauri v2、GitHub Actions、Make、Vitest、Rust cargo test。

**Spec:** `specs/shared/features/001-asymmetric-access-token/spec.md`、`specs/infra/features/001-protected-production-deploy/spec.md`、`specs/example_tauri_service/features/002-tauri-native-app/spec.md`

## Global Constraints

- `main` 以外、または dirty checkout から Cloudflare production deploy、push、署名 artifact upload、外部 API 送信を実行しない。
- JWT private key は admin とローカル dev 以外へ配らず、domain production は public key のみを持つ。
- access JWT は RS256 固定、旧 HS256/shared secret 経路は残さない。
- `AUTH_DEV_GRANT` と `AUTH_DEV_PRIVATE_KEY` は production 未設定のまま、admin/domain の `.dev.vars` とテスト専用に限定する。example_service の deploy / remote migration は閉じる。
- Zod/Hono RPC/tenant scope/無料枠/既存の refresh cookie 契約を変更しない。
- 実装前にテストを Red で確認し、最後に `pnpm check` と対象 Tauri/Rust 検証を green にする。
- 実装中はコミット、push、deploy を行わない。検証完了後、push 直前にユーザー確認を取る。

### Task 1: 固定 port/host と Tauri Make 導線をテスト先行で直す

**Files:**
- Modify: `services/example_service/vite.config.ts`
- Modify: `services/example_service/vite.tauri.config.ts`
- Modify: `Makefile`
- Modify: `services/example_service/package.json`
- Add/Modify: `scripts/check-tauri-boundary.test.mjs`

**Steps:**

1. Port collision 時に Vite が別 port へ逃げないこと、`make dev/example_service/tauri` が `tauri dev` を呼ぶこと、static Tauri bundle target が `build:tauri` を呼ぶことを静的/実行テストで先に表現する。
2. `strictPort: true`、必要な host forwarding、Make target/help/PHONY、package script を追加する。
3. Tauri help と static bundle を実行し、通常 Web dev と Tauri dev の入口を文書化できる状態にする。

### Task 2: JWT の鍵境界をテスト先行で分離する

**Files:**
- Add: `specs/shared/features/001-asymmetric-access-token/spec.md`
- Modify: `packages/shared/src/jwt.ts`, `packages/shared/src/auth-server.ts`, `packages/shared/src/index.ts`
- Modify: `services/admin/src/worker/index.ts`, `services/admin/src/worker/auth/service.ts`
- Modify: `services/example_service/src/worker/index.ts`
- Modify: `services/admin/wrangler.jsonc`, `services/example_service/wrangler.jsonc`
- Modify: `services/admin/.dev.vars.example`, `services/example_service/.dev.vars.example`
- Modify: `services/admin/vitest.config.ts`, `services/example_service/vitest.config.ts`
- Modify: `packages/shared/test/*.test.ts`, `services/admin/test/*.test.ts`, `services/example_service/test/*.test.ts`

**Steps:**

1. RS256 valid token、HS256 token、別 key token、期限境界、admin private/domain public の Worker 統合テストを追加して Red を確認する。
2. 既存 Hono API を使い、admin の `JWT_PRIVATE_KEY` と domain の `JWT_PUBLIC_KEY` を受ける共通 JWT helper/middleware へ変更する。
3. admin/domain の dev grant は local-only `AUTH_DEV_PRIVATE_KEY` を読み、本番 secret の手順・型には含めない。旧共有署名鍵の参照・手順・型を全て削除する。
4. 非本番の鍵 fixture を用意し、local `make init`、Worker test、既存 auth flow が動くことを確認する。

### Task 3: production deploy を protected main/environment に固定する

**Files:**
- Add: `specs/infra/features/001-protected-production-deploy/spec.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `Makefile`, `package.json`
- Add: `scripts/check-deploy-boundary.mjs`
- Modify: `docs/howto/deploy.md`, `docs/howto/cloudflare-setup.md`
- Modify: `specs/infra/00_infra-spec.md`, `docs/architecture/infra.md`

**Steps:**

1. 任意ブランチの manual dispatch が deploy job/Cloudflare secret に到達しないこと、Make deploy が main 以外で停止することを静的テストで Red にする。
2. deploy condition に push/main/protected を入れ、Cloudflare credentials を `production` environment secret として参照する。manual Tauri workflow には credentials を追加しない。
3. Make deploy targets に exact `main` guard を追加し、`make help` と deploy runbook に実行条件を出す。
4. GitHub Settings の production environment branch rule（protected `main`）と required reviewer の設定手順を docs に追加する。

### Task 4: Tauri security/docs review findings を実装と一致させる

**Files:**
- Modify: `services/example_service/src/web/platform/transport.ts` and tests
- Modify: `services/example_service/src-tauri/src/api.rs` and tests
- Modify: `services/example_service/src-tauri/capabilities/default.json`
- Modify: `docs/howto/tauri-example-service.md`, `docs/architecture/tauri-native-app.md`
- Modify: `README.md`, `docs/README.md`, `AGENTS.md`, `services/example_service/AGENTS.md`, `.agents/skills/new-service/SKILL.md`, `CODEMAP.md`

**Steps:**

1. Add regression tests for `URL` input, encoded backslash, strict port, exact capability permission, and actual CSP/network architecture.
2. Remove dead legacy boundary-checker code and ensure checker covers platform overlay/configuration.
3. Document browser/Tauri commands, mobile `TAURI_DEV_HOST` limitation, static artifact vs dev, Make targets, release origin, secret boundary, and that example_service is not production deployable.
4. Cross-check every command and secret name against package scripts/configs.

### Task 5: verification and self-review

1. Run focused shared/admin/example tests and deploy/Tauri boundary tests.
2. Run Rust unit tests, clippy, Tauri info/help/static build and supported unsigned desktop build if the local platform allows it.
3. Run `pnpm run test:traceability`, `pnpm check`, and the changed UI E2E suites.
4. Review the diff for secret leakage, accidental deploy/upload, unapproved API/data model changes, and stale docs; report exact command results without claiming push/deploy.
