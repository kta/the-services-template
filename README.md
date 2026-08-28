# cloudflare-template

> A Cloudflare-only TypeScript monorepo starter that runs entirely on the free tier — one Worker per service serving a React SPA + Hono API on the same origin, D1 per domain, built-in auth + backups + monitoring, Terraform, SDD/TDD, and an AI-agent design harness.

**AI エージェント（Claude Code など）に業務 Web アプリを作らせるための土台**です。ログイン・データベース・メール通知・バックアップ・監視といった「毎回作るのが面倒で、間違えると事故になる部分」が最初から入っていて、**Cloudflare の無料枠だけで本番運用できます**。

あなたが用意するのは「何を作りたいか」だけ。技術選定・型・デザインのルールはリポジトリ側（[`AGENTS.md`](./AGENTS.md)）がエージェントに強制するので、**指示が雑でも出来上がるものは揃います**。

## 最初に読む 3 行

1. ローカルで動かすだけなら **Cloudflare のアカウントは要りません**（お金もかかりません）。
2. 公開したくなったら、Cloudflare にアカウントを作り、`docs/howto/cloudflare-setup.md` と `docs/howto/deploy.md` に従って protected `main` の GitHub Actions 経路を設定する（エージェントには手順確認を頼めます）。
3. 分からないことは、このリポジトリを開いたエージェントに聞けば答えます（ルールを全部読んでいます）。

## 何が最初から入っているか

| できること | 中身 |
|---|---|
| ログイン / ユーザー招待 / 組織（テナント）管理 | 管理コンソール `admin` に実装済み |
| 画面 + API を 1 つのサービスとして配信 | 1 サービス = 1 Worker（同一オリジン。CORS 設定が不要） |
| データの保存 | サービスごとに 1 つの D1（Cloudflare の SQLite） |
| メール通知 | `notifier` サービス（Resend 経由。KV + provider key で重複を抑制する best-effort 配信） |
| 毎日のバックアップと監視 | `ops` サービス（R2 に世代保存＋容量/鮮度/死活の異常をメール通知） |
| 見た目の一貫性 | デザイントークン単一ソース（`packages/ui`）+ 「AI っぽい見た目」を禁じるルール |
| 壊れていないかの自動確認 | `pnpm check`（lint + 未使用依存 + 型 + Worker/web coverage + E2E traceability）。CI でも走る |

技術スタックの詳細（Hono / Drizzle / Zod / Terraform など）は [`AGENTS.md`](./AGENTS.md) と [`docs/`](./docs/) にあります。**普段は読まなくて大丈夫です。**

## 1. 手元で動かす（10 分）

### 用意するもの

| ツール | 何のため | 入れ方 |
|---|---|---|
| [mise](https://mise.jdx.dev) | Node と pnpm のバージョンを自動で合わせる | 公式サイトの手順どおり（**必須**） |
| [gh](https://cli.github.com)（GitHub CLI） | あとでエージェントに GitHub 設定を任せるため | `brew install gh` → `gh auth login` |
| Claude Code などのエージェント | 開発の主役 | 公式手順どおり |

### 動かす

```sh
mise install    # Node 22 / pnpm 11 / Terraform 1.10.5 を入れる
make init       # 必要なものを全部そろえる（初回のみ・数分かかります）

make dev/admin  # → http://localhost:5174 が管理コンソール
```

ブラウザで `http://localhost:5174` を開き、**`admin@example.com` / `admin-dev-password-change-me`** でログインできれば成功です（この値はローカル専用の初期データで、公開版には使われません）。

ほかによく使うコマンド:

```sh
make dev/example_service   # → http://localhost:5173 サンプルの業務画面
make dev/example_service/tauri  # example_service Tauri desktop（Worker + native window）
make build/example_service/tauri # example_service Tauri 静的 bundle（dist/tauri）
make dev/admin/tauri       # admin Tauri desktop（Worker + native window）
make build/admin/tauri     # admin Tauri 静的 bundle（dist/tauri）
make dev/all               # admin と example_service を同時に起動
make dev/notifier          # notifier Worker のローカル送信 API
make db/generate           # Drizzle schema から migration を生成
make db/migrate/local      # local D1 に migration を適用
make db/seed/local         # local D1 に開発データを投入
make build                 # 全 package の build
make test                  # combined test + coverage + traceability
make typecheck             # 全 package の型チェック
make lint                  # Biome + native boundary check
make infra/check           # Terraform format + provider-independent validate
make check                 # 壊れていないか全部確認する（緑ならOK）
make help                  # コマンド一覧
```

example_service は Tauri v2 の native shell も雛形として含みます。`make dev/example_service/tauri`（または `pnpm --filter @app/example_service tauri dev`）が Worker/Vite dev server と native window をまとめて起動します。Web の `make dev/example_service` と Tauri は同じ :5173 を使うため同時に起動しません。iOS/Android 実機の HMR では `TAURI_DEV_HOST=<開発端末から到達できる host>` と必要な port forwarding を設定します。desktop / iOS / Android の前提と unsigned artifact の手順は [`docs/howto/tauri-example-service.md`](./docs/howto/tauri-example-service.md) を参照してください。

`make build/<service>/tauri` は Worker を deploy せず、Tauri 用の相対 asset bundle だけを `services/<service>/dist/tauri` に作ります。`make dev/<service>/tauri` は対応する Vite/Worker dev server と native window を起動します。Tauri の macOS/iOS/Android unsigned artifact は GitHub Actions の `workflow_dispatch` で検証できますが、本番 credential や署名鍵は渡しません。

本番 Worker deploy と remote migration は GitHub Actions の `production` environment で、protected `main` への push が verify を通った場合だけ実行します。ローカルの Make/package には本番 deploy・remote migration の entry point を公開していません。既存 Worker の secret 登録や restore／remote seed も protected `main` の production workflow と required reviewer を要求します。`scripts/put-production-secret.mjs` は validation-only です。初回 Worker 作成を伴う bootstrap は専用 workflow だけで行います。example_service は雛形なので本番 deploy しません。鍵の境界と初期設定は [`docs/howto/deploy.md`](./docs/howto/deploy.md) を参照してください。
初回 Worker 作成を伴う secret bootstrap は `.github/workflows/production-bootstrap.yml` の
`workflow_dispatch` 専用です。protected `main`、`production` environment の required
reviewer、コピー済み domain の入力検証、Worker ごとの secret allowlist を通し、domain
Worker へ JWT_PRIVATE_KEY が渡らないことを確認します。コピー済み domain はさらに
reviewed な `production-auth.ts` と対応テストがない限り fail close します。ローカルから `--bootstrap` を
実行する手順はありません。

ops のバックアップ R2 は非公開 bucket に固定し、`latest.json` は JWT と別の RSA pair で
署名します。R2 public-domain preflight、署名鍵、restore operator の権限分離は
[`docs/howto/deploy.md`](./docs/howto/deploy.md) と [`docs/howto/restore.md`](./docs/howto/restore.md)
を正とします。

### テストを実行する

`pnpm test` は全 package の Worker/unit test、React service の `test:web`、coverage gate、
Approved spec の UC/AC→Playwright 対応検証をまとめて実行します。`pnpm check` はこれに
lint・未使用依存・typecheck を加えた完了 gate です。

```sh
pnpm --filter @app/admin test          # admin Worker/unit test
pnpm --filter @app/admin test:web      # admin React/jsdom test（4指標とも 60% 以上）
pnpm --filter @app/admin test:all      # admin の Worker + web test
pnpm --filter @app/example_service test:all
pnpm --filter @app/admin exec vitest run --config vitest.web.config.ts -t "<test name>"
pnpm run test:traceability              # Approved UC/AC の E2E mapping を検証
pnpm --filter @app/example_service e2e  # UI/API を変えた service の Playwright
pnpm check                              # リポジトリ全体の完了 gate
```

backend Worker/unit coverage は lines / statements / functions / branches の各 80% 以上、
React web coverage は各 60% 以上です。新しい production behavior は frontend を含めて
先に失敗するテストを書き、Approved spec の UC/AC には実際の Playwright scenario を 1 本
対応付けます。詳細は [`docs/testing/TEST_RULE.md`](./docs/testing/TEST_RULE.md) と
[`docs/testing/E2E_TRACEABILITY.md`](./docs/testing/E2E_TRACEABILITY.md) を参照してください。

**うまくいかないときは、ターミナルの赤い文字をそのままエージェントに貼って「直して」と言えば直ります。**

## 2. Cloudflare につなぐ（公開する）

インターネットに公開するときだけ必要です。**人間にしかできないのは次の 3 つだけ**で、あとはエージェントに任せられます。

1. **Cloudflare のアカウントを作る** → https://dash.cloudflare.com/sign-up （**Free プランのままで全機能動きます**）
2. **ログインを許可する**（ブラウザが開きます）:
   ```sh
   pnpm --filter @app/admin exec wrangler login
   ```
   ※ Claude Code のセッション中なら、行頭に `!` を付けて `! pnpm --filter @app/admin exec wrangler login` と打てばその場で実行できます。
3. **API トークンを 1 枚発行する**（自動デプロイを使う場合のみ。ダッシュボードの My Profile → API Tokens → Create Token）。必要な権限はエージェントに聞けば教えてくれます。

そのうえで、エージェントに**このまま貼って**ください:

```text
このテンプレートを初めて Cloudflare にデプロイしたい。
wrangler login は済ませてある。手順は docs/howto/cloudflare-setup.md と
docs/howto/deploy.md に従って、順番に実行して。

- 必要なリソース（D1 / KV / R2）の作成と、id の設定ファイルへの反映
- secrets の生成と、値を表示しない `production` environment secret への登録
- 初回 Worker の作成・既存 Worker の更新は `production-bootstrap.yml` など protected production workflow で設定（`put-production-secret.mjs` は検証専用）
- protected `main` へ反映後の notifier / admin / copied domain / ops の CI デプロイ（example_service は雛形なのでデプロイしない）

各ステップで実行したコマンドと結果を報告して。本番に反映する前には必ず確認を取って。
```

Terraform、production environment、bootstrap、CI deploy、必要な DNS の設定が完了すると
`https://admin.<あなたのサブドメイン>.workers.dev` で管理コンソールが動きます。ローカルの
agent セッションから本番 Worker を直接 deploy する経路はありません。

自分で手を動かしたい場合の手順書 → [`docs/howto/cloudflare-setup.md`](./docs/howto/cloudflare-setup.md)。運用時のデプロイ手順 → [`docs/howto/deploy.md`](./docs/howto/deploy.md)。

> 💡 **お金の話**: このテンプレートは Cloudflare の無料枠で全部動くように作られています（有料プランが必要な機能は使っていません）。上限と、上限に近づいたときの対処は [`docs/howto/free-tier-limits.md`](./docs/howto/free-tier-limits.md)。

## 3. 作りたいものを頼む

技術用語は不要です。**誰が使うか・何ができれば成功か**を書けば、エージェントが仕様書 → テスト → 実装の順で進めます。

```text
/new-service booking

美容室の予約管理サービスを作りたい。

- 誰が使う: 店舗スタッフ（1 店舗 = 1 organization）
- できること: 予約の登録（顧客名・日時・メニュー）と当日の予約一覧
- 成功条件: スタッフが 30 秒で予約を 1 件登録できる
- スコープ外: 顧客向け予約ページ、決済、リマインド通知

まず仕様を書いて見せて。承認したら実装に進んで。
```

見た目を作らせるときは、色やレイアウトではなく**「題材」と「トーン」**を伝えるのがコツです:

```text
予約一覧画面を作って。題材は店舗の「本日の台帳」— 時刻順で、今どの予約が
進行中か一目で分かること。トーンは落ち着いた業務ツール。
/design-select で候補を 2〜3 案見せて。選んだら実装して。
```

もっと多くの例（機能追加・アイデアの相談・トラブル対応）→ [`docs/howto/prompting.md`](./docs/howto/prompting.md)

## 4. 自分のプロダクトにする（テンプレートを複製したとき）

GitHub の **Use this template** か `npx degit` で複製したら、エージェントに「このテンプレートを自分用に置き換えて」と頼めば以下をやってくれます:

- npm スコープ `@app` → 自分のスコープ
- D1 の `database_id` などの placeholder → 実際の値
- `packages/ui/src/theme.css` のデザイントークン → プロダクトに合った配色
- `LICENSE` の著作権者名

そのあと `make init` → `make check` が緑になれば準備完了です。

## 用語（迷ったとき）

| 言葉 | ざっくり |
|---|---|
| Worker | Cloudflare 上で動くアプリ本体。1 サービス = 1 Worker |
| D1 | Cloudflare のデータベース（SQLite） |
| KV / R2 | 一時データ置き場 / ファイル置き場（バックアップに使用） |
| service binding | Worker 同士がインターネットを経由せず直接呼び合う仕組み |
| secret | パスワードや API キー。**コードには絶対に書かず**、GitHub `production` environment secret から protected workflow の allowlist 経由で登録する |
| organization | テナント（会社・店舗などの単位）。データは必ずこの単位で分離される |
| spec | 実装前に書く仕様書。`specs/` 配下 |
| deploy | インターネットに公開すること |

## 構成

```
services/<name>/          1 サービス = 1 Worker（画面 + API + DB）+ サービス固有 AGENTS.md
packages/contracts        API の型の単一ソース（Zod）
packages/ui               デザイントークン + 共有パーツ
packages/shared           認証・日付・解析などの共通処理
docs/ specs/              ルールと仕様（AGENTS.md が入口）
infra/terraform           クラウド側リソースの定義
```

## もっと詳しく

- [`CODEMAP.md`](./CODEMAP.md) — リポジトリの構成・責務・主要フローの案内
- [`docs/README.md`](./docs/README.md) — **「何をしたいときにどれを読むか」の案内**（まずここ）
- [`AGENTS.md`](./AGENTS.md) — **エージェント向けの全ルール**（`CLAUDE.md` はこれへのシンボリックリンク）
- [`docs/howto/agent-development.md`](./docs/howto/agent-development.md) — 開発体制とワークフロー
- [`docs/howto/dependency-management.md`](./docs/howto/dependency-management.md) — 依存の更新・追加・削除とRenovate運用
- [`docs/frontend/DESIGN_RULE.md`](./docs/frontend/DESIGN_RULE.md) — デザインの決まり
- [`docs/howto/restore.md`](./docs/howto/restore.md) — バックアップからの復旧手順
- [`SECURITY.md`](./SECURITY.md) — 脆弱性の報告先

## License

[MIT](./LICENSE)
