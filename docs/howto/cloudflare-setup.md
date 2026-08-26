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

## 2. CI 用の API トークンを発行する

GitHub Actions で `main` から本番（`prd`）へ自動デプロイする場合だけ必要である。ブラウザで [API Tokens](https://dash.cloudflare.com/profile/api-tokens) を開き、次の順で作成する。

1. **Create Token** → **Edit Cloudflare Workers** を選ぶ。このテンプレートには Worker の CI/CD に必要な標準権限が入るため、空の Custom Token から作らない。
2. 名前は `github-actions-prd-deploy` のように用途が分かるものにする。
3. テンプレートの既存権限を残したまま、次の 2 つを追加する。

| Resource group | Permission | このテンプレートで必要な理由 |
|---|---|---|
| Account | `D1:Edit` | Terraform による D1 作成と、CI でのリモート migration |
| Account | `Account Rulesets:Read` | Wrangler が配信対象アカウントの ruleset 情報を照会するため |

最終的な権限セットは次のとおり。Cloudflare の画面によって `Edit` が `Write` と表示されることがあるが、同じ書込み権限を指す。

| Resource group | Permission | 用途 |
|---|---|---|
| Account | `Account Settings:Read` | Worker 配信時のアカウント情報照会 |
| Account | `Account Rulesets:Read` | 配信前の ruleset 情報照会 |
| Account | `D1:Edit` | D1 の作成・更新と migration |
| Account | `Workers KV Storage:Edit` | Terraform による KV namespace 作成・更新 |
| Account | `Workers R2 Storage:Edit` | R2 バケットと lifecycle の作成・更新 |
| Account | `Workers Scripts:Edit` | Worker 本体、static assets、Worker secrets の配信 |
| Zone | `Workers Routes:Edit` | カスタムドメインを Worker route で接続するときだけ必要（Worker template が付与） |
| User | `User Details:Read` / `Memberships:Read` | user token を使う Wrangler CI/CD の標準照会（Worker template が付与） |

4. **Account Resources** は、初回設定では **All accounts** を選ぶ。複数アカウントを運用する場合は、動作確認後にデプロイ先の 1 アカウントだけへ絞る。カスタムドメインを使う場合は **Zone Resources** も対象ゾーンに限定する。
5. **Continue to summary** → 内容を確認 → **Create Token**。表示されたトークンを直ちにコピーする。

トークンの値は発行時に一度しか表示されない。コード、`wrangler.jsonc`、Terraform の state、シェルスクリプトには保存しない。Queues、Workers Analytics、Billing、DNS の権限は、このテンプレートの標準デプロイには不要である。

## 3. GitHub の `prd` Environment に登録する

GitHub リポジトリの **Settings** → **Environments** → **New environment** で `prd` を作成する。必要ならデプロイ前の承認者もこの Environment に設定する。

次に **`prd` Environment の Secrets** として、以下を登録する。

| Secret | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 手順 2 で発行した API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler whoami` で確認した Account ID |

### ターミナルから登録する（推奨）

GitHub CLI でログイン済みであることを確認してから、トークンは対話入力で登録する。トークンをコマンド引数や履歴に残さない。

```sh
gh auth status
gh secret set --repo "OWNER/REPO" --env prd CLOUDFLARE_API_TOKEN
# プロンプトに API トークンを貼り付けて Enter
gh secret set --repo "OWNER/REPO" --env prd CLOUDFLARE_ACCOUNT_ID
# プロンプトに Account ID を貼り付けて Enter
gh secret list --repo "OWNER/REPO" --env prd
```

現在のシェルに値を一時的に持たせる場合は、登録直後に必ず消す。値を表示する `echo` は使わない。

```sh
export CF_API_TOKEN=""
export CF_ACCOUNT_ID=""

print -rn -- "$CF_API_TOKEN" | gh secret set --repo "OWNER/REPO" --env prd CLOUDFLARE_API_TOKEN
print -rn -- "$CF_ACCOUNT_ID" | gh secret set --repo "OWNER/REPO" --env prd CLOUDFLARE_ACCOUNT_ID

unset CF_API_TOKEN CF_ACCOUNT_ID
```

`OWNER/REPO` は対象リポジトリに置き換える。同じリポジトリの中で実行する場合は `--repo "OWNER/REPO"` を省略できる。以降に必要となる R2 用キーや Worker runtime secrets は、デプロイ手順の指示に従って同じ `prd` Environment に追加する。

### Terraform state 用の R2 アクセスキーも発行する

上記の `CLOUDFLARE_API_TOKEN` は Cloudflare API（Worker、D1、KV、R2 バケット管理）用である。Terraform のリモート state は S3 互換 API を使うため、**別の R2 API token** が必要になる。

R2 → **Manage R2 API Tokens** → **Create API Token** で、次のように発行する。

| 項目 | 設定 |
|---|---|
| Permission | `Object Read & Write` |
| Bucket scope | Terraform state 用に作成した 1 バケットのみ |
| GitHub `prd` secrets | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` |

この token から表示される Access Key ID と Secret Access Key も一度しか表示されない。state バケットの作成時だけは R2 の bucket 管理権限が必要だが、作成後の Terraform backend にはこのバケット限定のアクセスキーを使う。

## 4. リソースを作る — Terraform か wrangler 単体か

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

## 5. id を wrangler.jsonc に貼る

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

## 6. secrets → マイグレーション → デプロイ

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

## 7. 費用の話

このテンプレートは **Workers Free プランの範囲内**で全機能（Workers / D1 / KV / R2 / Cron / Workflows）が動くよう設計してある。Queues など Paid 限定の機能は使っていない。上限に近づいたときの挙動と設計対処は [`free-tier-limits.md`](./free-tier-limits.md)。

R2 は無料枠でもクレジットカード登録を求められる場合がある（バックアップを使わないなら ops をデプロイしなければよい）。
