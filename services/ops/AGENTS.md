# ops エージェント指示

このファイルはルート `AGENTS.md` を継承し、ops固有のバックアップ・監視・Workflows境界を追加する。

## 役割と非目標

opsは画面を持たないCron + Cloudflare Workflows Workerであり、D1 export、R2世代保存、backup鮮度/容量、service health、organization sync driftの監視を担当する。domain dataの源泉ではなく、application requestを処理しない。BACKUPS R2、BACKUP_WF、ADMIN、NOTIFIER bindingを所有する。

## 構成と入口

| 場所 | 責務 |
|---|---|
| `src/index.ts` | Worker fetch/scheduled、BackupWorkflow、health/capacity/reconcile orchestration |
| `src/d1-export.ts` | Cloudflare API経由のD1 export取得 |
| `src/lib/backup.ts` | slot key、freshness、retention/prune plan、容量判定の純ロジック |
| `test/backup.time.test.ts` | JST slot・日/月/年・leap year・鮮度境界 |
| `test/backup.test.ts` | retention/prune/capacity pure logic |
| `test/d1-export.test.ts` | export HTTP orchestration |
| `test/ops.integration.test.ts` | R2、Workflow、bindings、notification failure |
| `wrangler.jsonc` | R2、Workflow、service bindings、UTC Cron、公開vars |

## 非交渉ルール

- backupは各D1を独立exportし、cross-D1 query/JOINをしない。
- R2 object key、slot key、retention planは決定的にする。同じslotの再実行で無制限に世代を増やさない。
- CronはUTCで記述し、JST上の意図をコメントとtime testに残す。
- 日跨ぎ、月/年跨ぎ、leap year、am/pm slot、freshness thresholdのちょうど・±1を固定 `now: Date` でテストする。`Date.now()` 依存を入れない。
- Workflows retry可能errorと `NonRetryableError` を区別する。永続失敗を無限retryしない。
- pruneは新しい正常backupを確認する前に回さない。容量警告のために復旧可能世代を過剰削除しない。
- `D1_EXPORT_API_TOKEN` と `INTERNAL_KEY` はsecret。`CF_ACCOUNT_ID` とDB IDは公開設定だがplaceholderと本番値の区別を保つ。
- ADMIN/NOTIFIERはservice bindingで呼び、公開internet URLやcross-domain DB accessへ置換しない。
- notification failureはbackup/monitoring結果と区別して記録し、alert送信失敗で本来のfailureを隠さない。
- Workflows、R2、Cronの追加・置換はarchitecture変更として承認を得る。

## コマンド

```sh
pnpm --filter @app/ops dev
pnpm --filter @app/ops build
pnpm --filter @app/ops typecheck
pnpm --filter @app/ops test
pnpm --filter @app/ops cf-typegen
```

opsはSPA、D1 migration、Playwright e2eを持たない。backup/restoreの本番操作をunit test代わりに実行しない。

## 必須テスト

- pure backup logic: retention数、sort、duplicate slot、capacity threshold、prune planを表駆動で検証する。
- time: JST am/pm、UTC変換、日/月/年、leap year、freshness境界を独立した `*.time.test.ts` で検証する。
- D1 export: token/header、polling、success、API error、timeout相当をmock fetchで検証する。
- integration: Workflow step、R2 put/list/delete、ADMIN/NOTIFIER partial failure、idempotency key、scheduled handlerを検証する。
- fallback: alert失敗を握りつぶす経路では元のstatus、log、戻り値、再検知可能性までassertする。
- binding/Cron変更: `wrangler types` を再生成し、UTCの意図とdeploy/infra文書を更新する。

## 文書と完了

backup対象、retention、R2 key、freshness/capacity閾値、Cron、binding、restore手順が変われば `docs/howto/restore.md`、free-tier limits、infra/deploy、CODEMAPを同時更新する。package commandが変わればこのファイルも更新する。

完了前にops test/typecheck/build、生成型、ルート `pnpm check` をgreenにする。本番backup、restore、deploy、Cloudflare APIへの実送信は必ず直前承認を得る。
