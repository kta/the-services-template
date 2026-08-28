# リストア runbook

D1 データベースを復旧する手順。**2 系統**あり、状況で使い分ける。復元は破壊的操作を含むため、**着手前に必ず現状を export** し、判断者を 1 名立てる。

> **原則**: 個人データを含む DB では、復元作業ログに行データや氏名・自由記述を残さない（相関は UUID のみ）。R2 バックアップは非公開バケットで扱い、バックアップ生成用の D1 REST トークンと、復元 operator の R2/D1 操作用トークンを分離する。

## 実行境界

restore は本番データを書き換えるため、ローカル端末からは実行しない。このテンプレートの
`scripts/restore-d1.mjs` は、protected `main` の `workflow_dispatch` と `production`
environment の required reviewer を通過した production workflow 内から呼び出した場合だけ動く。
テンプレートには破壊的な restore workflow 自体を同梱していないため、導入先で入力値・承認者・
退避 artifact の保管先をレビューした ops workflow を追加してから利用する。以下のコマンド例は
その workflow の guarded step に渡す内容であり、ローカルでそのまま実行する手順ではない。

wrapper は reviewed な `wrangler.jsonc` から対象名・D1 ID・ops の Cloudflare account ID を読み、
clean な published `main` checkout、production config、明示された `CLOUDFLARE_ACCOUNT_ID`、
ops の全 `*_DB_ID` 配線と署名公開鍵の一致を確認する。さらに毎回 R2 の public/custom domain が
無効であることを preflight してから固定された Wrangler サブコマンドだけを起動する。restore では
remote Worker secret names を照会しないため、operator token に Workers Scripts の read 権限は要求
しない。`--config`、`--env`、`--name` などの上書き引数は受け付けない。

バックアップの deterministic slot に同じ key の不正な metadata/content が存在する場合、ops は安全のため自動削除・上書きをしない。`backup_generation_conflict` として backup failure 通知を送り、operator が provenance を確認してから明示的に隔離する。正常な再実行では既存世代の整合性を検証したうえで retention prune も再試行する。

破壊・機密データ取得の全 operation は、次の文字列をコマンドラインで明示する。

    --confirm RESTORE_PRODUCTION

SQL / JSON は owner-only の一時ディレクトリに置く。wrapper は repository や通常の `/tmp` 直下への出力、symlink、既存ファイルの上書き、group/other readable なファイルを拒否する。ログへ SQL や JSON の内容を出力しない。

### 権限の分離

- バックアップ生成: ops Worker の `D1_EXPORT_API_TOKEN`（対象 account の D1 REST export に必要な read-only scope）のみ。これは R2 の読み書き用 credential ではない。
- 復元 operator: `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を、対象 account の R2 Object Read/List/Write/Delete と、明示的に実行する D1 create/execute/time-travel に必要な最小 scope で用意する。Write は Time Travel 前の退避 artifact を保管するため、Delete は retention 後の operator cleanup のために必要である。account ID は reviewed な `services/ops/wrangler.jsonc` と完全一致させる。
- CI の build/deploy 用 token、Resend token、Worker secret の値を restore shell に流用しない。R2 の operator token と D1 export token は別 token・別棚卸しにする。
- `latest.json` の署名検証用に、review 済み `services/ops/wrangler.jsonc` の
  `vars.BACKUP_SIGNING_PUBLIC_KEY` と同じ公開鍵を `BACKUP_SIGNING_PUBLIC_KEY` 環境変数へ
  設定する。private signer、JWT key、internal key は restore operator に渡さない。

## RPO / RTO（目安）

- **RPO（許容データ損失）**: 最大 ~12h（バックアップは 1 日 2 回 + Time Travel は直近 7 日の PITR）。
- **RTO（復旧目標時間）**: 単一 D1 の復元で ~1h（R2 世代 import）/ Time Travel 巻き戻しは数分。

## 系統 A: D1 Time Travel（直近の誤操作・短時間の巻き戻し）

Free プランで**過去 7 日**の任意時点へ PITR できる。設定不要。**破壊的**（対象 DB が指定時刻の状態に置き換わる）。

1. 巻き戻したい時刻を確認 → 復元（wrapper が直前 export を自動実行し、復旧後まで
   owner-only artifact を保持）:
   ```sh
   node scripts/restore-d1.mjs time-travel-info --service admin
   node scripts/restore-d1.mjs time-travel-restore \
     --service admin \
     --timestamp "<ISO8601 UTC>" \
     --confirm RESTORE_PRODUCTION
   ```

   > wrapper が `d1 time-travel` をリモート operation として固定する。Time Travel の
   > CLI には `--local/--remote` を付けない。pre-restore export に失敗した場合は
   > destructive restore を起動しない。export 成功時は path と SHA-256 を表示して
   > artifact を残すため、復旧失敗時にも確認・退避できる。復旧後の健全性確認と
   > 必要なロールバック判断が終わってから、その owner-only directory を削除する。
2. 主要フロー（ログイン→一覧表示）で健全性を目視確認。

手動で別名の退避 artifact も残す場合は、`time-travel-restore` より先に
`export-before-restore --output <owner-only-dir>/pre-restore-admin.sql` を実行する。

> 7 日より前 / 論理削除の巻き戻しは Time Travel では届かない → 系統 B。

## 系統 B: R2 世代からの import（主砦・長期・DB 破損時）

ops Worker が 1 日 2 回 D1 を REST export → 検証 → R2 バックアップバケットに 30 世代（~15 日）保存している。**新規 D1 に import して切り替える**（既存 DB を直接上書きしない）。

以下は 1 つの同じシェルで実行する。別のシェルや時間をまたぐ場合は、owner-only の一時ディレクトリを作り直し、既存の `restore_dir` を再利用しない。

```sh
set -euo pipefail
umask 077
restore_dir="$(mktemp -d)"
chmod 700 "$restore_dir"
trap 'rm -rf -- "$restore_dir"' EXIT
```

1. **最新世代を取得して特定**: `latest.json` の `targets.admin.key` に実オブジェクトキー
   （例 `admin/2026-07-12T17-00-12.sql` — ISO の `:` は `-` に置換・ミリ秒なし）が
   記録されている。wrapper が R2 bucket を reviewed config から取得し、`--remote` を
   固定する。
   ```sh
   node scripts/restore-d1.mjs download-backup \
     --target admin \
     --key latest.json \
     --output "$restore_dir/latest.json" \
     --confirm RESTORE_PRODUCTION
   backup_key="$(jq -er '.targets.admin.key' "$restore_dir/latest.json")"
   backup_sha="$(jq -er '.targets.admin.sha256' "$restore_dir/latest.json")"
   node scripts/restore-d1.mjs download-backup \
     --target admin \
     --key "$backup_key" \
     --output "$restore_dir/restore-admin.sql" \
     --sha256 "$backup_sha" \
     --confirm RESTORE_PRODUCTION
   ```
   `BACKUP_SIGNING_PUBLIC_KEY` が未設定、または公開鍵と署名が一致しない場合は、manifest を
   provenance として採用せず停止する。`jq` の出力は wrapper が generation key として再検証する。不正な key、別 target、
   `..`、shell metacharacter を含む値は download 前に拒否する。世代の
    `sha256` も必須で、download 後に wrapper が owner-only SQL の digest を照合する。`latest.json` には target の account ID と D1 database ID も記録され、wrapper は復元対象の reviewed config と一致しない世代を拒否する。
2. **新規 D1 を作成**して import:
   ```sh
   node scripts/restore-d1.mjs create-restore-db \
     --service admin \
     --database admin-restore \
     --confirm RESTORE_PRODUCTION
   # 上の Wrangler 出力に表示された database_id(UUID) を、必ず目視で記録する。
   restore_database_id='<create-restore-db が返した reviewed UUID>'
   node scripts/restore-d1.mjs import-backup \
     --service admin \
     --database admin-restore \
     --database-id "$restore_database_id" \
     --file "$restore_dir/restore-admin.sql" \
     --manifest "$restore_dir/latest.json" \
     --target admin \
     --key "$backup_key" \
     --sha256 "$backup_sha" \
     --confirm RESTORE_PRODUCTION
   ```

   `import-backup` は `latest.json`、target、generation key、SHA-256 を必須の provenance
   として突合し、Cloudflare の D1 情報画面または wrapper の preflight で指定名が
   `--database-id` の UUID に解決されることも確認する。SHA-256 だけを手入力して任意の SQL
   を recovery DB に流す経路や、同名の別 D1 へ黙って import する経路はない。
3. **突合**（件数）: import 前後で主要テーブルの件数、org ごとの件数を照合（例 `SELECT organization_id, count(*) FROM users GROUP BY 1`）。
4. **切り替え**: 新 DB の id と ops の `ADMIN_DB_ID` を変更する PR を作成し、レビュー・CI・protected `main` への merge を完了する。変更が反映された push が verify を通ると、GitHub Actions の production environment が承認後に `admin`（必要なら `ops`）を deploy する。production guard は任意ブランチや workflow_dispatch からの deploy を拒否する。
5. 旧 DB は一定期間保持後に破棄（誤切替のロールバック用）。

自ドメインサービスの D1 も同手順で行う（例: `--service booking`、`--target booking`、
`booking-restore`）。先に copied domain の production config と reviewed database ID が通ることを
確認する。`example_service` scaffold のままの復旧や、`--service` で別 DB 名を直接指定する
省略経路は使用しない。対象サービスを増やす場合は、この wrapper の固定 allowlist とテストを
先に PR で更新する。

## リストア訓練（受入条件・年 1 回）

- **本番運用開始前に 1 回**、ステージングで系統 B を通しで実施（新規 D1 に import → 突合 → 切替 → ロールバック）。
- 以後**年 1 回**、訓練 + restore operator の R2/D1 アクセス権（`CLOUDFLARE_API_TOKEN` の
  restore 専用 scope）の棚卸しを実施する。R2 の Read/List だけでは Time Travel 前の退避
  保管を完了できないため、Write と Delete を含め、対象 bucket だけに限定されていることを
  確認する。`D1_EXPORT_API_TOKEN` は D1 export 専用であり、R2 restore 権限の確認対象ではない。
- 訓練結果（所要時間・詰まった箇所）を本 runbook に追記して更新する。

## 関連

- バックアップ実装: `services/ops/`（`BackupWorkflow` / 鮮度・死活・容量 Cron）。
- 復旧 wrapper: `scripts/restore-d1.mjs`（入力検証、published-main guard、SHA-256 照合、固定 remote command）。
- 検証条件: ≥1,000 bytes（既定・per-target で引き上げ可）・`CREATE TABLE` 含有・sentinel テーブルの INSERT 存在（空 DB 検知）。D1 export の Content-Length と実体ストリームの双方に 512 MiB 上限を適用し、超過・不一致・検証失敗は R2 に置かず `ops.backup_failed` 通知する。`latest.json` は ops 専用 RSA signer で署名し、production の freshness/restore は署名検証を必須とする。
- デプロイ / secrets: `docs/howto/deploy.md`。
