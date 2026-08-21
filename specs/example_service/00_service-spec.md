# サービス仕様: example_service

- パッケージ: `services/example_service` (`@app/example_service`) + `services/example_service (src/web)` (`@app/example_service`)
- 所有 D1: `example_service`
- ステータス: Approved（テンプレートの参照実装）

## 目的・責務
**コピー元の汎用サービス**。新しいドメインを作るときの雛形。汎用エンティティ `item`（title + body）の CRUD と、テナントスコープ・JWT 認証・非同期通知・cross-D1 同期の「形」を一通り示す。

## エンティティ（所有データ）
| エンティティ | 主な属性 | 備考 |
|---|---|---|
| `item` | id(UUID, アプリ生成) / organization_id / title / body / created_at | FK なし・テナントスコープ必須 |
| `organization`（同期コピー） | id / name / created_at | 源泉は admin。`/api/internal/organizations` で upsert |

## API 面（Hono RPC + Zod）
| メソッド/パス | 認証 | 概要 |
|---|---|---|
| `GET /api/health` | none | ヘルス |
| `POST /api/auth/token` | none(dev) | dev トークン発行（**本番は要置換**） |
| `GET /api/items` | JWT(org) | 自org の item 一覧 |
| `POST /api/items` | JWT(org) | item 作成 → notifier へ同期送信（best-effort） |
| `POST /api/internal/organizations` | internal-key | admin からの org 同期（idempotent upsert） |

契約: `packages/contracts/src/example_service.ts`（`Item` / `CreateItem`）。

## 非機能・横断
- 全 item クエリは `organization_id`（JWT の `org`）でスコープ。
- `POST /api/items` は通知ジョブを notifier の同期送信 API（service binding）へ best-effort POST（`services/notifier`）。
- 認証: 自前 JWT（HS256）。`/api/auth/token` は dev グラント＝本番前に実認証へ。

## features
- [`001-create-item`](./features/001-create-item/spec.md) — item の作成・一覧（実装済み）。
