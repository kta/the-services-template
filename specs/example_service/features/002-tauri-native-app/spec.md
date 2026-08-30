# example_tauri_service Tauri Native App

- ステータス: Approved

## What

`example_tauri_service` の React SPA を Tauri v2 shell に載せ、Web と同じ Worker API を desktop / iOS / Android から利用できるようにする。native transport は固定 API origin と厳格な request allowlist を持ち、example_tauri_service の既存 dev 認証 API をそのまま利用する。

## Why

`example_tauri_service` は新サービスのコピー元であり、Web だけでなく native app 化する場合の安全な標準構成も提供する必要がある。一方、このサービスには refresh API がないため、admin の native refresh/keychain 実装を複製せず、再起動時に再ログインする最小構成とする。

## Requirements

- Tauri v2 の desktop / iOS / Android 用 shell と設定を持つ。
- Tauri 用静的 bundle は既存 Worker dev bundle と分離し、相対 asset で読み込む。
- native request は Rust command 経由とし、`/api/` path、GET/POST/PATCH/DELETE、Authorization/Content-Type のみを許可する。
- release build は HTTPS の compile-time API origin を要求し、debug build は localhost / loopback のみ許可する。Vite の `TAURI_DEV_HOST` は dev server/HMR の到達性だけを変え、Rust の API origin allowlist を広げない。
- Tauri access token は memory-only とし、アプリ再起動後はログイン画面から開始する。
- Web の relative fetch、sessionStorage、既存の `AUTH_DEV_GRANT` 認証 API 契約を壊さない。dev grant の署名鍵はローカル専用 `AUTH_DEV_PRIVATE_KEY` とする。
- admin の認証 route、example_tauri_service の API / DB / 本番デプロイ範囲は変更しない。access JWT の RS256 鍵境界は横断仕様に従い、domain Worker に `JWT_PRIVATE_KEY` を置かない。

## Native Acceptance Requirements

- NAC-1: example_tauri_service の Tauri desktop build が、指定した HTTPS API origin で設定される。
- NAC-2: Rust bridge が外部 origin、`/api/` 外の path、未許可 method / header、危険な path を拒否する。
- NAC-3: Tauri login は `sessionStorage` に token を書かず、logout で native memory を消去する。
- NAC-4: browser login は従来どおり `sessionStorage` を使い、既存の example_tauri_service Web テストが green のままである。
- NAC-5: admin と example_tauri_service の両方で Tauri boundary checker が raw fetch、未知の storage write、危険な CSP / capability を検出する。
- NAC-6: manual CI workflow に desktop / iOS / Android の example_tauri_service build job がある。

## Verification

- `pnpm --filter @app/example_tauri_service test:all`
- `pnpm --filter @app/example_tauri_service typecheck`
- `cargo test --manifest-path services/example_tauri_service/src-tauri/Cargo.toml`
- `pnpm check`
- Tauri CLI の desktop build help / metadata validation、および環境が揃う場合の bundle build
