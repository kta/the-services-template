---
name: design-select
description: Use when creating a new screen or significantly changing a UI's look. Presents 2-3 design candidates as clickable HTML mockups in the user's browser (local preview server), lets the user pick one, then implements the winner per DESIGN_RULE.
---

# design-select — デザイン候補を HTML で提示して選ばせる

UI の新規作成・大幅変更では、**いきなり React を書かず、デザイン候補 2〜3 案を HTML モックとしてブラウザに出し、ユーザーにクリックで選ばせてから実装する**。サーバは superpowers の visual companion を vendored（`scripts/`、MIT — `scripts/LICENSE`）。サーバ運用の詳細は [`references/visual-companion.md`](./references/visual-companion.md)。

軽微な文言・スタイル修正には使わない（通常の DESIGN_RULE パス 1 テキスト提示で足りる）。

## 手順

1. **候補を計画する（コード禁止）** — `docs/frontend/DESIGN_RULE.md` パス 1（題材 → トークン計画 → シグネチャ要素 → 自己批評）を**候補ごと**に行い、2〜3 案作る。
   - 各案は**方向性ごと変える**（題材・レイアウト構造・タイポ軸で差別化）。色違いだけの 3 案は禁止。
   - 全案が NEVER 表（3 大 AI デフォルト面相など）を通過していること。generic な案は候補に入れない。

2. **サーバ起動**（リポジトリルートを `--project-dir` に。`--open` でブラウザが開く）:

   ```sh
   bash .agents/skills/design-select/scripts/start-server.sh \
     --project-dir "$(git rev-parse --show-toplevel)" --open
   ```

   `--project-dir` は**絶対パス必須**（相対パスだと起動に失敗する。`git rev-parse --show-toplevel` は絶対パスを返すのでそのまま使える）。返る JSON の `url`（`?key=` 付きの完全な URL）をユーザーに伝え、`screen_dir` / `state_dir` を控える。落ちていたら同じ `--project-dir` で再起動（同ポート再利用でタブは自動再接続）。

3. **候補 HTML を `screen_dir` に書く**（例: `design-candidates.html`。ファイル名は再利用禁止、イテレーションは `-v2`）:
   - **完全な HTML 文書**（`<!DOCTYPE html>` 開始）として書く。フレームで包まれず、デザインがそのまま見える。helper（クリック記録）は自動注入される。
   - 各候補は**実物大の 1 画面モック**として縦に並べ、候補のルート要素に `data-choice="a|b|c"` と `onclick="toggleSelect(this)"` を付ける。候補間に「案 A: <題材名> — クリックで選択」の帯を挟む。
   - トークンは案ごとに `<style>` 内の CSS カスタムプロパティで定義（= その案のトークン計画の具現）。書体は Google Fonts の `<link>` で代用してよい（実装時は fontsource で自己ホスト）。
   - コピーは実データ相当の文言（DESIGN_RULE §4）。Lorem ipsum・`{placeholder}` 禁止。

4. **ターンを終える** — URL を再掲し、「ブラウザで見て、良い案をクリック → ターミナルで一言ください（修正指示でも OK）」と依頼して待つ。

5. **選択を読む** — 次ターンで `$STATE_DIR/events`（JSONL、最後の `choice` が最終選択）とターミナル発言を突き合わせる。修正指示なら新ファイルで再提示。

6. **選ばれたモックを台帳化** — 勝った案の HTML を `docs/frontend/mockups/<画面名>/` にコピーしてコミット対象にし、却下された方向は `docs/frontend/mockups/README.md` に「禁止」として追記する（DESIGN_RULE §6 のモック台帳。`.superpowers/brainstorm/` は gitignore 済みなので、コピーしないと選択結果が残らない）。

7. **実装** — 選ばれた案のトークン計画を `packages/ui/src/theme.css` に反映し、DESIGN_RULE パス 2 で React 実装。**モックの inline CSS をコピペしない**（トークンクラス経由に翻訳する）。

8. **後始末** — `bash .agents/skills/design-select/scripts/stop-server.sh $SESSION_DIR`。
