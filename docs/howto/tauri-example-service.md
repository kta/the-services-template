# example_tauri_service Tauri 開発・配布準備

この文書は services/example_tauri_service の Tauri v2 shell をローカルで確認し、検証 artifact を作るための手順である。example_tauri_service はコピー元の雛形なので、本番 Worker としての deploy や、この dev 認証をそのまま使った配布は行わない。

## まず使うコマンド

| 目的 | コマンド |
| --- | --- |
| Web の SPA + Worker API | make dev/example_tauri_service |
| Tauri desktop 開発 | make dev/example_tauri_service/tauri（desktop専用） |
| Tauri 静的 frontend bundle | make build/example_tauri_service/tauri |
| Tauri CLI 情報 | pnpm --filter @app/example_tauri_service tauri info |
| Android emulator / 実機 live development | pnpm --filter @app/example_tauri_service exec tauri android dev |
| iOS simulator / 実機 live development | pnpm --filter @app/example_tauri_service exec tauri ios dev |
| Rust unit test | cargo test --manifest-path services/example_tauri_service/src-tauri/Cargo.toml |

`make dev/example_tauri_service/tauri` は Tauri desktop の `tauri dev` を起動する Make target であり、Android/iOS の live development には使わない。通常の Web server と同じ 5175 port を使うため、`make dev/example_tauri_service` と同時に起動しない。port collision 時は Vite が別 port へ逃げずに失敗する。

## Web と native の違い

- Web は http://localhost:5175 の同一 Worker へ relative fetch する。
- Tauri は React から api_request command を呼び、Rust の reqwest client が build-time に固定された API origin へ接続する。
- native request は /api/、GET/POST/PATCH/DELETE、authorization / content-type header に限定する。外部 origin、redirect、set-cookie は renderer に渡さない。
- Web の access token / workspace ID は既存互換の sessionStorage に保存する。Tauri は両方を JavaScript memory にだけ保持し、アプリ再起動後は再ログインする。
- Tauri shell は JWT_PRIVATE_KEY、JWT_PUBLIC_KEY、caller-specific な内部鍵などの Worker secret を持たない。access JWT の署名は admin Worker、検証は domain Worker が行う。

example_tauri_service の /api/auth/token は AUTH_DEV_GRANT=true と AUTH_DEV_PRIVATE_KEY がローカル設定にあるときだけ credential-less に任意 workspace の token を発行する。本番では両方を設定せず、real login / refresh と tenant policy を実装してから配布する。

## 前提ツール

Web 開発の前提に加えて、desktop は Rust と各 OS の Tauri build tool、iOS は Xcode / CocoaPods / XcodeGen 2.46.0、Android は platform API 35 / NDK 27.2.12479018 / Java 17 が必要になる。Rust toolchain はリポジトリの `rust-toolchain.toml`（1.88.0）で固定し、manual verification workflow は Rust/XcodeGen/Android のバージョンを検査する。Tauri が生成した Gradle の compileSdk/ndkVersion と一致しなければ停止する。Tauri CLI は `pnpm-lock.yaml`、Rust crate は各 `Cargo.lock` を正とする。

    pnpm --filter @app/example_tauri_service exec tauri --version
    pnpm --filter @app/example_tauri_service exec tauri info
    pnpm --filter @app/example_tauri_service exec tauri ios --help
    pnpm --filter @app/example_tauri_service exec tauri android --help

## Desktop 開発

初回は make init で dev vars、local D1 migration、seed を用意する。

    make init
    make dev/example_tauri_service/tauri

Web だけを確認する場合:

    make dev/example_tauri_service

Tauri 用の静的 bundle だけを確認する場合:

    make build/example_tauri_service/tauri

静的 bundle は Cloudflare Worker の dist とは別の dist/tauri に出力され、Wrangler config や Worker runtime を同梱しない。

## iOS / Android の初期化と mobile host

生成された native project は src-tauri/gen/ 以下に置かれ、gitignore 対象である。生成物を手編集してリポジトリへ追加しない。

    pnpm --filter @app/example_tauri_service exec tauri ios init --ci --skip-targets-install
    pnpm --filter @app/example_tauri_service exec tauri android init --ci --skip-targets-install

実機 HMR は、まず開発端末の loopback port を端末側 localhost へ port forwarding/tunnel する。これなら checked-in の devCsp にある localhost の API/Vite/HMR 許可と一致する。Tauri の native window / Android / iOS の開発コマンドは、必要な SDK と forwarding を用意した後に実行する。

直接 LAN host へ bind する場合だけ、モバイルの dev コマンドへ `TAURI_DEV_HOST` を渡す。desktop は Make target のままでよい。

    # Android emulator / 実機
    TAURI_DEV_HOST="$(ipconfig getifaddr en0)" pnpm --filter @app/example_tauri_service exec tauri android dev

    # iOS simulator / 実機
    TAURI_DEV_HOST="$(ipconfig getifaddr en0)" pnpm --filter @app/example_tauri_service exec tauri ios dev

`TAURI_DEV_HOST` は loopback または private LAN の IP に限るが、checked-in の `devCsp` は localhost/loopback のみを許可する。したがって、このままの設定で private IP を使った HMR を強行せず、直接 LAN を採用する fork は対象 IP を `devCsp.connect-src`、境界テスト、firewall 手順へ個別に追加してレビューする。`ws:` や `*` の wildcard は追加しない。TAURI_DEV_HOST は dev server/HMR の bind 設定であり、API の認証や release origin を変更しない。

Rust bridge の debug API origin は HTTP localhost/loopback のみを許可する。実機では端末の localhost は開発 Mac/PC と別なので、端末側 localhost へ port forwarding/tunnel を用意する。任意 LAN origin をアプリ画面や runtime config から受け取る設計にはしない。forwarding が用意できない場合は desktop または simulator で確認する。

## Release origin と desktop artifact

release build では TAURI_EXAMPLE_TAURI_SERVICE_API_ORIGIN が必須で、HTTPS の origin だけを受け付ける。path、query、fragment、userinfo、末尾 slash は無効である。これは secret ではなく接続先の設定なので Rust build script が binary に埋め込む。

    # unsigned debug verification (uses the fixed loopback debug origin)
    pnpm --filter @app/example_tauri_service exec tauri build \
      --debug --bundles app --target universal-apple-darwin --no-sign

    # signed release is a separate, human-approved process after adding the
    # service origin to src-tauri/src/origin.rs
    TAURI_EXAMPLE_TAURI_SERVICE_API_ORIGIN=https://example.example.com \
      pnpm --filter @app/example_tauri_service exec tauri build \
        --bundles app --target universal-apple-darwin

example.example.com は検証用 placeholder であり、実運用 origin ではない。release origin は `src-tauri/src/origin.rs` の固定 allowlist に登録された値だけを受け付ける。フォークでは所有ドメインをレビュー後に allowlist と build variable の両方へ反映する。署名、notarization、TestFlight、Play upload はこのテンプレートの workflow に含めず、identifier と所有組織の release policy を確定した後に人間が別途実施する。配布前に実 origin を compile-time に設定し、artifact secret scan と署名済み protected-store smoke test を通す。

## 手動 CI

GitHub Actions の Example Tauri Service native artifacts を `workflow_dispatch` で起動する。macOS universal app、iOS simulator、Android debug APK、Android debug AAB を作成し、artifact を 7 日間保存する。重い platform artifact build は通常 PR verify から外し、通常 verify は `admin` と `example_tauri_service` の Rust fmt/test/clippy と静的 boundary だけを実行する。Web-only の `example_service` は native gate の対象にしない。workflow は署名、store upload、Cloudflare deploy を行わない。

macOS job は Rust の固定 loopback debug origin で unsigned debug artifact を作るため、いずれも本番配布物ではない。手動 workflow は Cloudflare credential、JWT_PRIVATE_KEY、Worker secret を持たず、署名・notarization・store upload も行わない。署名済み release の Protected Data/Keystore 動作確認と配布は workflow 外で実施する。

## native boundary の注意

- renderer から raw fetch や Tauri plugin API を呼ばず、platformFetch だけを使う。
- native の path input は relative な /api/ path だけを許可する。URL object や absolute URL も同一 origin に見えて許可しない。
- encoded dot segment、backslash、header control character、重複した認証 header を native bridge で拒否する。
- response の set-cookie を renderer に返さない。
- capability は `windows: ["main"]` に限定し、example_tauri_service は `allow-api-request` だけを許可する。`remote` / `webviews`、filesystem、shell、opener、任意 HTTP plugin、任意 command を追加しない（admin は別途 `allow-clear-session` も持つ）。
- platform overlay で security/CSP/capability を上書きしない。

## 変更時の確認

    pnpm --filter @app/example_tauri_service test:all
    pnpm --filter @app/example_tauri_service typecheck
    cargo fmt --check --manifest-path services/example_tauri_service/src-tauri/Cargo.toml
    cargo test --locked --manifest-path services/example_tauri_service/src-tauri/Cargo.toml
    cargo clippy --all-targets --manifest-path services/example_tauri_service/src-tauri/Cargo.toml -- -D warnings
    pnpm run test:traceability
    pnpm check

Tauri API bridge の変更時は Rust の path / method / header allowlist と cookie redaction、frontend の native invoke と Web fallback のテストを同時に更新する。Tauri の shell 設定を変更したら scripts/check-tauri-boundary.mjs も実行する。
