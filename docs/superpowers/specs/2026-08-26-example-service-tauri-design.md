# example_service Tauri 導入 設計

> **Historical / superseded:** この設計は分離前の履歴である。現在の Web + Tauri 雛形は `services/example_tauri_service`、現行仕様は `specs/example_tauri_service/features/002-tauri-native-app/spec.md` を参照する。

ステータス: Approved（2026-08-26、ユーザー承認済み）

## 目的

`services/example_service` を、既存の Cloudflare Worker + React SPA と同じコードベースから Tauri v2 の desktop / iOS / Android アプリとしてビルドできる状態にする。既存の Web 開発体験と `AUTH_DEV_GRANT` ベースの example 用ログイン契約は維持する。ただし access JWT の署名方式は横断仕様に従い RS256 とし、admin の private key と domain の public key を分離する。

## スコープ

- Tauri v2 の Rust shell、desktop / iOS / Android 用の設定、CI ビルド定義を追加する。
- Web 用 Vite 設定とは分離した、相対 asset を使う Tauri 用 Vite bundle を追加する。
- Tauri 側に固定 API origin へ接続する `api_request` command を実装する。
- native transport は `/api/` 配下、GET/POST/PATCH/DELETE、Authorization/Content-Type ヘッダーだけを許可する。
- Web は従来どおり relative fetch + `sessionStorage` を使う。
- Tauri は access token を JavaScript のメモリだけに保持し、アプリ再起動時は再ログインとする。
- 既存の example_service の認証 API（`POST /api/auth/token`、`AUTH_DEV_GRANT`）の route 契約は変更しない。dev grant の署名にはローカル専用 `AUTH_DEV_PRIVATE_KEY` を使い、本番 secret にはしない。

## スコープ外

- example_service への refresh token API、secure keychain、長期セッションの追加。
- admin の認証・refresh 実装の共有化や変更。
- example_service の本番デプロイ、署名、notifier / service binding の変更。
- 新しいデータモデル、画面、ドメイン API の追加。

## 採用アーキテクチャ

```text
Web browser
  React -> platformFetch -> relative fetch -> example_service Worker

Tauri app
  React -> platformFetch -> invoke(api_request)
                         -> Rust reqwest client
                         -> compile-time fixed API origin
                         -> example_service Worker
```

### フロントエンド

`src/web/platform/transport.ts` が runtime を判定する。通常の Web では `globalThis.fetch` を呼び、Tauri runtime では `@tauri-apps/api/core` の `invoke('api_request')` を呼ぶ。アプリの他のコードから raw `fetch` を呼ばせず、API クライアントと認証セッションはこの transport を経由する。

### Rust bridge

`src-tauri/src/api.rs` の `api_request` は、ビルド時に `TAURI_EXAMPLE_API_ORIGIN` を正規化して埋め込む。入力 path を URL の origin として解釈せず、固定 origin に連結する。relative `/api/` path、許可 method/header、encoded traversal/backslash を検査する。redirect は追従せず、レスポンスの `set-cookie` は renderer に返さない。

Tauri capability は `api_request` のみを公開する。filesystem、shell、任意の HTTP plugin、任意 command は追加しない。

### 認証

example_service には admin のような refresh endpoint がないため、auth の挙動を native 向けに水増ししない。Tauri では login 後の access token と organization ID を module memory に置き、logout またはアプリ終了で破棄する。Web では既存互換の `sessionStorage` に保存する。401 は従来どおり明示的に logout してログイン画面へ戻す。

## Origin と環境

- debug: デフォルトは `http://localhost:5173`。localhost / loopback の HTTP だけを許可する。Vite の `TAURI_DEV_HOST` は HMR の bind を変えるだけで、Rust の API origin allowlist は広げない。
- release: `TAURI_EXAMPLE_API_ORIGIN` を必須とし、HTTPS の origin だけを許可する。
- origin に path、query、fragment、userinfo、末尾 slash は許可しない。

このため、release bundle に開発用 URL が紛れ込むことを build script で防ぐ。example_service はテンプレートなので、配布前に利用者が自分の API origin と署名設定を与える。

## 検証方針

- Vitest: Web transport の fallback / native invoke、Web storage / native memory の auth 分岐。
- Rust unit test: origin parser、request path / method / header allowlist、cookie 除去。
- 既存の example_service Worker / Web / E2E テストを維持する。
- 境界チェッカーを admin と example_service の両方へ適用し、native source の raw fetch と未知の storage write を拒否する。
- CI は example_service の Tauri desktop / iOS / Android build workflow を manual dispatch で実行できるようにする。workflow は Cloudflare credential を持たず、unsigned/debug artifact を保存するだけにする。
