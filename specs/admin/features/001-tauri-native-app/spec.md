# 001-tauri-native-app: admin ネイティブアプリ

- ステータス: Approved

## 1. WHAT / WHY

**概要**（3 行以内）:

既存の admin React + Vite UI を macOS、iOS、Android に同梱して配布できるようにする。Web 版の Cloudflare Worker と同一オリジン認証は変更せず、アプリを閉じても安全にログインを復元する。

**ユーザーストーリー**:

- US-TAURI-01: 運営者として、macOS・iOS・Android のネイティブアプリから既存の admin 機能を利用したい。
- US-TAURI-02: ログイン済みの運営者として、アプリを閉じる・端末を再起動する・アプリを更新しても、認証が有効な間は再ログインせずに利用したい。
- US-TAURI-03: 運用者として、Web のデプロイとアプリの署名・ストア配布を混同せずに準備・検証したい。

**Playwright で観測する受け入れ基準**:

- AC-TAURI-02: Given Web 版の admin に未認証でアクセスする When Web ブラウザで保護された画面を開く Then `/login` へ誘導され、ログイン UI が表示される。

Tauri の native shell や Rust core を起動しない admin Playwright suite から、native artifact・保護ストア・IPC の安全境界を主張してはならない。以下は同じ機能の受け入れ条件を、実際に検証できる層へ割り当てた検証要件である。これらは `UC-*` / `AC-*` 定義ではないため、E2E traceability の Playwright 分母には含めない。

**Rust / unit / CI で検証する要件**:

- NATIVE-TAURI-01: macOS/iOS/Android の Tauri build が同一の React UI を含む検証 artifact を生成する。検証は `.github/workflows/tauri-build.yml` の macOS Universal、iOS simulator、Android debug APK/AAB job で行う。
- WEB-TAURI-01: Web 版の login、refresh、logout は相対 `/api/*` と Strict な HttpOnly refresh cookie の既存契約を維持する。検証は `services/admin/src/web/auth/session.test.ts` と既存 Worker auth test で行う。これは browser E2E で cookie の内部状態を確認したことを意味しない。
- NATIVE-TAURI-02: Tauri 版の再起動時は Rust core が保護ストアの refresh credential を使って refresh し、JS に refresh credential を公開せずログイン状態を復元する。検証は `services/admin/src-tauri/src/session.rs`、`store.rs`、`api.rs` の `cargo test` と native transport の Vitest で行う。
- NATIVE-TAURI-03: Tauri 版で logout、refresh の失効、または refresh credential のローテーション失敗が起きた場合、保護ストアの credential を削除し、access token として利用できない状態にする。検証は `services/admin/src-tauri/src/session.rs` と `api.rs` の `cargo test` で行う。
- NATIVE-TAURI-04: Tauri の frontend から Rust command へ渡せるのは固定した HTTPS Worker origin 配下の `/api/` 相対パスと許可済み header だけであり、任意 URL、Cookie、Host、Origin header は拒否される。検証は `services/admin/src-tauri/src/origin.rs`、`api.rs` の `cargo test` と `services/admin/src/web/platform/transport.test.ts` で行う。
- CI-TAURI-01: CI の手動 build workflow は署名情報なしで検証用 artifact を作成し、署名・notarization・Store upload を実行しない。検証は `.github/workflows/tauri-build.yml` の workflow 定義レビューと各 artifact job の成功で行う。

**スコープ外**:

- オフライン業務データ、D1 の端末複製、同期キュー。
- refresh token・パスワード・Worker secret を JavaScript、localStorage、sessionStorage、設定ファイルへ保存すること。
- Web API の CORS 緩和、cookie の SameSite 属性変更、認証契約の変更。
- iCloud/Android backup を使った credential 移行、アンインストール後のログイン維持、初回リリースの自動ストア公開。

**不明点**: なし。配布前に、実運用の bundle identifier、Apple Team ID、Google Play app record、production Worker origin を release settings として投入する。

## 2. HOW

**触るファイル**:

- `services/admin/src/web/platform/transport.ts` — Web/Tauri の型付き fetch adapter。
- `services/admin/src/web/auth/session.ts` — adapter 経由の login/refresh/logout とアプリ起動時復元。
- `services/admin/src-tauri/src/*` — API request allowlist、session 永続化 abstraction、Tauri command。
- `services/admin/vite.tauri.config.ts` — Cloudflare build と独立した Tauri SPA build。
- `services/admin/src-tauri/tauri.conf.json` / `capabilities/default.json` — 最小権限・CSP・配布設定。
- `.github/workflows/tauri-build.yml` と配布文書 — artifact build と署名・store 手順。

**契約**:

- `api_request({ method, path, headers, body }) -> { status, headers, body }`。`path` は `/api/` で始まる相対パス、許可する request header は `authorization` と `content-type` のみ。
- `session_store` は refresh `Set-Cookie` だけを保存する。access JWT はメモリ限定、response の `set-cookie` は JavaScript に返さない。

**データモデル差分**: なし。Worker/D1 の auth schema・token rotation 契約を変更しない。

**却下した代替案**:

- Remote URL wrapper: 同梱アプリにならず、要件に合わない。
- WebView fetch + CORS: SameSite/CORS を緩め、WebView の cookie 挙動へ認証安全性を委ねるため却下。
- Tauri HTTP plugin: response `set-cookie` が JS 層に見え得るため却下。
- Stronghold: 将来の非推奨化方針があるため、新規採用しない。

## 3. TASKS

- [ ] T-001: transport の Web/Tauri URL・header 境界テストを Red で追加する。
- [ ] T-002: Rust の request allowlist と session lifecycle unit test を Red で追加する。
- [ ] T-003: Tauri shell、Rust bridge、OS protected-session store を Green で実装する。
- [ ] T-004: auth session を transport に移行し、Web の既存テストを維持して Tauri restore/logout を Green にする。
- [ ] T-005: Tauri 固有 Vite build、capability/CSP、macOS/iOS/Android artifact build workflow を追加する。
- [ ] T-006: deploy/release/AGENTS/CODEMAP 文書、release checklist、細分化 TODO を更新する。
- [ ] T-007: admin test、Rust test、Tauri build、対象 E2E、`pnpm check` を green にし、AC をレビューする。
