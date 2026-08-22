# example_service エージェント指示

このファイルはルート `AGENTS.md` を継承し、このディレクトリで追加適用するサービス固有規約を定める。衝突時はルート規約を優先する。

## 役割

`example_service` は新しい業務ドメインサービスのコピー元であり、itemを題材に次の標準形を実証する。

- 1つのCloudflare WorkerがReact SPAとHono APIを同一オリジンで配信する。
- サービス専用D1がitemと同期済みorganizationを所有する。
- adminからorganizationをservice bindingで受信し、notifierをservice bindingで同期呼び出しする。
- Zod契約、Hono RPC、Drizzle、tenant scope、共有UI tokenの正しい組み合わせを示す。

本番へこのサービス自体をdeployしない。新サービス作成時はリポジトリの `new-service` skillでコピーし、名前、binding、DB、契約、entity、テストを置換する。

## 構成と入口

| 場所 | 責務 |
|---|---|
| `src/worker/index.ts` | Hono route chain、認証、item API、organization同期、health |
| `src/worker/db/schema.ts` | item domainのDrizzle schema |
| `src/web/main.tsx` / `App.tsx` | SPA entryと代表画面 |
| `src/web/client.ts` | `hc<AppType>` typed client |
| `migrations/` | D1 migration履歴 |
| `test/` | Workers integration、契約、権限、tenant isolation |
| `e2e/` | 実workerd + SPA smoke |
| `wrangler.jsonc` | D1、NOTIFIER binding、assets、dev vars以外の公開設定 |

## 非交渉の境界

- 全item queryはJWTの `org` を使って `organization_id` でscopeする。body、query、path由来のorganization IDを認可根拠にしない。
- 他tenantのitemは読めない、更新できない、存在も推測しにくい応答にする。変更時は複数tenant integration testを維持する。
- API契約は `packages/contracts/src/example_service.ts` のZodを単一ソースとする。routeはchainを切らず `AppType` を保つ。
- DB schema変更は `docs/database/DATABASE_RULE.md` に従い、Drizzle生成migrationを作る。FKは宣言しない。
- organizationはadminが源泉。このD1の行は同期コピーであり、このサービスから運営情報を独自変更しない。
- 通知は `@app/shared` のinternal helperからNOTIFIER bindingへ同期送信する。通知失敗でdomain writeを巻き戻すかbest-effortにするかは既存仕様を確認し、握りつぶす経路はログと戻り値をテストする。
- CORSや別API originを追加しない。SPA/APIは同一Worker・同一originを維持する。
- 色、font、radiusは `@app/ui` とtheme token経由だけを使う。

## コマンド

```sh
pnpm --filter @app/example_service dev
pnpm --filter @app/example_service build
pnpm --filter @app/example_service typecheck
pnpm --filter @app/example_service test       # Worker/integration coverage (各4指標 80%以上)
pnpm --filter @app/example_service test:web   # React/jsdom coverage (各4指標 60%以上)
pnpm --filter @app/example_service test:all   # 上記を順に両方実行
pnpm --filter @app/example_service exec vitest run --config vitest.web.config.ts -t "<test name>"
pnpm --filter @app/example_service e2e
pnpm --filter @app/example_service cf-typegen
pnpm --filter @app/example_service db:generate
pnpm --filter @app/example_service db:migrate:local
```

通常のローカル起動はルートで `make dev/example_service`。adminとのbinding連携も確認する場合は `make dev/all`。

## 必須テスト

- 新route: `permissions.test.ts` の全role/org/unauthenticated/default-deny表へ行を追加する。
- item query/write: `tenant-isolation.test.ts` で3 tenant、偽装入力、越境read/writeを検証する。
- Zod変更: `item.contract.test.ts` で境界値とunknown keyの扱いを固定する。
- Worker flow: `items.integration.test.ts` でD1結果、status、通知成功/失敗を検証する。
- 時刻を使う機能: `*.time.test.ts` を分け、実時刻でなく引数注入する。
- UI変更: `src/web/App.test.tsx`（workspace sign-in/out、loading、validation、create/error/401、表示とaccessibility）と `client.test.ts`（bearer/logout）を対象に応じて先に失敗させ、`test:web` と e2e を実行する。新しい production behavior は frontend も例外なく test-first。
- Approved UC/AC: `e2e/smoke.spec.ts` の `@e2e-covers` を各scenario直前に置き、`docs/testing/E2E_TRACEABILITY.md` の100%対応を維持する。

## コピー時の確認

1. package名、service名、port、Wrangler name、D1 binding/ID、migration targetを置換する。
2. item contract/schema/routes/UI/testsを新domain名へ置換する。
3. admin側のbindingとorganization sync先を人間承認済み設計に合わせる。
4. `packages/contracts/src/index.ts` と新サービスの `AppType` exportを接続する。
5. `pnpm -r cf-typegen`、migration、seed、`pnpm check`、対象e2eを通す。
6. CODEMAP、deploy/infra文書、サービス固有AGENTSを新しい責務へ更新する。

## 文書と完了

binding、data ownership、entry、port、deploy方針が変われば `CODEMAP.md` と関連how-toを更新する。package scriptや検証方法を変えればこのファイルも同じ変更で更新する。

完了前に、対象テスト、`pnpm --filter @app/example_service typecheck`、必要なe2e、`pnpm run test:traceability`、最後にルート `pnpm check` をgreenにする。secret、deploy、pushはルートの承認規則に従う。
