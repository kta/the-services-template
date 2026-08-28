# サービス仕様: admin

- パッケージ: `services/admin` (`@app/admin`) + `services/admin (src/web)` (`@app/admin`)
- 所有 D1: `admin`
- ステータス: Approved

## 目的・責務
**organizations の源泉**（source of truth）+ **認証の源泉**。組織の作成・一覧・無効化と、login / refresh / 招待のフルフローを持ち、org を他サービスへ同期する。

## エンティティ（所有データ）
| エンティティ | 主な属性 | 備考 |
|---|---|---|
| `organization` | id(UUID) / name / plan / is_disabled / is_operator / created_at | 源泉。他サービスへ同期コピーされる |
| `user` | id / organization_id / email / password_hash / role | password_hash は pepper HMAC（`docs/architecture` 参照） |
| `invitation` | id / organization_id / email / token_hash / expires_at / consumed_at / consumed_nonce | 招待トークンはハッシュのみ保存。`consumed_nonce` は同時受理の勝者を確定する内部 claim nonce |
| `refresh_token` | id / user_id / token_hash / rotated_to / revoked_at | ローテーション + 再利用検知 |
| `auth_event` | organization_id / email / kind / ip | 監査ログ（login_success / login_failure / lockout 等） |

## API 面
| メソッド/パス | 認証 | 概要 |
|---|---|---|
| `GET /api/health` | none | ヘルス |
| `POST /api/auth/login` | none（レートリミット付き） | stretched パスワードで認証、access JWT + refresh cookie |
| `POST /api/auth/refresh` | refresh cookie | ローテーション + 再利用検知 |
| `POST /api/auth/logout` | refresh cookie | 当該セッション revoke |
| `POST /api/auth/accept-invite` | 招待トークン | パスワード設定 + 招待消費 |
| `GET/POST /api/organizations` | **operator-org の admin JWT**（default-deny） | 一覧 / 作成 → example_service へ同期 |
| `PATCH/DELETE /api/organizations/:id` | 同上 | plan・無効化の更新（DELETE は無効化）→ 同期 |
| `POST /api/organizations/:id/invitations` | 同上 | ユーザー招待（notifier 経由、失敗時はリンク返却） |
| `/api/internal/*` | `x-internal-key` | 照合 Cron 等の内部 API |

`/api/*` は default-deny（`tenantAuth` + `requireRole('admin')` + `requireOperator`。health / auth / internal のみ除外）。

契約: `packages/contracts/src/organization.ts`（`Organization` / `CreateOrganization`）+ `packages/contracts/src/auth.ts`（`LoginRequest` / `InviteRequest` / `AcceptInviteRequest` 等）。

## cross-D1 同期
作成時に **service binding `EXAMPLE_SERVICE`** 経由で `example_service` の `POST /api/internal/organizations`（internal-key ガード）を typed `hc` で呼び、org の同期コピーを upsert（idempotent）。cross-D1 JOIN は使わない。失敗は best-effort（`synced: false` とログ）→ hourly 照合 Cron が再同期する（ドリフト時 ops.sync_drift 通知）。domain 側のコピーには受信時刻の同期 lease（2 時間）を持たせ、同期停止時は有効化済みの古い行も 503 `not_synced` で fail closed にする。1 回の照合は無料枠に合わせて 40 件まで再同期し、超過は次回へ送る。

## 既知の制約（本番前に必須）
- caller-specific な内部鍵（admin → domain、admin → notifier、domain → admin の受信境界）・admin 専用 `JWT_PRIVATE_KEY`・admin の `JWT_PUBLIC_KEY`・`AUTH_PEPPER` を protected production workflow の allowlist 経由で設定（未設定は fail close）。`scripts/put-production-secret.mjs` は validation-only である。内部鍵は別方向で再利用せず、署名用 private key は admin の外へ出さない。
- `AUTH_DEV_GRANT` と `AUTH_DEV_PRIVATE_KEY` は本番に**設定しない**（両方が揃わない dev トークングラントは fail close）。
- ログイン失敗カウンタは admin D1 の `login_rate_limits`（email+接続元IPをハッシュ化したキー）を atomic UPSERT する。15分窓で5回を超える失敗は `429` とし、成功時は同じ予約カウントだけを条件付き削除するため、並行試行で上限を迂回したり新しい失敗を消したりしない。
- 招待受理は `consumed_at` と一回限りの `consumed_nonce` を条件付き更新し、パスワード更新もその claim に結び付ける。期限内の同一招待を並行受理しても成功者は1件だけである。

## features
（未追加。`features/<NNN>-<slug>/` に追加していく）
