# リストア runbook

D1 データベースを復旧する手順。**2 系統**あり、状況で使い分ける。復元は破壊的操作を含むため、**着手前に必ず現状を export** し、判断者を 1 名立てる。

> **原則**: 個人データを含む DB では、復元作業ログに行データや氏名・自由記述を残さない（相関は UUID のみ）。R2 バックアップは非公開バケット + 最小権限トークン（D1:Read のみ）で扱う。

## RPO / RTO（目安）

- **RPO（許容データ損失）**: 最大 ~12h（バックアップは 1 日 2 回 + Time Travel は直近 7 日の PITR）。
- **RTO（復旧目標時間）**: 単一 D1 の復元で ~1h（R2 世代 import）/ Time Travel 巻き戻しは数分。

## 系統 A: D1 Time Travel（直近の誤操作・短時間の巻き戻し）

Free プランで**過去 7 日**の任意時点へ PITR できる。設定不要。**破壊的**（対象 DB が指定時刻の状態に置き換わる）。

1. **現状を必ず退避**（復元をやり直せるように）:
   ```sh
   pnpm --filter @app/admin exec wrangler d1 export admin --remote --output=pre-restore-admin.sql
   ```
2. 巻き戻したい時刻を確認 → 復元:
   ```sh
   pnpm --filter @app/admin exec wrangler d1 time-travel info admin
   pnpm --filter @app/admin exec wrangler d1 time-travel restore admin --timestamp="<ISO8601>"
   ```

   > `d1 time-travel` に `--local/--remote` フラグは無い（常にリモート DB に作用する。
   > `--remote` を付けると `Unknown argument` で失敗する）。
3. 主要フロー（ログイン→一覧表示）で健全性を目視確認。

> 7 日より前 / 論理削除の巻き戻しは Time Travel では届かない → 系統 B。

## 系統 B: R2 世代からの import（主砦・長期・DB 破損時）

ops Worker が 1 日 2 回 D1 を REST export → 検証 → R2 バックアップバケットに 30 世代（~15 日）保存している。**新規 D1 に import して切り替える**（既存 DB を直接上書きしない）。

1. **最新世代を特定**: `latest.json` の `summaries[].key` に実オブジェクトキー
   （例 `admin/2026-07-12T17-00-12.sql` — ISO の `:` は `-` に置換・ミリ秒なし）が
   記録されている。**`--remote` 必須**（無指定だとローカル Miniflare ストレージを
   読んでしまい、本番のバックアップは見えない）:
   ```sh
   pnpm --filter @app/ops exec wrangler r2 object get app-backups/latest.json --file=latest.json --remote
   pnpm --filter @app/ops exec wrangler r2 object get "app-backups/<summaries[].key>" --file=restore-admin.sql --remote
   ```
2. **新規 D1 を作成**して import:
   ```sh
   pnpm --filter @app/admin exec wrangler d1 create admin-restore
   pnpm --filter @app/admin exec wrangler d1 execute admin-restore --remote --file=restore-admin.sql
   ```
3. **突合**（件数）: import 前後で主要テーブルの件数、org ごとの件数を照合（例 `SELECT organization_id, count(*) FROM users GROUP BY 1`）。
4. **切り替え**: `services/admin/wrangler.jsonc` の `d1_databases[0].database_id` を新 DB の id に差し替え → `pnpm --filter @app/admin run deploy`。ops の `ADMIN_DB_ID` も更新。
5. 旧 DB は一定期間保持後に破棄（誤切替のロールバック用）。

自ドメインサービスの D1 も同手順（対応する `*_DB_ID` を更新）。

## リストア訓練（受入条件・年 1 回）

- **本番運用開始前に 1 回**、ステージングで系統 B を通しで実施（新規 D1 に import → 突合 → 切替 → ロールバック）。
- 以後**年 1 回**、訓練 + R2 アクセス権（`D1_EXPORT_API_TOKEN` のスコープ）の棚卸しを実施。
- 訓練結果（所要時間・詰まった箇所）を本 runbook に追記して更新する。

## 関連

- バックアップ実装: `services/ops/`（`BackupWorkflow` / 鮮度・死活・容量 Cron）。
- 検証条件: ≥1,000 bytes（既定・per-target で引き上げ可）・`CREATE TABLE` 含有・sentinel テーブルの INSERT 存在（空 DB 検知）。不合格は R2 に置かず `ops.backup_failed` 通知。
- デプロイ / secrets: `docs/howto/deploy.md`。
