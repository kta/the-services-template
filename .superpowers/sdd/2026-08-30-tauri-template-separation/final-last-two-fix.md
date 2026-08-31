# Tauri 雛形分離 最終 2 finding 修正

## 結論

`final-spec-rereview.md` と `final-security-rereview.md` に残った 2 件を修正した。

- `prepare-dev-vars`: 検証済みの既存 local RSA pair を、追加された Web / Tauri service の空 key field だけへ再利用する。
- `restore-d1`: 全 operation の service / target を validated catalog の `deployable: true` SPA と reviewed ops backup target の積集合へ制限する。

architecture、依存、production credential、外部 resource は変更していない。production deploy / push / 外部 API write も実行していない。

## Finding 1: incremental dev-vars

### 原因

旧実装は admin と全 domain の key field を 1 個の boolean 配列へ平坦化し、1 field でも空なら catalog 全体を partial pair と判定した。このため、既存 service が同一 pair を完全設定済みで、新規 service の 2 field だけが空という正しい incremental 状態も拒否した。

### 修正

`scripts/prepare-dev-vars.mjs` は key 状態を service 単位で分類する。

- admin は 3 field がすべて空、またはすべて設定済みでなければ拒否する。
- domain は 2 field が両方空、または両方設定済みでなければ拒否する。
- 設定済み admin private/public/dev-private と、設定済み全 domain private/public を SPKI で比較する。
- malformed、service 内 mismatch、別の正しい RSA pair の混在を、書き込み前に拒否する。
- 検証に成功した場合だけ、両 field が空の domain に admin の exact public/private value を設定する。
- 既存 key field とその他の `.dev.vars` value は変更しない。
- 従来の regular-file、symlink、containment、`O_NOFOLLOW` / `O_EXCL`、0600 を維持する。

`scripts/prepare-dev-vars.test.mjs` に以下を追加した。

- 初期化後に Web service を catalog へ追加し、`.dev.vars` が欠落した状態から補完する fixture。
- 初期化後に Tauri service を catalog へ追加し、空の `.dev.vars` から補完する fixture。
- 既存全 service の file content が byte-for-byte 不変で、新規 service だけが同一 pair と 0600 を得ること。
- domain 内の片側だけの設定と、複数の有効 RSA pair 混在を拒否すること。

## Finding 2: restore catalog authorization

### 原因

旧 `runRestoreCli()` / `runRestorePreflight()` は service 名の文字種と `wrangler.jsonc` の D1 UUID だけを信頼し、validated `service-catalog.json` の `deployable` / SPA classification を認可に使用しなかった。このため non-deployable template や未登録 service に実 UUID が入ると、credential-bearing preflight と Wrangler command へ到達できた。

### 修正

`scripts/restore-d1.mjs` に共通の pure selector `authorizeRestoreSelection()` を追加し、全 6 operation と `validateRestoreTarget()` を同じ catalog policy へ接続した。

- credentialless `require-production-provisioning` checkout guard は引き続き最初に実行する。
- guard 成功直後に `loadServiceRepositoryCatalog()` を実行する。
- `time-travel-info`、`time-travel-restore`、`export-before-restore`、`create-restore-db`、`import-backup` の service は `deployable: true` SPA を要求する。
- `download-backup` の executor は catalog deployable `ops`、target は `deployable: true` SPA を要求する。
- worker-only `ops` / `notifier` は D1 restore target として拒否する。
- ops の全 backup target も同じ catalog policy で検査し、選択 target が reviewed `*_DB_ID` target 集合に含まれることを要求する。
- catalog authorization 後にだけ ops / target config を読み、全 reviewed UUID binding を照合する。
- その後にだけ credential-bearing config / R2 preflight と固定 Wrangler command を許可する。

`scripts/restore-d1.test.mjs` は pure selector と実 CLI の双方を表駆動で検証する。

- 全 6 operation × `example_service` / `example_tauri_service` / `unknown_service` / `notifier` / `ops`。
- injected config は reviewed UUID 形式の実値を持つが、非認可 target では一度も読まれない。
- event 順は checkout guard → validated catalog だけで停止する。
- production config / R2 preflight、Wrangler、output file 作成へ到達しない。

## TDD 証跡

### Red

- `node --test scripts/prepare-dev-vars.test.mjs`
  - incremental Web / Tauri の 2 fixture が、旧 catalog-wide partial 判定で期待どおり失敗した。
- `node --test scripts/restore-d1.test.mjs`
  - pure target test と全 CLI table が失敗し、`pass 13 / fail 32`。旧実装が catalog loader を呼ばず Wrangler まで到達することを確認した。

### Green / focused

- `node --test scripts/prepare-dev-vars.test.mjs scripts/restore-d1.test.mjs scripts/service-catalog.test.mjs`
  - `73 / 73` pass。
- `pnpm run test:deploy-boundary`
  - `197 / 197` pass、`production deploy boundary: ok`。
- `pnpm run test:boundary`
  - `187 / 187` pass、`private key boundary: ok`。

## 全体検証

- `mise exec -- pnpm check`: exit 0。
  - Biome、Knip、Terraform 1.10.5 init/validate、全 typecheck、combined coverage、E2E traceability が pass。
  - 最初の plain `pnpm check` は system Terraform 1.9.0 が repo 制約 `>= 1.10` を満たさず停止した。コード変更は行わず、`mise.toml` の pin 1.10.5 経由で全 command を再実行した。
- `mise exec -- pnpm --filter @app/example_service e2e`: `5 / 5` pass。
- `mise exec -- pnpm --filter @app/example_tauri_service e2e`: 単独 fresh run で `5 / 5` pass。
  - 2 suite を並行起動した試行だけは共有 notifier fixture が競合し、Tauri 側の fixture control が 401 / call count 0 になった。単独再実行では notifier 418 fixture を確認して全 pass したため、実装変更は不要と判断した。
- `/Users/spmac/.cargo/bin/cargo fmt --check --manifest-path services/example_tauri_service/src-tauri/Cargo.toml`: exit 0。
- `/Users/spmac/.cargo/bin/cargo test --locked --manifest-path services/example_tauri_service/src-tauri/Cargo.toml`: `19 / 19` pass。
- `/Users/spmac/.cargo/bin/cargo clippy --all-targets --manifest-path services/example_tauri_service/src-tauri/Cargo.toml -- -D warnings`: exit 0。
- `mise exec -- /Users/spmac/.cargo/bin/rustup run 1.88.0 make build/admin/tauri`: exit 0、artifact secret scan pass。
- `mise exec -- /Users/spmac/.cargo/bin/rustup run 1.88.0 make build/example_tauri_service/tauri`: exit 0、artifact secret scan pass。
- `node scripts/check-key-boundary.mjs`: `private key boundary: ok`。
- `mise exec -- pnpm exec lefthook run pre-commit`: staged 差分に対して exit 0。lint-format は無修正、combined test は全 pass。
- `mise exec -- pnpm exec lefthook run pre-push`: exit 0。lint-format、dependency-audit、typecheck、combined test は全 pass。

## 変更ファイル

- `scripts/prepare-dev-vars.mjs`
- `scripts/prepare-dev-vars.test.mjs`
- `scripts/restore-d1.mjs`
- `scripts/restore-d1.test.mjs`
- `.superpowers/sdd/2026-08-30-tauri-template-separation/final-last-two-fix.md`

## 残存制限

今回の 2 finding に対する既知の未解消事項はない。既存の production domain auth readiness false と最大 1 deployable domain の fail-close 制限は、承認済み issuer/gateway・positive live-session fixture・multi-domain key bundle がないため意図どおり維持した。
