# テスト規約（TDD）

**実装より先にテストを書く。** Red → Green → Refactor。

## 3層
- **Unit**: 純ロジック / Zod 契約（`test/*.contract.test.ts` 等）。
- **Integration**: `@cloudflare/vitest-pool-workers` で workerd 上の**実 D1・実バインディング**に対して（`services/<name>/test/*.integration.test.ts`）。`SELF.fetch` で Worker を叩く。テナント分離（org A のデータが org B に見えない）を必ず 1 本入れる。
- **E2E**: Playwright（`services/<name>/e2e/`）。`vite preview` は**実 Worker を workerd で動かす**ため、同一オリジンの /api も生きている — シェル描画だけでなく主要フロー（サインイン→作成→一覧）まで検証する。

## vitest-pool-workers（重要）
- 設定は `vitest.config.ts`: `cloudflareTest({ wrangler: { configPath }, miniflare: { bindings } })`（Vite プラグイン形式。旧 `defineWorkersConfig` ではない）。
- `test.include` は `['test/**/*.test.ts']` に絞る（**e2e/ の Playwright spec を vitest に拾わせない**）。
- D1 マイグレーション: `readD1Migrations('./migrations')` をバインディングで注入 → `test/setup.ts` で `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`。
- 他 Worker への service binding はテストではスタブ: `miniflare.serviceBindings` に関数を渡し、`vi.spyOn(env.X, 'fetch')` で呼び出しを検証。
- **カバレッジは Istanbul**（Workers プールでは V8 不可）。`provider: 'istanbul'`、`coverage.thresholds` がゲート。
- 型: tsconfig の `types` に `@cloudflare/vitest-pool-workers/types`。テスト用 env 追加は `Cloudflare.Env` を augment（`test/env.d.ts`）。

## どこを手厚く書くか（テストの厚み）

「壊れても静かに壊れる」領域を厚く書く。次の 4 つは**境界値まで**必須。

### 1. 時刻・期限（`*.time.test.ts`）
- **実時刻に依存させない**。時刻は必ず注入する: `AuthConfig.now`（auth service）/ `signAccessToken(claims, secret, ttl, now)` / `isStale(iso, now)` のように引数で渡す。`Date.now()` 頼みのテストは環境と実行時刻で落ちるので書かない。
- 必ず「**ちょうど**」と「**±1 秒 / ±1ms**」の両方を書く: refresh の期限ちょうど（有効）と +1 秒（`expired_token`）、ローテーション猶予ちょうど（`rotation_race`）と +1 秒（`token_reuse` + 全 revoke）、招待 72h ちょうど（受諾可）と +1 秒（410）、鮮度閾値 13h ちょうど（fresh）と +1ms（stale）。
- JST 系は **UTC 15:00 の日跨ぎ**・月末/年末・うるう年（2/29）・負の日数を必ず含める（`packages/shared/test/dates.boundary.test.ts`）。
- Cron のスロットキー（12h の am/pm、日次）は**切り替わりの瞬間**（11:59:59.999Z / 12:00:00.000Z）を書く。二重通知・通知欠落はここでしか出ない。
- 実装例: `packages/shared/test/{dates.boundary,jwt.expiry}.test.ts` / `services/admin/test/auth.time.test.ts` / `services/ops/test/backup.time.test.ts` / `services/notifier/test/dedupe.time.test.ts`。

### 2. 権限（`permissions.test.ts`）
- **表駆動**で「アクター × エンドポイント」を全網羅する。アクターは最低: 未認証 / staff / テナント org の admin / 運営 org の admin / **期限切れトークン** / **別 secret 署名**。
- 期限切れは 401、権限不足は 403 と**取り違えない**ことを固定する（クライアントの再ログイン判定がこれに依存する）。
- **未知パス（`/api/not-a-route`）も表に入れる** — default-deny（`app.use('/api/*', except(...))`）が生きている証明になり、新ルートのゲート漏れを自動で検知できる。
- 内部 API（`/api/internal/*`）は「テナントの JWT では越えられない・鍵が要る」ことを必ず書く。
- 実装例: `services/admin/test/permissions.test.ts`。

### 3. テナント分離（`tenant-isolation.test.ts`）
- **3 テナント以上**を同時に動かし、他テナントのデータが見えない・書き換えられないことを確認する。
- **入力による偽装**（body に `organizationId` を混ぜる等）が効かないことを 1 本入れる。
- org の無効化 → 403 → 再同期 → 200 の**遷移**を書く（毎リクエスト判定である証明）。未同期は 503 で無効化 403 と区別する。

### 4. 失敗時フォールバック
- best-effort（通知・同期）が失敗を握りつぶす経路は、**握りつぶした事実**まで見る: 戻り値（`synced: false` / `emailed: false`）、代替経路（招待リンクの返却）、冪等キーを残さないこと。

## 完了の定義とゲートの所在
`pnpm check`（lint + Knip dependency audit + typecheck + combined test）を緑にする。combined
test は root `pnpm test` であり、通常 package の `test`、React service の Worker `test` と
jsdom `test:web` を `test:all` で各1回、さらに traceability validator を実行する。

| 対象 | コマンド | coverage |
|---|---|---|
| Worker / package unit・integration | `pnpm --filter <pkg> test` | lines / statements / functions / branches 各80%以上 |
| React web unit | `pnpm --filter <pkg> test:web` | lines / statements / functions / branches 各60%以上 |
| React service 両方 | `pnpm --filter <pkg> test:all` | 上記をこの順で実行 |
| 1本だけ | `pnpm --filter <pkg> exec vitest run -t "<name>"` | web は `--config vitest.web.config.ts` を追加 |
| Approved UC/AC mapping | `pnpm run test:traceability` | 100%・unknown/duplicate/未接続なし |
| Browser E2E | `pnpm --filter <pkg> e2e` | UI/API挙動を変えた service で必須 |

新しい production behavior は Worker/API、React、共有UIを問わず、先に期待した理由で失敗する
test を確認してから実装する。Approved spec の UC/AC を追加・変更した場合は、実際の
Playwright scenario の直前に `@e2e-covers` を置く。詳細と現行の対応表は
[`E2E_TRACEABILITY.md`](./E2E_TRACEABILITY.md) を参照する。

| タイミング | 実行内容 |
|---|---|
| pre-commit | 早期ローカルフィードバック: 変更ファイルの lint/format 自動修正 → **combined test**（落ちたらコミット不可） |
| pre-push | 早期ローカルフィードバック: Biome check + Knip dependency audit + typecheck + **combined test** |
| CI `verify` | 最終リモートゲート: agent compatibility + lint + dependency audit + typecheck + **combined test**（`deploy` の前提） |

`--no-verify` / `LEFTHOOK=0` は緊急時の一回限りとし、常用しない。e2e は UI 変更時にローカルで実行し、CI は手動トリガ（`workflow_dispatch`）のオンデマンド実行のみ — PR / main マージのゲートではない。

## テストデータの注意（vitest-pool-workers）
このテンプレートは **D1 / KV の状態がテストファイル内で共有される**（テストごとに巻き戻らない）。org id・email・通知 id は `crypto.randomUUID()` で**毎回ユニークに**作る。固定値を使い回すと「2 件目以降だけ 409」のような順序依存の失敗になる。
