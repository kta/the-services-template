# example_service Tauri 開発・配布準備

この文書は `services/example_service` の Tauri v2 shell をローカルで確認し、検証 artifact を作るための手順である。example_service はコピー元の雛形なので、本番 Worker としてのデプロイや、この dev 認証をそのまま使った配布は行わない。

## Web と native の違い

- Web はこれまでどおり `http://localhost:5173` の同一 Worker へ relative fetch する。
- Tauri は React から `api_request` command を呼び、Rust の reqwest client が build-time に固定された API origin へ接続する。
- native request は `/api/`、GET/POST/PATCH/DELETE、`authorization` / `content-type` header に限定する。外部 origin、redirect、`set-cookie` は renderer に渡さない。
- Web の access token / workspace ID は既存互換の `sessionStorage` に保存する。Tauri は両方を JavaScript memory にだけ保持し、アプリ再起動後は再ログインする。

example_service の `/api/auth/token` は `AUTH_DEV_GRANT=true` の開発用 grant であり、credential-less に任意 workspace の token を発行する。本番認証が必要なサービスへコピーするときは、先に認証仕様を承認し、real login / refresh と tenant policy を実装する。

## 前提ツール

Web 開発の前提に加えて、desktop は Rust と各 OS の Tauri build tool、iOS は Xcode / CocoaPods / XcodeGen、Android は Android SDK / NDK / Java 17 が必要になる。バージョンと現在の検出結果は次で確認する。

```sh
pnpm --filter @app/example_service exec tauri --version
pnpm --filter @app/example_service exec tauri info
pnpm --filter @app/example_service exec tauri ios --help
pnpm --filter @app/example_service exec tauri android --help
```

## Desktop 開発

まず通常どおり dev vars を作る。`tauri dev` の `beforeDevCommand` が Cloudflare
Vite plugin 付きの Worker/Vite dev server も起動するため、Tauri 開発時はこの
コマンドだけを実行する。

```sh
make init
pnpm --filter @app/example_service tauri dev
```

Web だけを確認する場合は `make dev/example_service` を使う。両方を同時に
起動すると :5173 が競合するため、同時実行はしない。

Tauri 用の静的 bundle だけを確認する場合は次を使う。

```sh
pnpm --filter @app/example_service build:tauri
```

## iOS / Android 初期化

生成された native project は `src-tauri/gen/` 以下に置かれ、gitignore 対象である。CI でも毎回 init するため、生成物を手編集してリポジトリへ追加しない。

```sh
pnpm --filter @app/example_service exec tauri ios init --ci --skip-targets-install
pnpm --filter @app/example_service exec tauri android init --ci --skip-targets-install
```

debug build は Rust 側の既定 origin `http://localhost:5173` を使う。実機では端末の localhost は開発 Mac/PC ではないため、port forwarding 等で端末から loopback へ接続できるようにする。HTTPS の remote origin を使う場合は release build として `TAURI_EXAMPLE_API_ORIGIN` を指定する。いずれも任意の origin をアプリ画面から受け取らない。

## Release origin と desktop artifact

release build では `TAURI_EXAMPLE_API_ORIGIN` が必須で、HTTPS の origin だけを受け付ける。path、query、fragment、userinfo、末尾 slash は無効である。これは secret ではなく接続先の設定なので、Rust build script が binary に埋め込む。

```sh
TAURI_EXAMPLE_API_ORIGIN=https://example.example.invalid \
  pnpm --filter @app/example_service exec tauri build \
    --bundles app --target universal-apple-darwin --no-sign
```

`example.example.invalid` は検証用の placeholder であり、実運用 origin ではない。署名、notarization、TestFlight、Play upload はこのテンプレートの workflow に含めず、identifier と所有組織の release policy を確定した後に人間が別途実施する。

## 手動 CI

GitHub Actions の `Example service Tauri native artifacts` を `workflow_dispatch` で起動する。macOS universal app、iOS simulator、Android debug APK、Android debug AAB を作成し、artifact を 7 日間保存する。workflow は署名、store upload、Cloudflare deploy を行わない。

macOS job の `TAURI_EXAMPLE_API_ORIGIN` は repository variable があればそれを使い、無ければ placeholder を使う。iOS / Android の debug job は default debug origin を使うため、いずれも配布物ではない。

## 変更時の確認

```sh
pnpm --filter @app/example_service test:all
pnpm --filter @app/example_service typecheck
cargo test --manifest-path services/example_service/src-tauri/Cargo.toml
pnpm check
```

Tauri API bridge の変更時は Rust の path / method / header allowlist と cookie redaction、frontend の native invoke と Web fallback のテストを同時に更新する。raw fetch、browser storage write、Tauri plugin permission を追加してはならない。
