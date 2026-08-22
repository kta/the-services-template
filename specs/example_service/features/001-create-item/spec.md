# 001-create-item: item の作成・一覧

- サービス: `example_service`
- ステータス: Approved

> SDD 成果物の見本（`.specify/templates/feature-template.md` 準拠の 1 ファイル spec）。実装は `services/example_service` / `packages/contracts/src/example_service.ts`。

## 1. WHAT / WHY

**概要**: ユーザーが item（タイトル＋本文）を作成し、自組織の item を一覧できる。Hono + D1 + JWT の縦貫通を実証する最小機能。

**ユーザーストーリー**:
- US-ITEM-01 (P1): As a member, I want to create an item, so that it is recorded for my organization.
- US-ITEM-02 (P1): As a member, I want to list my organization's items, so that I can review them.

**受け入れ基準**:
- AC-ITEM-01: Given 有効な JWT と入力(title), When `POST /api/items`, Then 201 で作成され永続する。
- AC-ITEM-02: Given JWT 無し, When `GET/POST /api/items`, Then 401。
- AC-ITEM-03: Given title 空 / 200 文字超, When `POST /api/items`, Then 400。
- AC-ITEM-04: Given 別組織の item, When `GET /api/items`, Then 返らない（テナント分離）。
- AC-ITEM-05: Given item 作成成功, When 作成直後, Then 通知ジョブが notifier へ同期送信される（送信失敗でも 201 = best-effort）。

**スコープ外**: 編集・削除、検索、本番認証（dev トークンのまま）。

**不明点**: なし

## 2. HOW

**触るファイル**:
- `packages/contracts/src/example_service.ts` — `CreateItem` / `Item`（Zod 単一ソース）
- `services/example_service/src/worker/index.ts` — Hono チェーンルート + JWT middleware
- `services/example_service/src/worker/db/schema.ts` — `items` テーブル + `index(organization_id, created_at)`
- `services/example_service/src/web/` — SPA（`hc<AppType>` クライアント + 台帳 UI）

**データモデル差分**: `items`: `id`(UUID v4・アプリ生成) / `organization_id` / `title` / `body` / `created_at`。FK なし。

**却下した代替案**: REST+OpenAPI（型が二重定義になる）/ Auth0（テンプレ最小は自前 JWT）/ raw SQL(型なし)。

## 3. TASKS

- [x] T-001: contracts に `CreateItem` / `Item`
- [x] T-002: Drizzle schema + マイグレーション生成・適用
- [x] T-003: **テスト先行** `test/items.integration.test.ts`（401 / 作成・一覧 / テナント分離 / 通知送信）
- [x] T-004: 実装 `/api/auth/token`（dev）+ `/api/items` GET/POST + JWT middleware（Green）
- [x] T-005: SPA（DESIGN_RULE パス 1: 題材=台帳 / paper+pine トークン / シグネチャ=二重罫マストヘッド）
- [x] T-006: `pnpm check` 緑 + e2e（サインイン→作成→一覧）
