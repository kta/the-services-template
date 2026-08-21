# SDD Constitution — 不変原則

> 仕様が唯一の真実であり、コードはその派生物に過ぎない。

このテンプレートで開発するすべての作業（人間・AI 問わず）が従う最上位規範。AGENTS.md の「絶対ルール」はこの具体化。

## 第1条: Spec-First（仕様先行）
挙動が変わる変更はコードの前に仕様がある（`docs/spec-workflow/SPEC_WORKFLOW.md`）。軽微変更（バグ修正・文言・リファクタ）は免除 — プロセスの重さは変更の重さに比例させる。

## 第2条: Test-First（テスト先行）
実装の前にテストがある。受け入れ基準は実行可能なテストとして表現する。Red→Green→Refactor。

## 第3条: Single Source of Truth（単一ソース）
派生可能なものを二重定義しない。API 契約・ドメイン型 → Zod（`packages/contracts`）。DB スキーマ → Drizzle → マイグレーションは生成物。クライアント型 → Hono RPC `AppType`。**デザイン → `packages/ui/src/theme.css` のトークン**（生 hex・デフォルトパレット禁止）。

## 第4条: Explicit Ambiguity（曖昧さの明示）
不明点は黙って埋めない。`[要確認: ...]` を残し、解消されるまで実装に進まない。

## 第5条: Traceability（追跡可能性）
spec → PR を ID（US-/AC-/T-）で辿れること。PR には US-ID を明記。

## 第6条: Domain Isolation（ドメイン分離）
1 ドメイン = 1 Worker + 1 D1。cross-D1 JOIN 禁止、境界はアプリ層で明示的に同期/集約。テナント境界（`organization_id`）は全クエリで強制。

## 第7条: Human Consent（人間の承認）
アーキテクチャ変更・ライブラリ追加・仕様外機能は人間の承認が必要。AI が独断してよいのは変数名・フォーマット・等価な実装パターンの選択のみ。

## レビュー・ゲート
PR レビューでは本憲法 + AGENTS.md 絶対ルールを照合する。**1 つでも NO なら承認しない。**
