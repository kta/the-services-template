# admin Tauri ネイティブアプリ設計

この文書は refresh cookie と OS protected store を持つ services/admin の設計である。services/example_tauri_service の雛形向け native shell は refresh API を持たないため、memory-only auth 方針を採用する。導入手順は docs/howto/tauri-example-service.md と docs/howto/tauri-distribution.md、仕様は specs/example_tauri_service/features/002-tauri-native-app/spec.md を参照する。

## 目的と不変条件

services/admin の React UI を macOS、iOS、Android のインストール型アプリとして配布する。一方で、業務データ・認証の正典は既存の Cloudflare Worker + D1 のままである。端末に D1、Worker secret、private signing key、パスワード、長期 access token を複製しない。

Web は今までどおり同じ Worker から SPA と /api/* を配信する。Web の SameSite=Strict; HttpOnly; Secure refresh cookie、相対 API URL、CORS なしという境界を変更しない。

## 構成

    Web browser ─── relative fetch ───> admin Worker (/api/*) ───> D1
                                          ↑
    Tauri React UI ─ invoke(api_request) ┤ fixed API origin
                        │                 │
                        ▼                 │
                  Rust core (allowlist, cookie jar, refresh rotation)
                        │
                        └── OS protected credential storage
                            macOS: release Protected Data (debug は legacy Keychain)
                            iOS: ThisDeviceOnly Keychain
                            Android: Keystore-backed encrypted credential store

React の transport は Web なら native fetch、Tauri なら Rust の api_request だけを呼ぶ。IPC に渡せるのは method、/api/ で始まる relative path、authorization / content-type header、body だけである。Rust は absolute URL、..、Cookie/Host/Origin header、許可外 method、redirect を拒否する。さらに native shell の top-level navigation は `tauri://localhost` / `tauri.localhost` と、debug 時だけ build-time 固定された loopback Vite origin に限定し、release では API origin や外部サイトを WebView のページとして開かない。これにより JavaScript や XSS が任意のネットワーク先へ credential を運ぶ経路を作らない。

IPC の payload 上限は二段で検査する。Tauri の command dispatcher はアプリの handler より前に payload を `InvokeBody` として構築するため、アプリコードだけでは wire bytes の parse 前上限を設定できない。そこで generated handler の前段で `api_request` の payload を 2 MiB 以下か確認し、その後も Rust の JSON decode、method/path/header/body、レスポンスの各フィールドで個別上限を検査する。この上限は framework が一時的に payload を materialize すること自体を無くすものではなく、command 引数の clone/deserialization とアプリ処理への到達を抑える境界である。

Worker の Set-Cookie は Rust が受け、cookie jar と OS store を更新する。IPC response から set-cookie を必ず除く。React が保持するのは短命 access JWT のみで、リロード・アプリ終了で消える。

## セッション状態機械

| 事象 | Rust protected store | React memory | UI |
| --- | --- | --- | --- |
| login / 招待受諾成功 | refresh cookie を保存 | access JWT を設定 | 認証済み |
| 起動時 refresh 成功 | rotated cookie を原子的に置換 | new access JWT を設定 | 認証済み |
| API 401 → refresh 成功 | rotated cookie を置換 | access JWT を差替え、1回再試行 | 継続 |
| refresh 無効・reuse 検知・logout | cookie を削除 | token を消去 | login へ |
| 一時的な network failure | 変更しない | 現在 token があれば維持 | recoverable error / 後で再試行 |
| アンインストール | OS が app credential を削除 | 該当なし | 次回は login |

保存に失敗した場合は成功したログイン状態を長期化しない。refresh response の token/cookie を JS に露出する前に store への書込みが成功しなければ、Rust は session を削除して失敗を返す。

## ビルドとルーティング

Cloudflare の Vite config は Web/Worker の出力を作る。Tauri は vite.tauri.config.ts で相対 asset path の dist/tauri を作るため、Cloudflare build 成果物や Wrangler config を同梱しない。

Web の URL 契約は BrowserRouter のままにする。Tauri の custom protocol では packaged reload を安定させるため HashRouter を使用し、#/, #/login, #/invite をアプリ内 route とする。招待メールの通常 URL は引き続き Web で処理する。Universal Link/App Link/deep-link は初回配布のスコープ外とする。

## 開発サーバーと mobile host

admin の通常 Vite server は port 5174、example_tauri_service は port 5175 を strictPort=true で使う。Tauri の devUrl はこの固定 port を指すため、port が使用中なら Vite は別 port へ逃げずに失敗する。これにより native window が別アプリの server を開く事故を防ぐ。

デスクトップ開発は `make dev/admin/tauri` または `make dev/example_tauri_service/tauri` を使う。iOS/Android の実機で HMR を使う場合は Vite の TAURI_DEV_HOST に開発端末から到達できる host を明示し、firewall と必要な port forwarding を設定する。Rust bridge の debug API origin は HTTP localhost/loopback のみを許可するため、TAURI_DEV_HOST だけで任意 LAN origin を release bundle に埋め込めるわけではない。実機の API 接続は端末側 localhost への安全な forwarding/tunnel が必要である。

## 権限、CSP、設定

各 Tauri shell の capability file は `windows: ["main"]` のローカル main window に限定する。admin は `allow-api-request` と `allow-clear-session`、example_tauri_service は `allow-api-request` だけを許可する。`remote`、`webviews`、core:default、filesystem、shell、opener、clipboard、notification、任意 HTTP plugin、任意 command は追加しない。唯一の core plugin builder は top-level navigation guard であり、境界チェッカーがこの実装と capability の対象 window/権限を検証する。build script が各 shell の command ACL を生成する。

CSP は main config の app.security に置き、production の default-src self、base-uri self、object-src none、script-src self、style-src self、img-src self data、font-src self、connect-src self ipc: http://ipc.localhost だけを許可する。開発 CSP だけが inline style と固定された localhost の Vite/HMR port を追加する。LAN 全体を許可する wildcard は使わず、実機 HMR は port forwarding を優先する。直接 LAN host を使う場合は、レビュー済み devCsp にその host を個別追加してから実行し、チェック済み設定のまま `TAURI_DEV_HOST` に任意の private IP を渡して CSP を迂回しない。Rust reqwest が固定 API origin へ接続するため、固定 Worker origin を renderer の connect-src に追加する設計ではない。remote HTML/script、wildcard network source、platform overlay からの security override は許可しない。

API origin は build-time の TAURI_ADMIN_API_ORIGIN として Rust compile に渡す。release build は HTTPS かつ origin 形式を必須とし、ユーザー入力、VITE_*、設定画面から変更できない。development build も HTTP の localhost/loopback origin のみを許可する。Worker secret、JWT_PRIVATE_KEY、AUTH_PEPPER、caller-specific な内部鍵はこの値に含めない。macOS の unsigned debug build は開発用 legacy Keychain、署名済み release build は app-scoped Protected Data store を使う（Protected Data の対応 OS に合わせ、admin の minimumSystemVersion は 10.15）。release 配布では Apple signing/entitlement を必ず整える。

Android の Keystore provider は ndk-context を必要とする。Android platform config の beforeBuildCommand は prepare:tauri:android を必ず呼び、生成された Activity の onCreate で native bridge を初期化する。想定外の形式なら build を続けない。

## access JWT の秘密鍵境界

access JWT は RS256 固定である。admin Worker だけが JWT_PRIVATE_KEY を保持して署名し、admin と domain Worker は JWT_PUBLIC_KEY で検証する。issuer は `admin`、audience は admin API が `admin`、domain API が `domain:<service_name>`（雛形は `domain:example_tauri_service`）に固定する。Tauri shell はどちらの鍵も保持せず、固定 API origin に HTTPS で接続するだけである。domain Worker に private key を設定すると、この設計の侵害時横展開防止が失われるため、本番チェックで拒否する。

## 配布方針

| Target | 検証 artifact | 本番配布 | 更新経路 |
| --- | --- | --- | --- |
| macOS | unsigned debug `.app` | Developer ID signing + notarized DMG（または App Store を別判断） | 初回は手動配布 |
| iOS | simulator / archive | TestFlight → App Store | App Store |
| Android | debug APK + release AAB | Play internal testing → production | Google Play |

CI は workflow_dispatch で unsigned/debug artifact を build・保存するだけにする。署名、notarization、TestFlight upload、Play upload、Cloudflare deploy はこの workflow で行わない。Tauri build と Cloudflare deploy は別の承認境界である。

## テスト戦略

- TypeScript: transport の request/response filtering、Web の auth 回帰、Tauri route 選択を Vitest で検証する。
- Rust: URL/header allowlist、response redaction、session state machine と memory store を cargo test で網羅する。
- E2E: Web の login/route 回帰を Playwright で確認する。infrastructure-only の検証は静的 checker/unit test で確認する。
- Build: macOS で Tauri bundle、iOS simulator、Android debug/AAB を manual workflow で作成する。実ストア署名は release checklist で確認する。

## 参照

- [Tauri Vite frontend integration](https://v2.tauri.app/start/frontend/vite/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri CSP guidance](https://v2.tauri.app/security/csp/)
- [Tauri distribution overview](https://v2.tauri.app/distribute/)
- [Apple Keychain accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
