# SPEC_WORKFLOW — 仕様駆動開発（簡素版）

仕様が真実、コードは派生物。ただし**プロセスの重さは変更の重さに比例させる**。

## いつ spec が要るか

| 変更 | spec |
|---|---|
| 新機能 / 新エンドポイント / スキーマ変更 / 挙動が変わる変更 | **必須** — `specs/<service>/features/<NNN>-<slug>/spec.md` |
| バグ修正・文言・リファクタ・依存更新・テスト追加 | 不要 — ただし挙動が変わるなら既存 spec を更新 |
| 新サービス | `specs/README.md` の手順（`00_service-spec.md` から） |

## spec.md は 1 ファイル（WHAT → HOW → TASKS を 1 枚で）

テンプレ: [`.specify/templates/feature-template.md`](../../.specify/templates/feature-template.md)。セクション:

1. **WHAT/WHY** — 概要（3 行以内）/ ユーザーストーリー `US-<TAG>-NN` / 受け入れ基準 `AC-<TAG>-NN`（Given/When/Then）/ スコープ外。
2. **HOW** — 触るファイル / 契約（Zod スキーマ名）/ データモデル差分 / 却下した代替案（1 行ずつ）。
3. **TASKS** — チェックボックス列挙。**テストタスクを実装タスクより前に**。1 タスク ≤ 30 分目安。

feature spec の先頭には status を必ず 1 行で置く。初期値は Draft、人間が WHAT を承認した後に
Approved に変える。E2E traceability validator は Approved の `specs/**/spec.md` だけを対象にする。

```md
- ステータス: Draft
```

UC/AC を定義する場合は、本文中の参照と区別するため次の definition bullet だけを使う。同じ ID を
複数 spec に定義してはならない。Approved UC/AC は Playwright test 直前の `@e2e-covers` に一意に
対応付ける（[`E2E_TRACEABILITY.md`](../testing/E2E_TRACEABILITY.md)）。

```md
- UC-BOOKING-01: スタッフは予約を登録できる。
- AC-BOOKING-01: Given ... When ... Then ...
```

ルール:
- WHAT に HOW を混ぜない（受け入れ基準にライブラリ名・テーブル名を書かない）。
- 不明点は `[要確認: ...]` を書き、**解消するまで実装に進まない**（勝手に埋めない）。
- feature ディレクトリ名 = ブランチ名。PR に US-ID を明記。
- 受け入れ基準は**そのままテストになる粒度**で書く。

## フロー

```
spec.md（WHAT 承認）→（HOW/TASKS 追記）→ テスト先行で実装 → pnpm check 緑 → PR
```

人間の承認が要るのは: WHAT の確定 / アーキ変更 / ライブラリ追加 / 仕様外機能。
