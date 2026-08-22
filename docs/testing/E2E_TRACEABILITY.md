# E2E 要件トレーサビリティ

承認済み feature spec（`specs/**/spec.md`）にある全 `UC-*` / `AC-*` **定義**は、Playwright
scenario に**ちょうど 1 回**対応付ける。これは E2E の line coverage ではなく、仕様の
網羅性を検証する 100% gate である。

feature spec は先頭で `- ステータス: Draft` または `- ステータス: Approved` を必ず宣言する。
`Approved` の定義だけが mapping の分母になる。UC/AC は `- AC-<TAG>-01: ...` または
`- UC-<TAG>-01: ...` という definition bullet でのみ宣言し、同じ ID を複数 spec で定義しない。
本文中の ID 参照は validator の分母に含めない。

## 機械可読な対応付け

Playwright テストの直前に、次の 1 行コメントを置く。空行は許容するが、別の statement や
`test.describe` を挟んではならない。複数 ID は同じ行に半角空白で並べる。

```ts
// @e2e-covers AC-BOOKING-01 UC-BOOKING-02
test('staff creates a booking', async ({ page }) => {
  // observable browser/API assertions
})
```

`pnpm run test:traceability` は Approved の `spec.md` だけを読んで、次を失敗にする。

- E2E mapping がない UC/AC
- Approved spec にない ID
- 同じ ID の重複 mapping
- `@e2e-covers` の直後に Playwright `test(...)` がない mapping

`pnpm test`、`pnpm check`、pre-commit、pre-push、CI `verify` はこの validator を実行する。
Playwright 自体は重いため、UI/API の挙動を変えた担当者が対象サービスで実行し、CI では
`workflow_dispatch` の e2e job で実行する。

AC-ITEM-05 は `playwright.config.ts` が test-only の `notifier` Worker fixture を Wrangler
local mode で起動する。fixture は `POST /api/internal/send` に 418 と
`x-e2e-notifier-fixture: failure` を返し、scenario はその応答を先に検証してから UI による
item 作成（201）と一覧表示を検証する。production Worker にテスト専用 route/header は追加しない。

## 現在の基準線

Approved かつ UC/AC を持つ spec は item feature のみである。`admin` の service spec と
infrastructure-only の文書には UC/AC がないため、分母には入らない（機械的な免除ではなく、
そもそも product behavior を定義していない）。新しい production behavior は Approved spec
に UC/AC を付け、この表と E2E mapping を同じ変更で追加する。

| Spec ID | Playwright scenario |
|---|---|
| AC-ITEM-01 | `services/example_service/e2e/smoke.spec.ts` — sign in, add an entry, see it in the ledger |
| AC-ITEM-02 | `services/example_service/e2e/smoke.spec.ts` — item API rejects unauthenticated reads and writes |
| AC-ITEM-03 | `services/example_service/e2e/smoke.spec.ts` — item API rejects empty and overlong titles |
| AC-ITEM-04 | `services/example_service/e2e/smoke.spec.ts` — an organization cannot list an item created by another organization |
| AC-ITEM-05 | `services/example_service/e2e/smoke.spec.ts` — creation remains successful when the local notifier binding is unavailable |

validator 自体は `scripts/check-e2e-traceability.test.mjs` で unit test する。通常の実行は次の
とおり。

```sh
pnpm run test:traceability
pnpm --filter @app/example_service e2e
```
