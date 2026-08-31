# エージェントへの頼み方（プロンプト実例集）

このテンプレートは `AGENTS.md` / `DESIGN_RULE` / SDD のハーネスが効くので、**プロンプトには「何を・誰のために・何ができれば成功か」だけ**を書けばよい。技術選定・型・デザイン規約はハーネス側が強制する。

共通のコツ:

- **技術指定（Hono / D1 / Drizzle…）は書かない**。`AGENTS.md` が決めている。書くと逆にブレる。
- **entity と操作を 1〜2 個に絞る**（このテンプレの item と同じ粒度）。多機能なら spec を分ける。
- 「**まず spec を書いて見せて**」と添えるとレビューポイントが明示される（書かなくても SDD が spec 先行を強制する）。
- **secret の値そのものをプロンプトに貼らない**。「生成して」または「実行時に聞いて」と書く（会話ログに残さない）。
- **「本番反映の前に確認を取って」**を一言入れると、deploy 直前で止まってくれる。

## ① 新サービスをゼロから作る

`new-service` スキルを明示するのが最短（Claude Code では `/new-service`、Codex では「new-service スキルを使って」と指定）:

```text
new-service スキルを使って booking サービスを作成してください。

美容室の予約管理サービスを作りたい。

- 誰が使う: 店舗スタッフ（1 店舗 = 1 organization）
- できること: 予約の登録（顧客名・日時・メニュー）と当日の予約一覧
- 成功条件: スタッフが 30 秒で予約を 1 件登録できる
- スコープ外: 顧客向け予約ページ、決済、リマインド通知

まず spec を書いて見せて。承認したら実装に進んで。
```

## ② 既存サービスに機能を足す

```text
example_service の item に「アーカイブ」を足したい。

- US: As a member, I want to archive an item, so that the ledger stays focused.
- アーカイブ済みは一覧に出ない。復元は今回スコープ外。
- 他組織の item はアーカイブできないこと（テナント分離のテストも足して）。
```

## ③ UI を作る・変える

```text
booking の予約一覧画面を作って。

- 題材: 店舗の「本日の台帳」— 時刻順、今どの予約が進行中かが一目で分かる
- トーンは落ち着いた業務ツール。派手な装飾は不要
- design-select スキルでデザイン候補を 2〜3 案見せて。選んだら実装して
```

ポイント: **見た目の指示は「題材」と「トーン」で伝える**（色名や具体レイアウトは書かない方が、`DESIGN_RULE.md` の 2 パス設計が良い案を出す）。`design-select` はデザイン候補を HTML モックとしてブラウザに出し、**クリックで選ぶ**とその案で実装が進む。

## ④ 曖昧なアイデアしかないとき

```text
「趣味の読書記録を友人と共有する」サービスを考えている。
まだ仕様が固まっていないので、このテンプレートの構成（1 サービス = 1 Worker、
organization = 読書グループ）に沿う形で、MVP の spec 案を 2〜3 提案して。
実装はまだしないで。
```

先に spec だけ出させて比較 → 選んでから ① のプロンプトで実装に進むのが失敗が少ない。

## ⑤ セットアップ・デプロイを任せる

`wrangler login` / `gh auth login` さえ済んでいれば、初期設定は丸ごと委任できる:

```text
このテンプレートを初デプロイしたい。wrangler login と gh auth login は済ませてある。
手順は docs/howto/cloudflare-setup.md と docs/howto/deploy.md に従って。

1. Terraform で D1/KV/R2 を作成（terraform.tfvars は私の account id で作って。
   id は wrangler whoami で分かるはず）
2. terraform output の id を各 wrangler.jsonc に反映
3. caller-specific な内部鍵（admin→domain、admin→notifier、domain→notifier、ops→notifier）と AUTH_PEPPER をそれぞれ openssl rand -hex 32 で生成し、JWT 用とバックアップ manifest 用に**別々の** RSA key pair を deploy.md の手順で作る。初回 Worker の secret は `PRODUCTION_*` environment secret として登録し、`.github/workflows/production-bootstrap.yml` を protected `main` から reviewer 承認付きで起動する（JWT_PRIVATE_KEY は admin のみ、JWT_PUBLIC_KEY は admin と各 domain、BACKUP_SIGNING_PRIVATE_KEY は ops のみ）。R2 の public-domain preflight も通す。既存 Worker のローテーションも protected production workflow から実行し、`scripts/put-production-secret.mjs` は検証専用とする。
4. PR を protected `main` へ merge し、verify 成功後に GitHub Actions が template では notifier → admin → ops、fork 後に domain を追加した構成では notifier → admin → copied domain → ops の順でリモート D1 マイグレーションとデプロイを行う（`example_service` と `example_tauri_service` は雛形なのでデプロイしない）。copied domain は `production-auth.ts` と対応テストで domain audience と `sid` revoke 照合を実装してから chain に追加する。ローカルの deploy CLI は起動しない
5. CI 用に gh secret set --env production で CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID と bootstrap 用 `PRODUCTION_*` を production environment へ登録
   （API トークンは私がダッシュボードで作るので、必要権限を教えて。値は聞いて）

各ステップで実行したコマンドと結果を報告して。本番反映の前には確認を取って。
```

## ⑥ 壊れたとき

```text
make dev/admin がエラーで起動しない。エラーメッセージは以下:

<ターミナルの出力をそのまま貼る>

原因を調べて直して。直したら pnpm check を緑にして、何が原因だったか
1〜2 行で説明して。
```

エラーは**要約せずそのまま貼る**のが一番速い。
