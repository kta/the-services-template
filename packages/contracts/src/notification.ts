import { z } from 'zod'

/**
 * 通知ジョブの Zod 単一ソース。
 *
 * **設計方針(Queues 不使用)**: Cloudflare Queues は Free でも使える(2026-02〜)が、
 * 部品を増やさない判断で採用していない。notifier は同期送信 API
 * (`POST /api/internal/send` + `x-internal-key`)。本契約は
 * その**リクエスト body**。`id` は KV 冪等キー(TTL 24h)+ Resend idempotency-key。
 * 配信は best-effort — リトライキューは持たず、重要な失敗は再検知 Cron や
 * UI フォールバックで塞ぐ(docs/howto/notifications.md)。
 */
export const NotificationJob = z.object({
  id: z.string().min(1),
  type: z.enum([
    'item.created', // テンプレ雛形(example_service)のサンプル通知
    'user.invited', // 招待メール
    'ops.backup_failed', // バックアップ失敗(services/ops)
    'ops.backup_stale', // バックアップ未実行の鮮度検知
    'ops.health_check_failed', // 死活監視
    'ops.sync_drift', // admin↔ドメイン同期ずれ(日次照合)
    'ops.capacity_warning', // D1 容量が閾値超(無料枠 500MB/DB の 80%)
  ]),
  to: z.string().min(1),
  // 型別ペイロード。小さく保つ。
  payload: z.record(z.string(), z.unknown()).default({}),
})
export type NotificationJob = z.infer<typeof NotificationJob>
