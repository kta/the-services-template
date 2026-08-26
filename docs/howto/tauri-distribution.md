# Admin Tauri 配布準備

この文書は `services/admin` の Tauri v2 検証 artifact を作り、署名済み配布へ引き渡すための手順である。Tauri アプリは既存 Worker の Web/API と別の配布物であり、Cloudflare deploy はこの手順に含めない。

## 現在の境界

- identifier は pre-release 値 `com.kta.admin` を維持する。
- 初回の Apple App Store / Google Play 登録前に、所有組織の reverse-DNS identifier、production Worker origin、Apple Team ID、Play Console の app record を確定する。identifier を登録後に変更すると別アプリになるため、これらが初回 store submission の blocker である。
- store submission 前に、承認済みアプリアイコンから `tauri icon` を実行して desktop/mobile の全 asset set を生成し、Apple/Google の表示を確認する。現在の `icons/icon.png` は検証用 source であり、商用ブランド確定を意味しない。
- macOS artifact は Universal (`aarch64` + `x86_64`) の unsigned `.app`、iOS artifact は Apple Silicon simulator 用 debug product、Android artifact は debug signing の APK/AAB である。いずれも store 配布物ではない。
- CI は署名、notarization、TestFlight upload、Play upload、Cloudflare deploy を実行しない。証明書・keystore・store API token はこの workflow に追加しない。

## ローカルで確認するコマンド

Node 22、pnpm 11、Rust、Xcode、CocoaPods、XcodeGen、Android SDK/NDK を用意した環境で実行する。

```sh
# CLI と設定の確認
pnpm --filter @app/admin exec tauri --version
pnpm --filter @app/admin exec tauri ios --help
pnpm --filter @app/admin exec tauri android --help
pnpm --filter @app/admin exec tauri info

# 初回だけ。生成物は src-tauri/gen/ 以下で、リポジトリには含めない。
pnpm --filter @app/admin exec tauri ios init --ci --skip-targets-install
pnpm --filter @app/admin exec tauri android init --ci --skip-targets-install

# macOS 検証 bundle（production origin を使う場合だけ置換する）
TAURI_ADMIN_API_ORIGIN=https://admin.example.invalid \
  pnpm --filter @app/admin exec tauri build \
    --bundles app --target universal-apple-darwin --no-sign

# iOS simulator
pnpm --filter @app/admin exec tauri ios build --debug --target aarch64-sim --no-sign

# Android debug 検証（APK と AAB は CI で別 job）
pnpm --filter @app/admin exec tauri android build --debug --apk --target aarch64
pnpm --filter @app/admin exec tauri android build --debug --aab --target aarch64
```

`tauri ios/android init` は公式 Tauri CLI が Xcode/Android SDK を検査する。SDK がない端末では初期化自体が失敗するため、CI は platform SDK を用意してから毎回 init する。Android build は platform config の `beforeBuildCommand` から必ず `prepare:tauri:android` を実行する。これは Keystore provider の Android Context を Activity 起動前に初期化する bridge を生成物へ適用し、想定外の Activity 形式なら失敗するため、直接 `tauri android build` しても省略できない。`src-tauri/gen/` と `src-tauri/target/` は `.gitignore` 済みで、CLI の生成物や build cache をコミットしない。

アイコンを確定したら、次のコマンドで各 platform の asset set を更新する（実行結果の `gen/` は引き続きコミットしない）。

```sh
pnpm --filter @app/admin exec tauri icon src-tauri/icons/icon.png --ios-color '#fff'
```

## 手動 CI artifact

GitHub Actions の `Tauri native artifacts` を `workflow_dispatch` で起動する。ジョブは次の4つに分離され、各成果物は7日間保存される。

| job | artifact | 意味 |
| --- | --- | --- |
| `macos-universal` | `tauri-macos-universal` | unsigned Universal `Admin.app` |
| `ios-simulator` | `tauri-ios-simulator` | unsigned `aarch64-sim` build product |
| `android-debug-apk` | `tauri-android-debug-apk` | debug-signed APK |
| `android-debug-aab` | `tauri-android-debug-aab` | debug-signed AAB |

macOS job は repository variable `TAURI_ADMIN_API_ORIGIN` があればそれを compile-time origin として使い、未設定時は `https://admin.example.invalid` を使う。この fallback artifact は起動検証専用で、本番配布や実運用データへの接続に使わない。iOS/Android debug build は Rust 側の開発 origin 既定値を使うため、これも store submission 用ではない。

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
