# Cloudflare 初期設定（手動手順）

**ローカルで動かすだけなら Cloudflare アカウントは不要**（`make dev/*`・test・e2e はすべてローカルの workerd で動く）。ここは「インターネットに公開する（＝デプロイする）」ときに一度だけ必要な作業。

エージェントに丸ごと任せるなら [`README.md`](../../README.md) の「Cloudflare につなぐ」のプロンプトを使う。この文書は**自分で手を動かす場合**と、**エージェントが参照する手順書**を兼ねる。人間にしかできないのは **① ブラウザでのアカウント作成 ② `wrangler login` の OAuth ③ API トークンの発行**の 3 つだけ。

デプロイ手順そのもの（順序・secrets の全量・本番前チェック）は [`deploy.md`](./deploy.md)。ここは「まだ何も無い状態」から deploy.md に入るまでの橋渡し。

## 1. アカウントと wrangler の認証

```sh
# アカウント作成: https://dash.cloudflare.com/sign-up （Free プランで全機能動く）
pnpm --filter @app/example_service exec wrangler login   # ブラウザで OAuth
pnpm --filter @app/example_service exec wrangler whoami  # Account ID を控える
```

wrangler は各サービスの devDependency なので**個別インストール不要**。

## 2. CI 用の API トークン（GitHub Actions で自動デプロイする場合）

ダッシュボード → My Profile → API Tokens → **Create Token**（ここだけ手作業）。

必要権限: `Workers Scripts:Edit` / `D1:Edit` / `Workers KV Storage:Edit` / `Workers R2 Storage:Edit` / `Account Settings:Read`（**Queues 権限は不要** — 使わない設計）。

GitHub Actions の secrets は `gh` で登録する:

```sh
gh secret set CLOUDFLARE_API_TOKEN     # 値はプロンプトで聞かれる（シェル履歴に残らない）
gh secret set CLOUDFLARE_ACCOUNT_ID --body "<wrangler whoami で出た Account ID>"
gh secret list                         # 登録確認
```

`--body` に直接値を書くのは Account ID のような非機密のみ。トークンは引数に書かずプロンプト入力（またはパイプ `pbpaste | gh secret set ...`）にする。

## 3. リソースを作る — Terraform か wrangler 単体か

**Terraform**（D1 / KV / R2 をまとめて作成。推奨。state 用 R2 バケットが先に必要 → [`../architecture/infra.md`](../architecture/infra.md)）:

```sh
cd infra/terraform/cloudflare
export CLOUDFLARE_API_TOKEN=<上で作ったトークン>
cp terraform.tfvars.example terraform.tfvars   # account_id を記入
terraform init && terraform apply
terraform output   # 出てきた id を次のステップで貼る
```

**wrangler 単体**（試しに 1 サービスだけデプロイしたいとき）:

```sh
pnpm --filter @app/example_service exec wrangler d1 create example_service
# → 出力の database_id を控える（admin も同様）
# KV / R2 は wrangler kv namespace create / wrangler r2 bucket create
```

## 4. id を wrangler.jsonc に貼る

`services/<name>/wrangler.jsonc` の placeholder を実値に:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "example_service",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  // ← terraform output / d1 create の値
}]
```

貼り替えが必要な箇所:

| サービス | 項目 |
|---|---|
| admin | `d1_databases[0].database_id` / KV `AUTH_RL` の `id` |
| example_service（＝フォーク後の自ドメインサービス） | `d1_databases[0].database_id` |
| notifier | KV `DEDUPE` の `id` |
| ops | `vars.CF_ACCOUNT_ID` / バックアップ対象の `*_DB_ID`（R2 バケットは TF が作成） |

貼り替え後は `pnpm -r cf-typegen`。

## 5. secrets → マイグレーション → デプロイ

```sh
openssl rand -hex 32   # 高エントロピー値の生成例
echo -n "<値>" | pnpm --filter @app/admin exec wrangler secret put INTERNAL_KEY
echo -n "<値>" | pnpm --filter @app/admin exec wrangler secret put JWT_SECRET
echo -n "<値>" | pnpm --filter @app/admin exec wrangler secret put AUTH_PEPPER

pnpm --filter @app/notifier run deploy
pnpm --filter @app/admin run db:migrate:remote && pnpm --filter @app/admin run deploy
# → https://admin.<your-subdomain>.workers.dev で管理コンソールが動く
```

**どのサービスにどの secret が要るか・binding 依存のデプロイ順・本番前チェックリストは [`deploy.md`](./deploy.md) が正**（上は最小の抜粋）。特に:

- `INTERNAL_KEY` は service binding でつながる**全サービスで同一値**、`JWT_SECRET` は発行側(admin)と検証側(各ドメインサービス)で同一値、`AUTH_PEPPER` は **admin のみ**。
- `AUTH_DEV_GRANT` は**本番に設定しない**（未設定 = dev グラント無効）。
- notifier は `RESEND_API_KEY` 未設定かつ `MAIL_DEV_LOG` 未設定なら**送信が fail close（502）**。`MAIL_FROM` は Resend 検証済みドメインのアドレスに。
- example_service は雛形なので本番にデプロイしない（CI の deploy matrix 対象外）。

## 6. 費用の話

このテンプレートは **Workers Free プランの範囲内**で全機能（Workers / D1 / KV / R2 / Cron / Workflows）が動くよう設計してある。Queues など Paid 限定の機能は使っていない。上限に近づいたときの挙動と設計対処は [`free-tier-limits.md`](./free-tier-limits.md)。

R2 は無料枠でもクレジットカード登録を求められる場合がある（バックアップを使わないなら ops をデプロイしなければよい）。
