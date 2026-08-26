# Tauri native app adoption — implementation plan

> **Execution:** [`001-tauri-native-app/spec.md`](../../../specs/admin/features/001-tauri-native-app/spec.md) is the authority. Work test-first, one task at a time. Do not deploy or upload a signed artifact.

## Architecture decision

`services/admin` remains the sole Cloudflare Worker/API owner. The packaged React bundle never contacts an arbitrary origin: `src/web/platform/transport.ts` uses native `fetch` on Web and Tauri `invoke('api_request')` in a packaged app. Rust validates the relative `/api/` path and forwards it only to its compile-time HTTPS Worker origin. It owns the refresh cookie and keeps it in the platform credential store; the response bridge removes `set-cookie`. Access JWTs remain JavaScript-memory only.

The Cloudflare Vite build and app Vite build are separate: current `vite.config.ts` remains the Worker/Web path; `vite.tauri.config.ts` emits `dist/tauri` with relative assets. Tauri starts it through `beforeBuildCommand`.

The default release identifier is `com.kta.admin`. It must be replaced before a first store submission if the owning Apple/Google account uses another identifier; it is not a runtime override.

## Task 1: Tauri project and safe configuration

**Files:** `services/admin/package.json`, `services/admin/vite.tauri.config.ts`, `services/admin/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,src/lib.rs,src/main.rs}`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

- [ ] Add `@tauri-apps/cli` package script and catalog pin after checking official v2 docs.
- [ ] Configure `devUrl` to strict port 5174 and `frontendDist` to `../dist/tauri`; app build runs `vite --config vite.tauri.config.ts build`.
- [ ] Add no filesystem, shell, opener, HTTP-plugin, or remote-content capability. CSP permits self assets and the fixed HTTPS API `connect-src` only.
- [ ] Make Web Vite `strictPort` and ignore `src-tauri`, without changing Web output.
- [ ] Verify `tauri build -- --help` and `build:tauri`.

## Task 2: browser/Tauri transport (Red → Green)

**Files:** create `src/web/platform/transport.ts`, `transport.test.ts`; modify `src/web/client.ts`, `src/web/auth/session.ts`, `session.test.ts`.

- [ ] Red: prove Web requests retain relative paths and do not invoke Tauri.
- [ ] Red: prove Tauri requests invoke only relative `/api/` paths and build a `Response` without `set-cookie`.
- [ ] Green: define `platformFetch`; detect Tauri using `window.__TAURI_INTERNALS__`, dynamically importing `@tauri-apps/api/core` only natively.
- [ ] Green: migrate raw auth fetches and Hono RPC. Preserve Web 401 refresh/retry.
- [ ] Test malformed/absolute/non-API paths and forbidden request headers fail before IPC.

## Task 3: Rust request boundary (Red → Green)

**Files:** create `src-tauri/src/{api.rs,command.rs,session.rs,store.rs}`, Rust tests; modify `lib.rs`.

- [ ] Red: parser accepts GET/POST/PATCH/DELETE `/api/...`; rejects absolute URL, traversal, non-API path, unsupported method and Cookie/Host/Origin headers.
- [ ] Red: response translator exposes content headers/body/status but strips `set-cookie`.
- [ ] Green: one `reqwest::Client` fixed to `TAURI_ADMIN_API_ORIGIN` compiled by `build.rs`; non-HTTPS rejected outside debug.
- [ ] Green: expose only typed `api_request` in `generate_handler!`.
- [ ] Run `cargo test --manifest-path services/admin/src-tauri/Cargo.toml`.

## Task 4: durable session (Red → Green)

**Files:** `src-tauri/src/{api.rs,session.rs,store.rs}`, Rust tests, `src/web/auth/session.test.ts`.

- [ ] Red: `SessionStore` lifecycle covers login, rotation, invalid refresh, logout and transport failure.
- [ ] Green: save only the refresh cookie in target-native protected storage (Apple Keychain ThisDeviceOnly; Android Keystore-backed storage); never save access token/password.
- [ ] Green: startup refreshes from store, saves a rotated cookie before returning access JWT, deletes it on invalid/logout; network failure retains it.
- [ ] Green: JS never receives `set-cookie`; logout deletes native state even after network failure.
- [ ] Add test-only memory store; tests never access a real keychain.

## Task 5: routing and mobile UI safety

**Files:** `src/web/App.tsx`, `App.test.tsx`, `src/web/components/AppShell.tsx`, related tests/CSS only if needed.

- [ ] Red: packaged Tauri starts a deterministic route while Web keeps `BrowserRouter`.
- [ ] Green: Tauri uses `HashRouter` only; Web routes/links remain unchanged.
- [ ] Add iOS safe-area padding through existing design tokens and validate 375px accessibility layout.

## Task 6: platform builds and CI

**Files:** create `.github/workflows/tauri-build.yml`; modify package scripts and `README.md`.

- [ ] Add manual jobs for macOS app bundle, iOS simulator, Android debug APK/AAB. Upload artifacts, never publish.
- [ ] Keep signing/notarization/Store upload separate and optional; document secret names only.
- [ ] Pin mobile prerequisites/min SDK with Tauri official guidance. No updater path in v1.

## Task 7: release docs and map

**Files:** new `docs/howto/tauri-distribution.md`; `docs/howto/deploy.md`, `docs/architecture/infra.md`, `CODEMAP.md`, `services/admin/AGENTS.md`, `README.md`.

- [ ] Record exact local commands, credentials, signing secrets (names only), artifact retention, checklist, rollback, logout/uninstall behavior.
- [ ] State Cloudflare deploy is independent and user-confirmed; update service map and admin command/security boundary.

## Task 8: traceability and verification

**Files:** `services/admin/e2e/smoke.spec.ts`, feature spec checkboxes.

- [ ] Map every AC exactly once to observable Playwright release/Web scenarios.
- [ ] Run focused Web tests after every Green step, Rust tests, typecheck, Tauri macOS build, admin E2E, final `pnpm check`; record actual output.

## Task 9: review and PR

- [ ] Fresh reviewer audits spec compliance, credential exposure, URL/header validation, platform permissions, and all diffs. Fix confirmed findings and scoped re-review.
- [ ] Self-review `git diff main...HEAD`, secret scan, all gates, then PR body cites US-TAURI-01/02/03 and tests.
