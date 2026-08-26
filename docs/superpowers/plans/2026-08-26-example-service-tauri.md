# example_service Tauri 導入 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task with review checkpoints.

**Goal:** `services/example_service` を、既存 Web 挙動と dev 認証契約を維持したまま、Tauri v2 desktop / iOS / Android shell と安全な native API transport を持つ状態にする。

**Architecture:** Web は relative fetch + sessionStorage、Tauri は React から `invoke('api_request')` を経由して Rust の固定-origin reqwest client を呼ぶ。example_service には refresh API がないため native token は memory-only とし、admin の keychain / refresh 実装は共有しない。

**Tech Stack:** Tauri 2、Rust、reqwest、serde、url、Vite、React、Vitest、Cloudflare Vite plugin、GitHub Actions。

**Spec:** `specs/example_service/features/002-tauri-native-app/spec.md`（承認済み）

## Global Constraints

- 日本語の既存リポジトリ規約、SDD/TDD、Zod/Hono RPC、Cloudflare-only のサービス境界を維持する。
- example_service の Worker API、D1 schema、認証契約、production deploy matrix は変更しない。
- raw fetch は platform transport に限定し、Tauri capability は `api_request` のみとする。
- release origin は HTTPS のみ、secret や API key は追加しない。
- コミット、push、deploy は行わない。

## Task 1: Tauri 対応の失敗テストと Web/native transport

**Files:**
- Add: `services/example_service/src/web/platform/transport.test.ts`
- Add: `services/example_service/src/web/auth/session.test.ts`
- Add: `services/example_service/src/web/platform/transport.ts`
- Add: `services/example_service/src/web/auth/session.ts`
- Modify: `services/example_service/src/web/client.ts`
- Modify: `services/example_service/src/web/App.tsx`
- Modify: `services/example_service/src/web/App.test.tsx`
- Modify: `services/example_service/src/web/client.test.ts`

**Steps:**

1. Write Vitest cases for browser relative fetch, Tauri invoke request/response conversion, path/header validation, Web sessionStorage persistence, and Tauri memory-only session behavior.
2. Run the focused Web tests and record the expected Red state because the new modules do not exist yet.
3. Implement `platformFetch` with runtime detection, allowlisted headers/methods, Tauri invoke conversion, and browser fallback.
4. Implement example-local auth session with `devLogin`, `authFetch`, memory-only native token, Web sessionStorage compatibility, and logout-on-401 behavior.
5. Switch example client/App and their tests from shared auth to the service-local auth adapter.
6. Run the focused tests and then the existing example Web tests.

## Task 2: Tauri Rust shell and configuration

**Files:**
- Add: `services/example_service/src-tauri/Cargo.toml`
- Add: `services/example_service/src-tauri/build.rs`
- Add: `services/example_service/src-tauri/src/main.rs`
- Add: `services/example_service/src-tauri/src/lib.rs`
- Add: `services/example_service/src-tauri/src/origin.rs`
- Add: `services/example_service/src-tauri/src/api.rs`
- Add: `services/example_service/src-tauri/tauri.conf.json`
- Add: `services/example_service/src-tauri/tauri.macos.conf.json`
- Add: `services/example_service/src-tauri/tauri.ios.conf.json`
- Add: `services/example_service/src-tauri/tauri.android.conf.json`
- Add: `services/example_service/src-tauri/capabilities/default.json`
- Add: `services/example_service/vite.tauri.config.ts`
- Modify: `services/example_service/package.json`
- Modify: `pnpm-lock.yaml`

**Steps:**

1. Add Rust unit tests for origin normalization and API request validation before completing the corresponding implementations.
2. Implement build-time origin validation, fixed-origin reqwest transport, request allowlist, redirect refusal, and response cookie filtering.
3. Add the minimal Tauri capability and shell configuration, with no filesystem/shell/network wildcard permissions.
4. Add the separate Tauri Vite config and package scripts/dependencies using the versions already used by admin.
5. Install/update the lockfile and run Rust tests, service typecheck, and Tauri CLI metadata/help checks.

## Task 3: Boundary enforcement, CI, and documentation

**Files:**
- Modify: `scripts/check-tauri-boundary.mjs`
- Modify: `scripts/check-tauri-boundary.test.mjs`
- Add: `.github/workflows/example-tauri-build.yml`
- Modify: `services/example_service/AGENTS.md`
- Modify: `README.md`
- Add: `docs/howto/tauri-example-service.md`
- Modify: `CODEMAP.md`

**Steps:**

1. Add boundary checker fixtures/tests for the second service before generalizing the checker.
2. Generalize target discovery/checks for admin and example_service, including the explicit Web-only storage fallback for example dev login.
3. Add manual desktop/iOS/Android example build workflow with the compile-time origin variable and no secrets.
4. Document local development, platform prerequisites, release-origin rules, memory-only native auth, and template limitations.
5. Run checker tests and documentation/format checks.

## Task 4: Full verification and self-review

**Steps:**

1. Run `pnpm --filter @app/example_service test:all` and `pnpm --filter @app/example_service typecheck`.
2. Run `cargo test --manifest-path services/example_service/src-tauri/Cargo.toml`.
3. Run the example Tauri CLI validation/build that the local platform supports.
4. Run `pnpm check` from the repository root and fix all failures without lowering coverage thresholds.
5. Review the diff for accidental API/auth/infrastructure scope expansion, generated artifacts, secrets, and admin regressions.
