# 通知設計(Queue なし・無料枠)

**notifier Worker への同期送信 API** で通知する。Cloudflare Queues は Free プランでも使える(2026-02〜: 10,000 ops/日・保持 24h)が、このテンプレートは**あえて採用していない** — 動く部品を 1 つ増やすより、同期送信 + KV 冪等 + 再検知 Cron で「失敗しても実害が出ない」形にする方が、この規模では運用が単純だという判断(AGENTS.md ルール 9)。Queues を入れるかは人間承認の設計判断。

## 仕組み

```
呼び出し側 Worker ──service binding──▶ notifier POST /api/internal/send
   (best-effort・失敗しても自処理は継続)      ├─ x-internal-key + x-internal-caller + type allowlist(fail close)
                                              ├─ KV DEDUPE: caller:job.id 冪等(TTL 24h)
                                              └─ Resend(idempotency-key=caller:job.id)
                                                  RESEND_API_KEY も MAIL_DEV_LOG も
                                                  無ければ **fail close(502)**
```

- **契約**: body は `NotificationJob`(`packages/contracts/src/notification.ts`)。受信側の冪等キーは `x-internal-caller:job.id` であり、caller 間で同じ `id` を使っても相互に抑制しない。
- **呼び出し側**は `c.env.NOTIFIER.fetch('http://notifier/api/internal/send', ...)` を try/catch で包み、失敗しても本処理を成功させる(best-effort)。
- `x-internal-caller` と鍵を組み合わせて検証する。`admin` は `user.invited` / `ops.sync_drift`、`domain` は `item.created`、`ops` は `ops.*` だけを送信できる。domain の鍵で admin 専用の招待通知を偽装できない。
- 開発用 LogSender は `APP_ENV=development` の明示 opt-in 時だけ選ばれ、ログには type と job id だけを出す。招待 token、宛先、payload、内部鍵をログ・fixture・response に出さない。
- **応答**: `sent` / `duplicate`(既送信)/ 502 `send_failed`(Resend 非 2xx。呼び出し側がフォールバック)。

## 配信セマンティクス（exactly-once ではない）

これは **at-least-once 寄りの best-effort** 設計であり、exactly-once delivery は保証しない。
KV の `get → 送信 → put` は分散ロックではないため、同じ `caller:job.id` の要求が並行すると
両方が未送信と判断して重複送信する可能性がある。送信サービスが受理した直後に timeout・
ネットワーク断が起きた場合も、呼び出し側の再送で重複する。送信後の KV `put` が quota/障害で
失敗した場合は、メールが届いている可能性を優先して `sent` を返すため、その job を再送
すれば重複し得る。

Resend の `idempotency-key` と KV TTL 24h は重複を**抑制**する補助線であり、provider 障害・
並行実行・TTL 経過後の再検知を無くすものではない。重要通知では受信側の provider
idempotency / 重複処理を併用し、運用では `send_failed`、dedupe read/write failure、同一
slot の再検知を監視する。招待は UI のリンク fallback、ops 警告は次回 Cron の再検知を
受入条件に含める。

## DLQ の代替 3 原則（exactly-once を保証しない設計の作法）

リトライキュー・DLQ が無いので、「失敗したら困る通知」は次のいずれかで実害を塞ぐ:

1. **UI フォールバック**: 招待メール送信失敗 → レスポンスで招待リンクを返し画面に表示(手動で渡せる)。
2. **再検知 Cron(自己修復)**: バックアップ失敗通知自体が失敗しても、鮮度チェック Cron が「最終バックアップが古い」ことを翌スロットで再検知して再通知する。
3. **次回実行での再検知**: 死活監視・容量警告は Cron 毎に再評価されるので、一度の通知失敗は次回で回復する。

冪等キーの設計: 再検知で何度も発火するものは**時間スロットキー**(例: 日付、12h スロット)を `id` にして、同じ障害で連打しない。

## 運用の注意

- 内部鍵は方向ごとに分離する。admin → notifier は `ADMIN_TO_NOTIFIER_KEY`、domain → notifier は `DOMAIN_TO_NOTIFIER_KEY`、ops → notifier は `OPS_TO_NOTIFIER_KEY` を使い、それぞれ送信側と notifier だけに登録する。`ADMIN_TO_<DOMAIN>_KEY` など別方向の鍵を notifier で受け付けない(`docs/howto/deploy.md`)。各鍵は 32 bytes 以上のランダム値にする。
- Resend は `from` ドメインの検証必須。`MAIL_FROM` 未設定だと既定のプレースホルダに落ちて Resend に拒否される。
- 通知型を増やすときは `NotificationJob.type` の enum に追加(Zod 単一ソース)。
