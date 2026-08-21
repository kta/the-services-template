import { NotificationJob } from '@app/contracts'
import { internalAuth } from '@app/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { pickSender } from './senders'

/**
 * 通知サービス。**Queue は使わない**(Queues は Free でも使えるが、部品を増やさない
 * 設計判断 — docs/howto/notifications.md)。他 Worker が
 * service binding で `POST /api/internal/send`(x-internal-key)に NotificationJob を
 * POST する同期送信 API。冪等キー = `job.id`(KV `DEDUPE`、TTL 24h)+ Resend の
 * idempotency-key。呼び出し側は best-effort(失敗しても自サービスは継続)。
 */

export type Bindings = {
  DEDUPE: KVNamespace
  RESEND_API_KEY: string
  INTERNAL_KEY: string
  // Resend `from` address. Must be a verified domain in prod (see deploy.md).
  // Empty/unset → senders fall back to the default placeholder address.
  MAIL_FROM?: string
  // dev 専用: 'true' で LogSender(メールを送らずログ出力)を許可。本番には設定
  // しない — RESEND_API_KEY 未設定 + これも未設定なら送信は fail close(502)。
  MAIL_DEV_LOG?: string
}

const DEDUPE_TTL_SECONDS = 60 * 60 * 24

const app = new Hono<{ Bindings: Bindings }>()

// Internal endpoint: shared-key guarded (fail close — see @app/shared internalAuth).
app.use('/api/internal/*', internalAuth())

const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))
  .post('/api/internal/send', zValidator('json', NotificationJob), async (c) => {
    const job = c.req.valid('json')
    // Idempotent: skip a job we already delivered (callers may redeliver).
    // 読み取り失敗(KV 障害・無料枠 read 上限)は at-least-once 側に倒す — throw で
    // 500 にすると呼び出し側が「未送信」と誤認して再送し続けるだけで何も良くならない。
    let duplicate = false
    try {
      duplicate = (await c.env.DEDUPE.get(job.id)) !== null
    } catch (err) {
      console.error('dedupe read failed (proceeding to send)', job.id, err)
    }
    if (duplicate) return c.json({ status: 'duplicate' as const })
    try {
      await pickSender(c.env).send(job)
    } catch (err) {
      // Non-2xx → the caller falls back (e.g. invite returns the link). There is
      // no retry queue by design; delivery is best-effort.
      console.error('send failed', err)
      return c.json({ error: 'send_failed' }, 502)
    }
    // The mail IS delivered past this point. A dedupe-write failure (e.g. the KV
    // free-tier 1,000 writes/day quota) must NOT surface as send_failed — the
    // caller would treat it as undelivered and redeliver, causing duplicates.
    try {
      await c.env.DEDUPE.put(job.id, '1', { expirationTtl: DEDUPE_TTL_SECONDS })
    } catch (err) {
      console.error('dedupe write failed (mail already sent)', job.id, err)
    }
    return c.json({ status: 'sent' as const })
  })

export type AppType = typeof routes

export default app
