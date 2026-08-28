# example_service エージェント指示

このファイルはルート `AGENTS.md` を継承し、このディレクトリで追加適用するサービス固有規約を定める。衝突時はルート規約を優先する。

## 役割

`example_service` は新しい業務ドメインサービスのコピー元であり、itemを題材に次の標準形を実証する。

- 1つのCloudflare WorkerがReact SPAとHono APIを同一オリジンで配信する。
- サービス専用D1がitemと同期済みorganizationを所有する。
- adminからorganizationをservice bindingで受信し、`ADMIN_TO_EXAMPLE_SERVICE_KEY` で認証する。notifierは `x-internal-caller=domain` + `DOMAIN_TO_NOTIFIER_KEY` でservice binding同期呼び出しする。
- Zod契約、Hono RPC、Drizzle、tenant scope、共有UI tokenの正しい組み合わせを示す。
- 既存Web SPAをTauri v2 desktop/iOS/Android shellからも使える。native APIはRust bridgeの固定origin/allowlist経由に限定する。

本番へこのサービス自体をdeployしない。新サービス作成時はリポジトリの `new-service` skillでコピーし、名前、binding、DB、契約、entity、テストを置換する。コピー先を本番へ出す前に、IdP/admin gateway と domain audience、`sid` revoke 照合を実装した `src/worker/production-auth.ts` と `test/production-auth.test.ts` を追加する。未実装の domain は `require-production-domain-auth.mjs` が fail close する。

## 構成と入口

| 場所 | 責務 |
|---|---|
| `src/worker/index.ts` | Hono route chain、認証、item API、organization同期、health |
| `src/worker/db/schema.ts` | item domainのDrizzle schema |
| `src/web/main.tsx` / `App.tsx` | SPA entryと代表画面 |
| `src/web/client.ts` | `hc<AppType>` typed client |
| `src/web/platform/transport.ts` / `auth/session.ts` | Web fetchとTauri IPCの切替、example dev session（nativeはmemory-only） |
| `src-tauri/` | Tauri v2 Rust shell、固定API origin、`api_request` command、platform config |
| `vite.tauri.config.ts` | Worker bundleと分離したnative static bundle |
| `migrations/` | D1 migration履歴 |
| `test/` | Workers integration、契約、権限、tenant isolation |
| `e2e/` | 実workerd + SPA smoke |
| `wrangler.jsonc` | D1、NOTIFIER binding、assets、dev vars以外の公開設定 |

## 非交渉の境界

- 全item queryはJWTの `org` を使って `organization_id` でscopeする。body、query、path由来のorganization IDを認可根拠にしない。
- 他tenantのitemは読めない、更新できない、存在も推測しにくい応答にする。変更時は複数tenant integration testを維持する。
- API契約は `packages/contracts/src/example_service.ts` のZodを単一ソースとする。routeはchainを切らず `AppType` を保つ。
- DB schema変更は `docs/database/DATABASE_RULE.md` に従い、Drizzle生成migrationを作る。FKは宣言しない。
- organizationはadminが源泉。このD1の行は同期コピーであり、このサービスから運営情報を独自変更しない。`synced_at` は受信 lease で、2時間を超えた行や不完全な旧行は `not_synced` (503) として fail closed にする。admin の reconcile は hourly で動かす。production API は `tenantAuth` の後に `requireLiveDomainSession` を置き、admin の refresh session / user / org を毎リクエスト照合する。org lease はこの live 認証の代替ではない。
- 通知は `@app/shared` のinternal helperからNOTIFIER bindingへ `x-internal-caller=domain` + `DOMAIN_TO_NOTIFIER_KEY` で同期送信する。通知失敗でdomain writeを巻き戻すかbest-effortにするかは既存仕様を確認し、握りつぶす経路はログと戻り値をテストする。
- CORSや別API originを追加しない。SPA/APIは同一Worker・同一originを維持する。
- Tauriのnative requestはRust `api_request` commandだけを使う。`/api/`、GET/POST/PATCH/DELETE、`authorization`/`content-type`以外を許可しない。外部origin、redirect、`set-cookie`をrendererへ渡さない。
- Tauri release originは`TAURI_EXAMPLE_API_ORIGIN`からbuild-timeに固定し、HTTPS以外を拒否する。secret、runtime設定画面、任意の`VITE_*` originは使わない。
- WebのsessionStorageは互換のため許可されたdev login fallbackだけで使う。Tauriではaccess tokenとorganization IDをmemory-onlyにし、再起動時の自動復元を実装しない。
- access JWT は RS256。admin が JWT_PRIVATE_KEY で署名し、この domain Worker は JWT_PUBLIC_KEY だけで検証する。AUTH_DEV_PRIVATE_KEY と AUTH_DEV_GRANT はローカル専用で、本番へ持ち込まない。
- Tauri の開発は `make dev/example_service/tauri`、static bundle は `make build/example_service/tauri`。通常 Web の `make dev/example_service` と同じ 5173 port を共有するため同時に起動しない。実機 HMR は `TAURI_DEV_HOST` と必要な port forwarding を使う。
- 色、font、radiusは `@app/ui` とtheme token経由だけを使う。

## コマンド

```sh
pnpm --filter @app/example_service dev
pnpm --filter @app/example_service build
pnpm --filter @app/example_service build:tauri
pnpm --filter @app/example_service tauri info
pnpm --filter @app/example_service tauri dev
pnpm --filter @app/example_service typecheck
pnpm --filter @app/example_service test       # Worker/integration coverage (各4指標 80%以上)
pnpm --filter @app/example_service test:web   # React/jsdom coverage (各4指標 60%以上)
pnpm --filter @app/example_service test:all   # 上記を順に両方実行
pnpm --filter @app/example_service exec vitest run --config vitest.web.config.ts -t "<test name>"
pnpm --filter @app/example_service e2e
pnpm --filter @app/example_service cf-typegen
pnpm --filter @app/example_service db:generate
pnpm --filter @app/example_service db:migrate:local
cargo test --manifest-path services/example_service/src-tauri/Cargo.toml
```

通常のローカル起動はルートで `make dev/example_service`。Tauri desktop は `make dev/example_service/tauri`、adminとのbinding連携も確認する場合は `make dev/all`。本番 deploy は行わず、fork 後の実サービスだけに protected main / production environment の deploy 設定を追加する。

## 必須テスト

- 新route: `permissions.test.ts` の全role/org/unauthenticated/default-deny表へ行を追加する。
- item query/write: `tenant-isolation.test.ts` で3 tenant、偽装入力、越境read/writeを検証する。
- Zod変更: `item.contract.test.ts` で境界値とunknown keyの扱いを固定する。
- Worker flow: `items.integration.test.ts` でD1結果、status、通知成功/失敗を検証する。
- 時刻を使う機能: `*.time.test.ts` を分け、実時刻でなく引数注入する。
- UI変更: `src/web/App.test.tsx`（workspace sign-in/out、loading、validation、create/error/401、表示とaccessibility）と `client.test.ts`（bearer/logout）を対象に応じて先に失敗させ、`test:web` と e2e を実行する。新しい production behavior は frontend も例外なく test-first。
- Tauri変更: `src/web/platform/transport.test.ts`、`src/web/auth/session.test.ts`、Rustの`origin.rs`/`api.rs` unit testでWeb fallback、native memory session、allowlist、cookie redactionを先に固定する。対応するdesktop/mobile CLI検証も行う。
- Approved UC/AC: `e2e/smoke.spec.ts` の `@e2e-covers` を各scenario直前に置き、`docs/testing/E2E_TRACEABILITY.md` の100%対応を維持する。

## コピー時の確認

1. package名、service名、port、Wrangler name、D1 binding/ID、migration targetを置換する。
2. item contract/schema/routes/UI/testsを新domain名へ置換する。
3. admin側のbindingとorganization sync先を人間承認済み設計に合わせる。
4. `packages/contracts/src/index.ts` と新サービスの `AppType` exportを接続する。
5. `pnpm -r cf-typegen`、migration、seed、`pnpm check`、対象e2eを通す。
6. Tauriを使う場合はidentifier、固定API origin、platform overlay、署名方針を人間承認してから設定する。
7. CODEMAP、deploy/infra文書、サービス固有AGENTSを新しい責務へ更新する。

## 文書と完了

binding、data ownership、entry、port、deploy方針、Tauri shellの責務が変われば `CODEMAP.md` と関連how-toを更新する。package scriptや検証方法を変えればこのファイルも同じ変更で更新する。

完了前に、対象テスト、`pnpm --filter @app/example_service typecheck`、必要なe2e、`pnpm run test:traceability`、最後にルート `pnpm check` をgreenにする。secret、deploy、pushはルートの承認規則に従う。
