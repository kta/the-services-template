# admin エージェント指示

このファイルはルート `AGENTS.md` を継承し、adminサービス固有の安全境界を追加する。認証・organization・service bindingに触れる変更は高リスクであり、ルートのSDD/TDDと人間承認を省略しない。

## 役割

adminは運営コンソールであり、次の唯一の源泉である。

- organization、plan、disabled状態
- user、role、invitation
- login、access token、refresh token rotation/revocation、rate limit
- domain serviceへのorganization同期とhourly reconciliation

React SPAとHono APIを1 Workerで配信し、admin専用D1を所有する。login lockout は D1 の原子的カウンタで管理する。`EXAMPLE_SERVICE` と `NOTIFIER` は外向きservice bindingであり、他domain DBを直接読まない。

## 構成と入口

| 場所 | 責務 |
|---|---|
| `src/worker/index.ts` | Hono routes、cookie境界、認可、organization/invitation API、Cron |
| `src/worker/auth/service.ts` | login、refresh rotation、invite acceptance、revoke |
| `src/worker/db/schema.ts` | auth/organization D1 schema |
| `src/worker/sync.ts` | domain serviceへのtyped upsert/list |
| `src/worker/reconcile.ts` | drift検知とbounded resync |
| `src/web/auth/` | access tokenのmemory保持、refresh cookie経由session |
| `src/web/routes/` | Login、Invite、Orgs |
| `test/` | auth時間境界、権限表、integration、reconciliation |
| `e2e/` | loginと運営操作のsmoke |
| `seed.mjs` | local/remote明示指定のseed |

## 認証・認可の非交渉ルール

- 認証contractの変更は `packages/contracts` と `packages/shared` を含む設計承認が必要。独自token/cookie形式を足さない。
- access tokenはresponse bodyからmemoryに保持し、refresh tokenはHttpOnly cookieに置く。localStorageへcredentialを保存しない。
- passwordはclient-side stretch後の値を受け、server側pepperを組み合わせる。平文passwordやpepperをDB・log・responseへ出さない。
- `JWT_PRIVATE_KEY`（adminだけが保持）、`JWT_PUBLIC_KEY`、`AUTH_PEPPER`、caller-specific な service-binding key は secret。wrangler vars や repository へ書かない。example_service には `JWT_PUBLIC_KEY`、`ADMIN_TO_EXAMPLE_SERVICE_KEY`、live-session introspection 用の `DOMAIN_TO_ADMIN_KEY` だけを渡す。`DOMAIN_TO_ADMIN_KEY` は admin と domain の両端に置くが、JWT_PRIVATE_KEY や admin → domain 鍵とは別値にする。`AUTH_DEV_PRIVATE_KEY` は local-only dev grant の補助鍵で、本番には置かない。
- 401は未認証・期限切れ、403は認証済み権限不足として区別する。
- roleだけでなく運営organizationかtenant organizationかを検証する。未知routeはdefault-deny。
- token期限、refresh rotation grace、invite期限、lockout windowは時刻注入し、ちょうど・±1秒をテストする。
- auth eventはsecurity audit trail。失敗経路でも必要なeventを落とさない。

## Organizationとbinding境界

- admin D1がorganizationのsource of truth。他serviceのD1へcross-D1 query/JOINしない。
- syncはHono RPCの `AppType` とservice bindingを使い、`x-internal-key` を付ける。notifier 呼び出しは `x-internal-caller=admin` と `ADMIN_TO_NOTIFIER_KEY` を使い、domain/ops 用鍵を再利用しない。
- create/updateの成功条件とdomain同期失敗時の応答・再検知を既存specに合わせる。best-effort失敗はlog、戻り値、再試行上限をテストする。domain側は受信時刻の2時間 lease が切れると fail closed するため、hourly reconcile の失敗を無音で放置しない。
- reconciliationは1runの上限、drift、partial failureを維持し、無制限fan-outを入れない。
- invitation通知が失敗した場合のlink fallbackを消さない。送信成功を偽装しない。

## コマンド

```sh
pnpm --filter @app/admin dev
pnpm --filter @app/admin build
pnpm --filter @app/admin typecheck
pnpm --filter @app/admin test       # Worker/integration coverage (各4指標 80%以上)
pnpm --filter @app/admin test:web   # React/jsdom coverage (各4指標 60%以上)
pnpm --filter @app/admin test:all   # 上記を順に両方実行
pnpm --filter @app/admin exec vitest run --config vitest.web.config.ts -t "<test name>"
pnpm --filter @app/admin e2e
pnpm --filter @app/admin cf-typegen
pnpm --filter @app/admin db:generate
pnpm --filter @app/admin db:migrate:local
pnpm --filter @app/admin db:seed:local
```

通常は `make dev/admin`。domain bindingも動かす場合は `make dev/all`。
admin の Tauri 開発は `pnpm --filter @app/admin tauri dev`、または
`make dev/admin/tauri`（target を追加した fork で利用）を使う。通常 Vite は
5174 を `strictPort` で固定し、実機 HMR は `TAURI_DEV_HOST` と必要な
port forwarding を使う。Tauri shell に Worker secret や `JWT_PRIVATE_KEY` を
持ち込まない。

## 必須テスト

- route変更: `permissions.test.ts` のadmin/staff、運営/tenant org、unauthenticated、expired、wrong-secret、unknown path表を更新する。
- auth変更: `auth.time.test.ts` で期限・grace・lockout・invite境界を固定時刻で検証する。
- organization/invitation flow: `admin.integration.test.ts` でD1、cookie、event、通知fallback、tenant境界を検証する。
- sync/reconcile: `reconcile.test.ts` でdrift、上限、partial failure、notification failureを検証する。
- UI変更: `App.test.tsx`（route）、`auth/{session,useSession}.test.tsx`（session）、`routes/{Login,Invite,Orgs}.test.tsx`（form/error/busy）、`components/{AppShell,Toaster,ui}.test.tsx`（accessibility/action）を対象に応じて先に失敗させ、`test:web` と e2e を実行する。新しい production behavior は frontend も例外なく test-first。
- schema変更: migrationを生成し、setupがlocal D1へ全migrationを適用できることを確認する。

## 文書と完了

認証フロー、cookie、secret、binding、deploy順、organization ownershipが変わればCODEMAPと該当するauth/deploy/infra文書を同時更新する。コマンドや責務が変わればこのファイルも更新する。

完了前に対象test、admin typecheck、必要なe2e、ルート `pnpm check` を通す。Approved UC/AC を追加・変更したら `@e2e-covers` mapping と `pnpm run test:traceability` を同じ変更で更新する。認証・通知・binding・architecture変更は承認済みspecとの一致をセルフレビューする。
