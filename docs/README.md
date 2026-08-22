# docs — 何をしたいときに、どれを読むか

**普段は読まなくて大丈夫です。** 困ったとき・特定の作業をするときだけ開いてください。エージェントに「〇〇したい」と言えば、必要な文書はエージェント側が勝手に読みます。

## 使う人別の入口

| あなたの状況 | 読むもの |
|---|---|
| はじめて触る / とりあえず動かしたい | [`../README.md`](../README.md) |
| エージェントへの頼み方を知りたい | [`howto/prompting.md`](./howto/prompting.md) |
| Cloudflare につないで公開したい | [`howto/cloudflare-setup.md`](./howto/cloudflare-setup.md) → [`howto/deploy.md`](./howto/deploy.md) |
| 料金が心配 / 上限に近づいた | [`howto/free-tier-limits.md`](./howto/free-tier-limits.md) |
| データが消えた・戻したい | [`howto/restore.md`](./howto/restore.md) |
| メールが届かない | [`howto/notifications.md`](./howto/notifications.md) |
| 開発ルール全体を知りたい（エージェント向け） | [`../AGENTS.md`](../AGENTS.md) |
| リポジトリの構成・責務・主要フローを知りたい | [`../CODEMAP.md`](../CODEMAP.md) |

## 目的別（開発するとき）

| 作業 | 文書 |
|---|---|
| 画面を作る・見た目を変える | [`frontend/DESIGN_RULE.md`](./frontend/DESIGN_RULE.md)（+ [`frontend/mockups/`](./frontend/mockups/README.md)） |
| 機能を追加する（仕様の書き方） | [`spec-workflow/SPEC_WORKFLOW.md`](./spec-workflow/SPEC_WORKFLOW.md) |
| API を足す | [`api/API_RULE.md`](./api/API_RULE.md) |
| データベースを変える | [`database/DATABASE_RULE.md`](./database/DATABASE_RULE.md) |
| テストを書く | [`testing/TEST_RULE.md`](./testing/TEST_RULE.md) |
| インフラ構成を知る | [`architecture/infra.md`](./architecture/infra.md) |
| 開発体制・ワークフロー | [`howto/agent-development.md`](./howto/agent-development.md) |
| 依存を追加・削除・更新する | [`howto/dependency-management.md`](./howto/dependency-management.md) |
| AI（LLM）を組み込む機能を作る | [`security/AI_GUARDRAILS_RULE.md`](./security/AI_GUARDRAILS_RULE.md) |
| 開発の大原則（なぜこのルールなのか） | [`constitution/SDD_CONSTITUTION.md`](./constitution/SDD_CONSTITUTION.md) |

## この文書たちの立ち位置

- **ルートと各サービスの `AGENTS.md` がそのscopeの正**（同階層の `CLAUDE.md` はそのシンボリックリンク）。ここの文書は AGENTS.md から必要なときだけ参照される詳細版です。
- 迷ったら **実物のコードと `pnpm check` の結果が正**。文書と実装が食い違っていたら、それはバグ報告に値します（エージェントに「この文書、実装と違う」と言えば直します）。
