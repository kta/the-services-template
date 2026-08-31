import { z } from 'zod'

/**
 * 通知ジョブの Zod 単一ソース。
 *
 * **設計方針(Queues 不使用)**: Cloudflare Queues は Free でも使える(2026-02〜)が、
 * 部品を増やさない判断で採用していない。notifier は同期送信 API
 * (`POST /api/internal/send` + `x-internal-key`)。本契約は
 * その**リクエスト body**。`id` は caller と組み合わせて KV 冪等キー(TTL 24h)に
 * なる。外部メールプロバイダへ渡すキーは notifier 側で固定長ハッシュへ変換する。
 * 配信は best-effort — リトライキューは持たず、重要な失敗は再検知 Cron や
 * UI フォールバックで塞ぐ(docs/howto/notifications.md)。
 */
const NotificationPayload = z
  .record(z.string().min(1).max(64), z.unknown())
  .superRefine((payload, ctx) => {
    if (Object.keys(payload).length > 16) {
      ctx.addIssue({ code: 'custom', message: 'payload has too many fields' })
    }
    try {
      if (JSON.stringify(payload).length > 16 * 1024) {
        ctx.addIssue({ code: 'custom', message: 'payload is too large' })
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'payload is not serializable' })
    }
  })

export const NotificationJob = z.object({
  // KV key とログ/ヘッダの制御文字注入を防ぐ。provider 側の idempotency key
  // は別途固定長ハッシュにするため、ここは追跡可能な内部識別子の契約。
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  type: z.enum([
    'item.created', // テンプレ雛形(example_service)のサンプル通知
    'user.invited', // 招待メール
    'ops.backup_failed', // バックアップ失敗(services/ops)
    'ops.backup_stale', // バックアップ未実行の鮮度検知
    'ops.health_check_failed', // 死活監視
    'ops.monitor_failed', // 監視データ取得失敗(監視自体の停止を隠さない)
    'ops.sync_drift', // admin↔ドメイン同期ずれ(hourly 照合)
    'ops.capacity_warning', // D1 容量が閾値超(無料枠 500MB/DB の 80%)
  ]),
  to: z.string().email().max(320),
  // 型別ペイロード。小さく保つ。
  payload: NotificationPayload.default({}),
})
export type NotificationJob = z.infer<typeof NotificationJob>
