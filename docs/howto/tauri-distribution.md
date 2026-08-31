# Admin Tauri 配布準備

この文書は `services/admin` の Tauri v2 検証 artifact を作り、署名済み配布へ引き渡すための手順である。Tauri アプリは既存 Worker の Web/API と別の配布物であり、Cloudflare deploy はこの手順に含めない。

## 現在の境界

- identifier は pre-release 値 `com.kta.admin` を維持する。
- 初回の Apple App Store / Google Play 登録前に、所有組織の reverse-DNS identifier、production Worker origin、Apple Team ID、Play Console の app record を確定する。identifier を登録後に変更すると別アプリになるため、これらが初回 store submission の blocker である。
- store submission 前に、承認済みアプリアイコンから `tauri icon` を実行して desktop/mobile の全 asset set を生成し、Apple/Google の表示を確認する。現在の `icons/icon.png` は検証用 source であり、商用ブランド確定を意味しない。
- macOS artifact は Universal (`aarch64` + `x86_64`) の unsigned debug `.app`（debug は legacy Keychain を使う）、iOS artifact は Apple Silicon simulator 用 debug product、Android artifact は debug signing の APK/AAB である。いずれも store 配布物ではない。署名済み release の macOS は app-scoped Protected Data を使うが、CI artifact では実行検証しない。
- CI は署名、notarization、TestFlight upload、Play upload、Cloudflare deploy を実行しない。証明書・keystore・store API token はこの workflow に追加しない。

## ローカルで確認するコマンド

Node 22、pnpm 11、Rust 1.88.0、Xcode、CocoaPods、XcodeGen 2.46.0、Android platform API 35、Android NDK 27.2.12479018 を用意した環境で実行する。Rust はリポジトリの `rust-toolchain.toml` で固定し、CI の manual verification workflow も Rust/XcodeGen/Android のバージョンを検査する。Tauri が生成した Gradle の compileSdk/ndkVersion と一致しなければ停止する。Tauri CLI は `pnpm-lock.yaml`、Rust crate は各 `Cargo.lock` を正とする。

```sh
# CLI と設定の確認
pnpm --filter @app/admin exec tauri --version
pnpm --filter @app/admin exec tauri ios --help
pnpm --filter @app/admin exec tauri android --help
pnpm --filter @app/admin exec tauri info

# Web/Worker を desktop native window と一緒に開発する場合
make dev/admin/tauri

# Android emulator / 実機の live development（初回は android init が必要）
pnpm --filter @app/admin exec tauri android dev

# iOS simulator / 実機の live development（初回は ios init が必要）
pnpm --filter @app/admin exec tauri ios dev

# Tauri frontend bundle だけを作る場合
make build/admin/tauri

# 初回だけ。生成物は src-tauri/gen/ 以下で、リポジトリには含めない。
pnpm --filter @app/admin exec tauri ios init --ci --skip-targets-install
pnpm --filter @app/admin exec tauri android init --ci --skip-targets-install

# macOS unsigned debug 検証 bundle（Rust の debug origin は localhost 固定）
pnpm --filter @app/admin exec tauri build \
  --debug --bundles app --target universal-apple-darwin --no-sign

# 署名済み release は、承認済み origin を src-tauri/src/origin.rs に登録した
# 後、組織の signing/notarization 手順で別途作成する（CI では実行しない）。
TAURI_ADMIN_API_ORIGIN=https://admin.example.com \
  pnpm --filter @app/admin exec tauri build \
    --bundles app --target universal-apple-darwin

# iOS simulator
pnpm --filter @app/admin exec tauri ios build --debug --target aarch64-sim --no-sign

# Android debug 検証（APK と AAB は CI で別 job）
pnpm --filter @app/admin exec tauri android build --debug --apk --target aarch64
pnpm --filter @app/admin exec tauri android build --debug --aab --target aarch64
```

`tauri ios/android init` は公式 Tauri CLI が Xcode/Android SDK を検査する。SDK がない端末では初期化自体が失敗するため、CI は platform SDK を用意してから毎回 init する。Android build は platform config の `beforeBuildCommand` から必ず `prepare:tauri:android` を実行する。これは Keystore provider の Android Context を Activity 起動前に初期化する bridge を生成物へ適用し、想定外の Activity 形式なら失敗するため、直接 `tauri android build` しても省略できない。`src-tauri/gen/` と `src-tauri/target/` は `.gitignore` 済みで、CLI の生成物や build cache をコミットしない。

`make dev/admin/tauri` は desktop 専用である。`tauri android dev` / `tauri ios dev` は各 mobile project の live development 用で、`beforeDevCommand` と platform 固有の準備処理を実行する。実機 HMR は `TAURI_DEV_HOST` と port forwarding が必要で、Rust bridge の debug API origin は localhost/loopback 固定である。端末の localhost から開発 PC の Worker へ到達できる forwarding/tunnel を用意できない場合は、desktop または simulator で API を確認する。

通常 Vite は 5174 を `strictPort` で固定する。iOS/Android 実機の HMR は `TAURI_DEV_HOST` と必要な port forwarding を使うが、Rust bridge の debug API origin は localhost/loopback に限定される。実機の API 接続に任意 LAN origin を設定画面から渡したり、Worker secret / `JWT_PRIVATE_KEY` を bundle に入れたりしない。access JWT は admin Worker の private key で署名し、Worker 側の public key で検証する。

アイコンを確定したら、次のコマンドで各 platform の asset set を更新する（実行結果の `gen/` は引き続きコミットしない）。

```sh
pnpm --filter @app/admin exec tauri icon src-tauri/icons/icon.png --ios-color '#fff'
```

## 手動 CI artifact

GitHub Actions の `Tauri native artifacts` を `workflow_dispatch` で起動する。ジョブは次の4つに分離され、各成果物は7日間保存される。

| job | artifact | 意味 |
| --- | --- | --- |
| `macos-universal` | `tauri-macos-universal-debug` | unsigned Universal debug `Admin.app` |
| `ios-simulator` | `tauri-ios-simulator` | unsigned `aarch64-sim` build product |
| `android-debug-apk` | `tauri-android-debug-apk` | debug-signed APK |
| `android-debug-aab` | `tauri-android-debug-aab` | debug-signed AAB |

macOS job は Rust の debug 既定値（localhost）で unsigned debug artifact を作る。debug artifact は起動・IPC・secret scan の検証専用で、本番配布や実運用データへの接続に使わない。release origin は `src-tauri/src/origin.rs` の固定 allowlist に追加した値だけを受け付けるため、フォークでは所有ドメインをレビュー後に登録する。iOS/Android debug build も store submission 用ではない。配布には実 origin、署名、notarization / store signing、Protected Data/Keystore の実機 smoke test が全て必要である。

catalog/workflow checker は、未登録 workflow から native package/CLI を起動する通常の設定ミスを fail closed にし、意図しない重い CI overhead を防ぐための静的 guard である。悪意ある任意 shell、repository helper、composite action の全意味を解析する security proof ではない。また、`GITHUB_ACTIONS` と GitHub context、nonce/capability の runtime check は caller-controlled な値を含む defense-in-depth であり、実行元の attestation ではない。運用上の trust boundary は catalog 登録 job の exact profile と protected-branch review に置き、この manual workflow には production Cloudflare credential、Worker secret、Apple/Android signing material、store API token を一切渡さない。

## 署名と store 提出（CI の外で人間が実施）

### macOS

1. Apple Developer の bundle ID を確定 identifier で作成する。
2. Developer ID Application の署名、hardened runtime、notarization を release 作業で設定する。
3. notarization 済み DMG/zip の Gatekeeper 検証後に配布する。App Store を選ぶ場合は App Sandbox entitlement と App Store Connect の別 build/export 手順を用意する。

### iOS

1. App ID、Apple Distribution certificate、App Store Connect provisioning profile、Apple Team ID を作成する。
2. `tauri ios build --export-method app-store-connect` で署名済み archive/IPA を人間承認のもとで作成する。
3. TestFlight upload と App Store submission は App Store Connect 上で確認してから行う。

### Android

1. Play Console の developer account と app record を作成する。
2. upload keystore を生成し、keystore と `keystore.properties` をリポジトリに置かない。
3. release AAB を upload key で署名し、Play internal testing へ手動 upload する。debug APK/AAB は Play 配布物ではない。

参考にする secret 名（値は本リポジトリへ保存しない）は、Apple 側が `IOS_CERTIFICATE`、`IOS_CERTIFICATE_PASSWORD`、`IOS_MOBILE_PROVISION`、`APPLE_DEVELOPMENT_TEAM`、Android 側が `ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_KEY_BASE64` である。実際の release workflow を作る際は、所有組織の secret policy と各 store の現行要件を再確認する。

## 更新・障害時

- v1 では Tauri updater を導入しない。更新は署名済み配布経路（macOS の手動配布、TestFlight/App Store、Google Play）で行う。
- logout、refresh 失効、credential rotation failure は native protected store の credential を削除し、次回起動時に再ログインする。アンインストール後のログイン維持は保証しない。
- Artifact build が壊れても Cloudflare Worker の deploy 状態には影響しない。Web/API の rollback は既存の Cloudflare 手順で、明示承認を得て別途行う。
