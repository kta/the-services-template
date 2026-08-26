# admin Tauri ネイティブアプリ設計

この文書は refresh cookie と OS protected store を持つ `services/admin` の設計である。`services/example_service` の雛形向け native shell は refresh API を持たないため、別の memory-only auth 方針を採用する。導入手順と境界は [`../howto/tauri-example-service.md`](../howto/tauri-example-service.md) と [`../../specs/example_service/features/002-tauri-native-app/spec.md`](../../specs/example_service/features/002-tauri-native-app/spec.md) を参照する。

## 目的と不変条件

`services/admin` の React UI を macOS、iOS、Android のインストール型アプリとして配布する。一方で、業務データ・認証の正典は既存の Cloudflare Worker + D1 のままである。端末に D1、Worker secret、パスワード、長期 access token を複製しない。

Web は今までどおり同じ Worker から SPA と `/api/*` を配信する。従って Web の `SameSite=Strict; HttpOnly; Secure` refresh cookie、相対 API URL、CORS なしという安全境界を変更しない。

## 構成

```text
Web browser ─── relative fetch ───> admin Worker (/api/*) ───> D1/KV
                                      ↑
Tauri React UI ─ invoke(api_request) ┤ fixed HTTPS origin
                    │                 │
                    ▼                 │
              Rust core (allowlist, cookie jar, refresh rotation)
                    │
                    └── OS protected credential storage
                        macOS: Keychain; iOS: ThisDeviceOnly Keychain
                        Android: Keystore-backed encrypted credential store
```

React の transport は Web なら native `fetch`、Tauri なら Rust の `api_request` だけを呼ぶ。IPC に渡せるのは method、`/api/` で始まる relative path、`authorization` / `content-type` header、body だけである。Rust は absolute URL、`..`、Cookie/Host/Origin header、許可外 method を拒否する。これにより JavaScript や XSS が任意のネットワーク先へ credential を運ぶ経路を作らない。

Worker の `Set-Cookie` は Rust が受け、cookie jar と OS store を更新する。IPC response から `set-cookie` を必ず除く。React が保持するのは短命 access JWT のみで、リロード・アプリ終了で消える。

## セッション状態機械

| 事象 | Rust protected store | React memory | UI |
| --- | --- | --- | --- |
| login / 招待受諾成功 | refresh cookie を保存 | access JWT を設定 | 認証済み |
| 起動時 refresh 成功 | rotated cookie を原子的に置換 | new access JWT を設定 | 認証済み |
| API 401 → refresh 成功 | rotated cookie を置換 | access JWT を差替え、1回再試行 | 継続 |
| refresh 無効・reuse 検知・logout | cookie を削除 | token を消去 | login へ |
| 一時的な network failure | 変更しない | 現在 token があれば維持 | recoverable error / 後で再試行 |
| アンインストール | OS が app credential を削除 | 該当なし | 次回は login |

保存に失敗した場合は成功したログイン状態を長期化しない。refresh response の token/cookie を JS に露出する前に store への書込みが成功しなければ、Rust は session を削除して失敗を返す。これは「閉じるとログインし直し」ではなく、保護保存を保証できない端末だけに明確な再ログインを求める fail-closed である。

## ビルドとルーティング

Cloudflare の `vite.config.ts` は変更後も Web/Worker の出力を作る。Tauri は `vite.tauri.config.ts` で相対 asset path の `dist/tauri` を作るため、Cloudflare build 成果物や Wrangler config を同梱しない。

Web の URL 契約は `BrowserRouter` のままにする。Tauri の custom protocol では packaged reload を安定させるため `HashRouter` を使用し、`#/`, `#/login`, `#/invite` をアプリ内 route とする。招待メールの通常 URL は引き続き Web で処理する。Universal Link/App Link/deep-link は所有ドメインの association file とストア登録が必要なため、初回配布のスコープ外とする。

## 権限、CSP、設定

Tauri capability は main window と `core:default` に限定し、filesystem、shell、opener、clipboard、notification、HTTP plugin は追加しない。CSP は self の script/style/image/font と、固定 Worker API origin への `connect-src` のみを許可する。remote HTML/script は読み込まない。

API origin は build-time `TAURI_ADMIN_API_ORIGIN` として Rust compile に渡す。release build は HTTPS かつ origin 形式を必須とし、ユーザー入力、`VITE_*`、設定画面から変更できない。development build も HTTP の localhost/loopback origin のみを許可し、任意 LAN origin は許可しない（実機からの開発接続は loopback 上の開発 Worker へ安全なポートフォワード等を用いる）。Worker secrets はこの値に含めない。

Android の Keystore provider は `ndk-context` を必要とする。Android platform config の `beforeBuildCommand` は `prepare:tauri:android` を必ず呼び、生成された Activity の `onCreate` で native bridge を初期化する。このスクリプトは生成物の想定外フォーマットで失敗し、初期化なしで build を続けない。macOS Keychain は iOS の `ThisDeviceOnly` 属性を持たないため、移行・バックアップに関する保証を iOS と同一視しない。

アプリ identifier は source 上の pre-release 値であり、初回 Apple/Google 登録前に所有組織の reverse-DNS identifier へ確定する。確定後の変更はストア上で別アプリになるため、リリースチェックリストの blocker とする。

## 配布方針

| Target | 検証 artifact | 本番配布 | 更新経路 |
| --- | --- | --- | --- |
| macOS | unsigned app/DMG | Developer ID signing + notarized DMG（または App Store を別判断） | 初回は手動配布、updater は導入しない |
| iOS | simulator / archive | TestFlight → App Store | App Store |
| Android | debug APK + release AAB | Play internal testing → production | Google Play |

CI は `workflow_dispatch` で unsigned artifact を build・保存するだけにする。署名、notarization、TestFlight upload、Play upload は必要な証明書・store record・人間の最終確認を伴うため、別の手順・手動 job とする。Cloudflare deploy はアプリ build と無関係で、従来どおり明示承認時だけ実行する。

## テスト戦略

- TypeScript: transport の request/response filtering、Web の auth 回帰、Tauri route 選択を Vitest で Red→Green。
- Rust: URL/header allowlist、response redaction、session state machine と memory store を `cargo test` で網羅。実 Keychain/Keystore は unit test から触らない。
- E2E: Web の login/route 回帰、release config の観測可能な safety contract を Playwright に一意に trace する。
- Build: macOS で Tauri bundle、iOS simulator、Android debug/AAB を手動 CI で作成する。実ストア署名は release checklist で確認する。

## 参照

- [Tauri Vite frontend integration](https://v2.tauri.app/start/frontend/vite/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri CSP guidance](https://v2.tauri.app/security/csp/)
- [Tauri distribution overview](https://v2.tauri.app/distribute/)
- [Apple Keychain accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
