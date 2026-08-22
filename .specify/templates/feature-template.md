# <NNN>-<slug>: <機能名>

<!-- 1 ファイルに WHAT → HOW → TASKS。WHAT を人間が承認してから HOW 以降を書く。 -->

- ステータス: Draft

## 1. WHAT / WHY

**概要**（3 行以内）:

**ユーザーストーリー**（UC/US ID を定義する場合は、この形式の bullet だけを使う）:
- US-<TAG>-01: <役割>として<目的>のために<機能>がほしい

**受け入れ基準**（Given/When/Then。そのままテストになる粒度で。UC/AC ID はこの形式の
bullet で定義し、本文での参照には使わない）:
- AC-<TAG>-01: Given ... When ... Then ...

**スコープ外**:
-

**不明点**: `[要確認: ...]`（無ければ「なし」。あるうちは実装に進まない）

## 2. HOW

**触るファイル**:
- `packages/contracts/src/<service>.ts` — <スキーマ名>
- `services/<service>/src/worker/...`
- `services/<service>/src/web/...`

**データモデル差分**（無ければ「なし」）:

**却下した代替案**（1 行ずつ）:

## 3. TASKS

<!-- テストタスクを実装タスクより前に。1 タスク ≤ 30 分目安。 -->
- [ ] T-001: <契約/unit テストを書く（Red）>
- [ ] T-002: <integration テストを書く（Red）>
- [ ] T-003: <実装（Green）>
- [ ] T-004: <UI（DESIGN_RULE のパス 1 計画をここに 3 行で）>
- [ ] T-005: `pnpm check` 緑 + spec の AC を全て満たすことを確認
