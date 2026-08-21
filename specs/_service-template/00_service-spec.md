# サービス仕様: <service-name>

- パッケージ: `services/<service>` (`@app/<service>`)
- 所有 D1: `<service>`（1サービス=1 D1。cross-D1 JOIN 禁止）
- ステータス: Draft / Approved

## 目的・責務
このサービスが担うドメインと境界（何を所有し、何を所有しないか）。

## エンティティ（所有データ）
| エンティティ | 主な属性 | 備考 |
|---|---|---|
| `<entity>` | id(UUID, アプリ生成) / organization_id / ... | FK なし・アプリ層整合 |

他サービスのデータが必要な場合は **アプリ層で同期/集約**（service binding）。cross-D1 JOIN は禁止。どう取得するかを書く。

## API 面（Hono RPC + Zod）
| メソッド/パス | 認証 | 概要 |
|---|---|---|
| `GET /api/health` | none | ヘルス |
| `... /api/<resource>` | JWT(org) | テナントスコープ必須 |
| `POST /api/internal/*` | internal-key | 他 Worker からの同期用 |

契約は `packages/contracts/src/<service>.ts`（Zod 単一ソース）。

## 非機能・横断
- テナントスコープ（`organization_id`）を全クエリで強制。
- 通知は notifier への**同期送信**（service binding + KV 冪等）。Queue / DLQ は使わない（`docs/howto/notifications.md`）。
- 認証方式（自前 JWT / Auth0 / 未認証）を明記。

## features
`features/<NNN>-<slug>/` に機能単位の spec/plan/tasks（`.specify/templates/` から）。
