# Cloudflare 無料枠の上限と設計対処

このテンプレートは**全スタックが Cloudflare 無料枠で動く**(AGENTS.md ルール 9)。実プロダクトの構築・運用で効いた上限と、その設計上の抑え方の正典。数値は変わり得るので、疑わしければ公式 docs(`.mcp.json` の cloudflare-docs MCP)で確認する。

表の「/DB」と明記したものを除き、Workers のリクエスト・Cron トリガー・KV
write・Workflows step などの無料枠は、サービスごとではなく Cloudflare
アカウント全体の使用量として集計される前提で見積もる。Worker を増やせば枠も
増える、とは考えない。D1 の容量だけは DB ごとの上限だが、同一 DB に同居する
テナントはその DB の総量を共有する。フォーク時は全サービスの Cron、バックアップ
export、通知 retry、KV dedupe write を合算し、公式の現行制限を再確認する。

## 上限一覧(要暗記の定数)

| リソース | 無料枠の上限 | このテンプレでの設計対処 |
|---|---|---|
| Workers CPU | **10ms/リクエスト** | パスワードの PBKDF2 600k はサーバで回せない → **クライアント側キーストレッチング + サーバは HMAC 1 回**(`packages/shared/src/password.ts`)。LLM 呼び出し等の I/O 待ちは CPU 非課金なので同期呼び出しで OK |
| Workers リクエスト | 100k req/日 | 通常運用で問題にならないが、監視(ops)は Cron 駆動で節約 |
| **Queues** | **Free でも利用可**(2026-02〜: 10,000 ops/日・保持 24h。Paid は 100万 ops/月・保持最大 14 日) | **このテンプレートでは採用しない**(設計判断)。通知は notifier への同期送信 API + KV 冪等 + 再検知 Cron(`docs/howto/notifications.md`)。採用したくなったら人間承認のうえで — 保持 24h とリトライ回数の設計が要る |
| D1 容量 | **500MB/DB** | **400MB(80%)で ops が容量警告**(REST「Get database」の `file_size` を Cron で監視)。マルチテナントを単一 D1 に行分離で同居させると**容量は全テナント総和で効く** — テナント数×平均データ量で実効上限を必ず見積もる。超過見込みなら (1) Paid 移行 (2) テナント群でシャーディング (3) 大きいテーブル(監査ログ等)の分離 |
| サブリクエスト | 外部 50/呼び出し・**Cloudflare サービス宛(D1/KV/R2 等)は 1,000/呼び出し** | N+1 を書かない。集計は SQL 側でまとめる。service binding 呼び出しの多い処理(照合の一斉再同期等)は外部 50 の側に注意 |
| domain live-session introspection | domain の保護 API 1 request ごとに admin service binding 1 回（timeout 2 秒） | production domain は admin の refresh session / user / org を毎リクエスト確認する。admin 障害は 503 fail close。同期 org の 2 時間 lease は認証キャッシュではない。頻度を下げる変更は revoke 遅延を伴うため承認事項 |
| D1 Time Travel | **7 日**(Paid は 30 日) | PITR の主砦にしない。**R2 世代バックアップが主砦**(1 日 2 回 × 30 世代、`services/ops`) |
| KV 書き込み | **1,000 write/日** | KV は notifier の通知 dedupe（DEDUPE）だけに使う。ログイン lockout は admin D1 の `login_rate_limits` を条件付き upsert し、並行失敗でも上限を迂回できないようにする |
| R2 | 10GB | バックアップは 30 世代 prune + R2 lifecycle 16 日の二重安全網で増え続けない。backup bucket は public domain を持たず、managed/custom domain の privacy preflight を通す |
| Workflows | 3,000 steps/日 | バックアップ 1 日 2 回 × 数 step で余裕 |
| Cron | **5 トリガー/アカウント**(Free。Paid は 250/アカウント) | **アカウント全体で共有**される点に注意 — 本テンプレは ops×2 + admin×1 で既に 3 消費。admin の org 照合は hourly だが trigger は 1 本だけである。フォークで照合 Cron を足すたび残枠(2)を使う。枯渇したら Cron を 1 本に束ねて内部でディスパッチ(ops の handleScheduled 方式)するか Paid へ |

## 上限に効く設計判断(なぜこうなっているか)

- **認証**: サーバ側 PBKDF2 は CPU 10ms 超過で不可。iterations を下げるセキュリティ後退もしない。→ ストレッチはブラウザで(PBKDF2-HMAC-SHA256 600k、salt=email 導出)、サーバは pepper HMAC 1 回 + 定数時間比較。DB 漏えい単独では pepper が、pepper 漏えい単独では 600k ストレッチが防壁。
- **通知**: DLQ を失う代わりに、失敗の実害を「UI フォールバック(招待リンクを画面表示)」「再検知 Cron(バックアップ鮮度・死活)」で塞ぐ。→ `docs/howto/notifications.md`
- **バックアップ**: binding では D1 export できない → **REST API + D1:Read 最小トークン**。export は対象 DB をブロックする → Cron は深夜帯に固定。Content-Length と実体ストリームは 512 MiB で fail close し、R2 の `latest.json` は JWT と別の RSA pair で署名する。restore operator は R2 Read/List/Write/Delete と D1 操作だけを持つ別 token を使う。
- **LLM**: 対話 UX は同期呼び出し(I/O 待ちは CPU 非課金)。レート制限 KV は「1 時間バケットキー + TTL」で 1 生成 1 write。キー未設定/timeout/検証 NG は定型文 fallback で 200 を返す。
- **課金機能を使う判断**は人間承認(ルール 10)。「D1 Paid(10GB)へ移行」等はこの表の見積りを添えて提案する。
