- ステータス: Approved

# 001-asymmetric-access-token: access JWT の署名・検証鍵分離

## 1. WHAT / WHY

**概要**（3 行以内）:

認証の源泉である admin だけが access JWT を署名できるようにし、ドメイン Worker には検証用の公開鍵だけを渡す。ドメイン Worker が侵害されても、admin の管理 API 用 JWT を新規に偽造できない境界を作る。

**ユーザーストーリー**:

- US-AUTH-01: プラットフォーム運用者として、ドメイン Worker の侵害が admin の管理権限へ横展開しない認証境界を使いたい。

**検証項目**:

- AUTH-AUTH-01: Given admin に有効な署名用秘密鍵が設定されている When login / refresh / invite acceptance / 開発用 grant が access token を発行する Then token は RS256 で admin の秘密鍵により署名される。
- AUTH-AUTH-02: Given domain Worker に検証用公開鍵だけが設定されている When admin が発行した有効な token で domain API を呼ぶ Then 既存の認証・テナントスコープが成立する。
- AUTH-AUTH-03: Given domain Worker が持つ公開鍵と異なる秘密鍵で署名された token、または旧 HS256 token When admin/domain の保護 API を呼ぶ Then 401 になり、role/org の claim だけでは通過しない。
- AUTH-AUTH-04: Given domain Worker の本番設定 When secret の一覧と deploy 手順を確認する Then domain に JWT 署名用秘密鍵を設定する手順・必須設定・コード参照が存在しない。
- AUTH-AUTH-05: Given ローカル開発で `AUTH_DEV_GRANT=true` が有効 When admin と example_service の dev login を使う Then `AUTH_DEV_PRIVATE_KEY` を使う開発専用の鍵で動作し、本番用 secret 名・値を要求しない。どちらかの設定が欠ければ fail close する。
- AUTH-AUTH-06: Given access token が正しい RS256 署名を持つ When issuer が `admin` かつ対象 Worker の audience（admin は `admin`、domain は `domain:<service_name>`）でない Then 対象 Worker の保護 API は 401 を返す。
- AUTH-AUTH-07: Given domain が `aud=domain:<service_name>` と `sid/sub/org` を持つ正しい access token を受け取る When admin の refresh session が未失効で、user/org が現在も有効である Then domain は admin の live-session introspection を通過させ、admin 側の現在の role を認可コンテキストへ反映する。
- AUTH-AUTH-08: Given domain が検証済み access token を受け取った When logout、refresh rotation/reuse revoke、user 無効化、または org 無効化が行われる Then 次の domain request は 401 になり、同期コピーの 2 時間 lease を理由に通過しない。
- AUTH-AUTH-09: Given domain の live-session introspection When `sid` が無い、admin binding が無い、timeout・非 2xx・不正な応答が発生する Then `sid` 欠落は 401、それ以外の admin 側障害は 503 `auth_unavailable` で fail close する。development の明示的 grant だけはローカル binding 不在の例外とする。
- AUTH-AUTH-10: Given domain → admin introspection を構成する When secret allowlist を確認する Then `DOMAIN_TO_ADMIN_KEY` は admin/domain の両端に置く専用値であり、`JWT_PRIVATE_KEY`、admin → domain、domain → notifier の値とは共有しない。domain は admin の D1 や署名用秘密鍵を保持しない。

**スコープ外**:

- refresh token の形式、cookie 属性、ログイン資格情報、ユーザー・組織 DB の変更。
- 新しい IdP、JWKS 配信 Worker、鍵自動ローテーションの追加。
- example_service の本番デプロイを有効化すること。

**不明点**: なし（既存 Hono が提供する RS256/WebCrypto を使い、依存追加はしない）。

## 2. HOW

**触るファイル**:

- `packages/shared/src/jwt.ts` — RS256 固定の access token 発行・検証。
- `packages/shared/src/auth-server.ts` — domain 側 `JWT_PUBLIC_KEY` 検証。
- `services/admin/src/worker/auth/service.ts` / `services/admin/src/worker/index.ts` — `JWT_PRIVATE_KEY` 発行、local-only dev grant、live-session introspection。
- `services/example_service/src/worker/index.ts` — `JWT_PUBLIC_KEY` 検証、live-session introspection とローカル限定 dev signing key。
- `services/admin/wrangler.jsonc` / `services/example_service/wrangler.jsonc` — 本番 secret 名と、ローカル専用鍵を本番へ持ち込まない設定境界。
- `services/*/.dev.vars.example` / `vitest.config.ts` — 開発・テスト用の非本番鍵ペア。
- `packages/shared/test/` / `services/admin/test/` / `services/example_service/test/` — 鍵境界と既存認証の回帰テスト。
- `packages/contracts/src/auth.ts` — issuer/audience を含む access-token claim の単一ソース。
- `services/admin/test/admin.integration.test.ts` / `packages/shared/test/auth-server.test.ts` — logout/revoke、current role、timeout/malformed response の live-session 回帰。

**データモデル差分**: なし。

**却下した代替案**:

- admin/domain で別々の HS256 secret を持つ案 — 検証側が署名鍵そのものを持つため、domain 侵害時の偽造を防げない。
- domain が署名・期限だけで token を受け入れ、同期 org lease だけに依存する案 — logout、refresh rotation/reuse、user/org 無効化後も最大 lease まで access token が有効になり、管理側の revoke 境界を domain に反映できないため却下する。採用案は admin の refresh session を service binding で bounded（2 秒）に introspect し、障害時は 503 fail close とする。
- 既存の共有署名鍵を残して新鍵を併用する案 — 誤設定時に旧共有鍵経路が残り、境界の証明にならない。

## 3. TASKS

- [x] T-001: `packages/shared/test` に RS256 の往復、HS256 拒否、異なる公開鍵拒否、期限境界の失敗テストを追加する。
- [x] T-002: admin/domain の Worker テストを `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` の境界へ更新し、domain 側に秘密鍵が無くても検証できる回帰テストを追加する。
- [x] T-003: `packages/shared/src/jwt.ts` と auth middleware を RS256 固定へ変更し、admin は private key、domain は public key を使う。
- [x] T-004: `AUTH_DEV_GRANT` の admin/domain 発行経路をローカル専用の `AUTH_DEV_PRIVATE_KEY` に分離し、本番 secret の deploy 手順に含めない。
- [x] T-005: Wrangler config と dev/test fixtures を更新し、旧共有署名鍵の運用参照を削除する。
- [x] T-006: `pnpm --filter @app/shared test`、admin/example の test/typecheck を実行し、検証項目を確認する。
- [x] T-007: issuer/audience の固定値と欠落・不一致の拒否を contract/shared のテストで固定する。
- [x] T-008: domain の保護 API に `tenantAuth` → `requireLiveDomainSession` → `requireActiveOrg` を接続し、admin の live session route と caller-specific key 境界を追加する。
- [x] T-009: logout、rotation/revoke、現行 role/user/org 状態、missing sid、admin timeout・不正応答を表駆動の認証テストで固定する。
