# 通知設計(Queue なし・無料枠)

**notifier Worker への同期送信 API** で通知する。Cloudflare Queues は Free プランでも使える(2026-02〜: 10,000 ops/日・保持 24h)が、このテンプレートは**あえて採用していない** — 動く部品を 1 つ増やすより、同期送信 + KV 冪等 + 再検知 Cron で「失敗しても実害が出ない」形にする方が、この規模では運用が単純だという判断(AGENTS.md ルール 9)。Queues を入れるかは人間承認の設計判断。

## 仕組み

```
呼び出し側 Worker ──service binding──▶ notifier POST /api/internal/send
   (best-effort・失敗しても自処理は継続)      ├─ x-internal-key 検証(fail close)
                                              ├─ KV DEDUPE: job.id 冪等(TTL 24h)
                                              └─ Resend(idempotency-key=job.id)
                                                  RESEND_API_KEY も MAIL_DEV_LOG も
                                                  無ければ **fail close(502)**
```

- **契約**: body は `NotificationJob`(`packages/contracts/src/notification.ts`)。`id` が冪等キー。
- **呼び出し側**は `c.env.NOTIFIER.fetch('http://notifier/api/internal/send', ...)` を try/catch で包み、失敗しても本処理を成功させる(best-effort)。
- **応答**: `sent` / `duplicate`(既送信)/ 502 `send_failed`(Resend 非 2xx。呼び出し側がフォールバック)。

## DLQ の代替 3 原則(at-least-once 保証を持たない設計の作法)

リトライキュー・DLQ が無いので、「失敗したら困る通知」は次のいずれかで実害を塞ぐ:

1. **UI フォールバック**: 招待メール送信失敗 → レスポンスで招待リンクを返し画面に表示(手動で渡せる)。
2. **再検知 Cron(自己修復)**: バックアップ失敗通知自体が失敗しても、鮮度チェック Cron が「最終バックアップが古い」ことを翌スロットで再検知して再通知する。
3. **次回実行での再検知**: 死活監視・容量警告は Cron 毎に再評価されるので、一度の通知失敗は次回で回復する。

冪等キーの設計: 再検知で何度も発火するものは**時間スロットキー**(例: 日付、12h スロット)を `id` にして、同じ障害で連打しない。

## 運用の注意

- `INTERNAL_KEY` は binding でつながる全サービス同一値(`docs/howto/deploy.md`)。
- Resend は `from` ドメインの検証必須。`MAIL_FROM` 未設定だと既定のプレースホルダに落ちて Resend に拒否される。
- 通知型を増やすときは `NotificationJob.type` の enum に追加(Zod 単一ソース)。
