# Dependency Modernization Design

## Goal

モノレポの直接依存とツールチェーンを最新の安定版へ更新し、不要依存を除去し、
今後も依存の陳腐化や未使用化を自動検出できる Cloudflare-only テンプレートにする。
同時に、各サービスへサービス固有のエージェント指示を追加する。

## Scope

- ルート、`packages/*`、`services/*` の全 `package.json`
- `pnpm-workspace.yaml` の catalog と build-script allowlist
- pnpm、TypeScript、Biome、commitlint、Lefthook、Renovate の設定
- React/Vite、Hono/Zod、Drizzle、Cloudflare、Vitest、Playwright の設定と互換修正
- 未使用依存を継続検知する依存監査
- 全サービスの `AGENTS.md` と `CLAUDE.md`
- lockfile、生成される Cloudflare 型、更新で必要になるソース・テスト修正

新しいアプリ機能、API契約、DBスキーマ、画面デザインは変更しない。

## Update Policy

1. npm registry が示す最新の安定版を基準に、メジャー版を含めて全直接依存を更新する。
2. 互換性問題は依存を古い版へ戻すのではなく、公式移行手順に沿ってコードと設定を直す。
3. pre-release版は採用しない。相互互換性のない最新安定版同士が存在する場合だけ、理由を記録して
   互換性のある最新安定版を選ぶ。
4. catalog を共有依存の単一バージョンソースとして維持する。
5. pnpm自体も最新安定版へ更新し、`packageManager` と `mise.toml` を一致させる。
6. 新規ライブラリは、継続的な品質ゲートに明確な価値があり、既存ツールで代替しにくい場合だけ追加する。

## Dependency Audit

`knip` をルートの開発依存へ追加し、workspace全体の次を検査する。

- 未使用の直接依存・開発依存
- package manifestにない暗黙依存
- 未使用exportと到達不能ファイル。ただし、公開契約、Worker entry、設定ファイル、生成物は
  明示的なentryまたはignoreとして扱う

ルートへ `deps:check` scriptを追加し、`pnpm check` の一部として実行する。設定は
Vite、Vitest、Playwright、Wrangler、Drizzle、Cloudflare Worker entryとworkspace packageの
実際の利用形態を表現する。ignoreは、なぜ解析対象外なのか説明できる生成物または外部entryに限定する。

監査結果に基づき、実行時に必要な依存、型検査・ビルド・テストで必要な開発依存、consumerが提供すべき
peer依存へ分類し直す。pnpmのhoistによる偶然の解決には依存しない。

## Major Migrations

### TypeScript 7

TypeScript 7の新しい既定値へ暗黙に依存せず、Cloudflare WorkersとブラウザSPAに必要な
`module`、`target`、`types`、`lib`、strictnessを共通・個別tsconfigで明示する。
TypeScript 6で非推奨化され7で削除されたoptionがないことを確認し、全workspaceの`tsc --noEmit`を通す。

### Zod 4 and Hono validator

契約schemaをZod 4へ移行する。削除・非推奨API、error customization、record、default、optionalの
挙動差を検索し、該当箇所は推奨APIへ書き換える。既存の契約テストとWorker integration testsで
parse結果とHTTP validationを保証する。

### Cloudflare and Vitest

Wrangler、Workers型、Vite plugin、Vitest poolを同時に更新する。公式の現行設定形式を使用し、
`wrangler types` で生成型を更新する。D1 migrations、service bindings、KV、R2、Workflows、scheduled
handlerの型と実行テストを維持する。

### Tooling

commitlint、Lefthook、Biome、pnpmのメジャー変更を公式設定に合わせる。Git hookの意味は変えず、
pre-commitはformatとunit tests、pre-pushはlint、typecheck、coverage-gated testsを引き続き実行する。

## Service Agent Instructions

次の各ディレクトリへ `AGENTS.md` を追加する。

- `services/example_service`: コピー元テンプレート、item domain、tenant isolation、SPA/API同一Worker
- `services/admin`: 認証・organizationの源泉、D1/KV、service binding同期、権限境界
- `services/notifier`: 同期通知、KV冪等性、fail-close、secretの扱い
- `services/ops`: backup、R2世代管理、Workflows、freshness/capacity/health monitoring

各文書はルート `AGENTS.md` を継承する前提で、サービス固有の責務、禁止事項、主要コマンド、
必須テストだけを書く。各 `CLAUDE.md` は同階層の `AGENTS.md` を指す相対シンボリックリンクとし、
指示の単一ソースを保つ。

## Verification

変更は次の順で検証する。

1. 更新前ベースラインの `pnpm check`
2. 更新・移行単位の対象typecheck/test
3. `pnpm deps:check`
4. `pnpm check`
5. `pnpm build`
6. `pnpm --filter @app/example_service e2e`
7. `pnpm --filter @app/admin e2e`
8. `pnpm outdated -r` とmanifest/lockfileの整合確認

更新により既存テストが不足する挙動差が生じた場合は、実装修正より先に回帰テストを追加して
Red→Greenを確認する。UIの見た目は変更しないため、デザイン選定は不要とする。

## Failure Handling

- 互換エラーは最小の再現コマンドへ絞り、公式release/migration documentationとインストール済み型を確認する。
- 更新後に直接依存の最新版が新たに公開されても、作業完了時点のregistry結果を証跡とする。
- e2eのブラウザ取得など環境要因で失敗した場合は、原因を切り分け、コード不具合と区別して記録する。
- secret、外部API送信、deployは行わない。pushとPR作成は全ローカル検証後に個別承認を得る。

## Authoritative References

- TypeScript 7 announcement: <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- TypeScript 6 migration context: <https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/>
- Zod 4 migration guide: <https://zod.dev/v4/changelog>
- Cloudflare Workers testing: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- pnpm workspace catalogs: <https://pnpm.io/catalogs>
- Knip monorepos: <https://knip.dev/features/monorepos-and-workspaces>
