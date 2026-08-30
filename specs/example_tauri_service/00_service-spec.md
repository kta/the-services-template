# サービス仕様: example_tauri_service

- パッケージ: `services/example_tauri_service` (`@app/example_tauri_service`)
- 所有 D1: `example_tauri_service`
- ステータス: Approved（Web + Tauri テンプレートの参照実装）

## 目的・責務

Web + Tauri サービスのコピー元。`example_service` と同じ item 契約を使う SPA + Hono Worker + D1 に、固定 origin の native transport、desktop/iOS/Android shell、capability と platform overlay を加えた完成形を示す。本番デプロイ対象ではない。

## エンティティ・API 面

item / organization の所有データ、Hono RPC API、テナント分離、通知契約は `example_service` と同じ。契約の単一ソースは `packages/contracts/src/example_service.ts` を再利用し、Tauri 用の手書き型を増やさない。

## Native 境界

- release API origin は compile-time の固定 HTTPS allowlist に限定する。
- native request は Rust の `api_request` command を経由し、path / method / header / body size を制限する。
- native access token は memory-only。Web 版だけが開発用 sessionStorage を使う。
- `service-catalog.json` で `templateKind: "tauri"`, `native: true`, `deployable: false` として登録し、通常 CI の Rust gate と手動 artifact workflow の対象にする。

## features

- [`002-tauri-native-app`](./features/002-tauri-native-app/spec.md) — Web と native shell の境界、認証 storage、artifact 検証。
