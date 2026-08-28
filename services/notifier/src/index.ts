import { EmailAddress, NotificationJob } from '@app/contracts'
import { internalAuth, type NotificationCaller } from '@app/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { pickSender } from './senders'

/**
 * 通知サービス。**Queue は使わない**(Queues は Free でも使えるが、部品を増やさない
 * 設計判断 — docs/howto/notifications.md)。他 Worker が
 * service binding で `POST /api/internal/send`(x-internal-key + x-internal-caller)に
 * NotificationJob を POST する同期送信 API。caller ごとの type allowlist も適用する。
 * 冪等キー = `caller:job.id`(KV `DEDUPE`、TTL 24h)。外部の Resend には
 * caller と job id の SHA-256 固定長値を渡す。呼び出し側は best-effort(失敗しても
 * 自サービスは継続)。
 */

export type Bindings = {
  APP_ENV?: string
  DEDUPE: KVNamespace
  RESEND_API_KEY: string
  // Separate caller credentials prevent a leaked notifier key from being
  // reused to call a different service-binding endpoint.
  ADMIN_TO_NOTIFIER_KEY: string
  DOMAIN_TO_NOTIFIER_KEY: string
  OPS_TO_NOTIFIER_KEY: string
  // Resend `from` address. Must be a verified domain in prod (see deploy.md).
  // Empty/unset → senders fall back to the default placeholder address.
  MAIL_FROM?: string
  // dev 専用: 'true' で LogSender(メールを送らずログ出力)を許可。本番には設定
  // しない — RESEND_API_KEY 未設定 + これも未設定なら送信は fail close(502)。
  MAIL_DEV_LOG?: string
  DOMAIN_NOTIFICATION_TO?: string
  OPS_ALERT_EMAIL?: string
  // Canonical admin origin allowed in user.invited.acceptUrl. This prevents a
  // compromised caller from turning the notifier into a credential forwarder.
  INVITE_BASE_URL?: string
}

const DEDUPE_TTL_SECONDS = 60 * 60 * 24
const PROVIDER_IDEMPOTENCY_KEY_PREFIX = 'v1-'

async function providerIdempotencyKey(dedupeKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dedupeKey))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
  return `${PROVIDER_IDEMPOTENCY_KEY_PREFIX}${hex}`
}

const CALLER_KEY_NAMES: Record<NotificationCaller, keyof Bindings> = {
  admin: 'ADMIN_TO_NOTIFIER_KEY',
  domain: 'DOMAIN_TO_NOTIFIER_KEY',
  ops: 'OPS_TO_NOTIFIER_KEY',
}

const ALLOWED_NOTIFICATION_TYPES: Record<
  NotificationCaller,
  ReadonlySet<NotificationJob['type']>
> = {
  admin: new Set(['user.invited', 'ops.sync_drift']),
  domain: new Set(['item.created']),
  ops: new Set([
    'ops.backup_failed',
    'ops.backup_stale',
    'ops.health_check_failed',
    'ops.monitor_failed',
    'ops.capacity_warning',
  ]),
}

const MAX_INTERNAL_BODY_BYTES = 32 * 1024
const MAX_DETAIL_TEXT_BYTES = 2 * 1024

type Payload = Record<string, unknown>
function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function hasOnlyKeys(payload: Payload, required: readonly string[]): boolean {
  const keys = Object.keys(payload)
  return keys.length === required.length && required.every((key) => keys.includes(key))
}
function boundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}
function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => boundedString(item, maxLength))
  )
}
function canonicalOrigin(value: string | undefined, appEnv: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() ?? '')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (appEnv === 'production' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}
function validInvitePayload(payload: Payload, env: Bindings): boolean {
  if (!hasOnlyKeys(payload, ['acceptUrl']) || !boundedString(payload.acceptUrl, 2048)) return false
  try {
    const url = new URL(payload.acceptUrl)
    const inviteOrigin = canonicalOrigin(env.INVITE_BASE_URL, env.APP_ENV)
    const secureProtocol =
      url.protocol === 'https:' || (env.APP_ENV === 'development' && url.protocol === 'http:')
    const fragmentToken = new URLSearchParams(url.hash.slice(1)).get('token')
    const legacyQueryToken =
      env.APP_ENV === 'development' && !url.hash ? url.searchParams.get('token') : null
    return (
      secureProtocol &&
      inviteOrigin !== null &&
      url.origin === inviteOrigin &&
      url.pathname === '/invite' &&
      ((!url.search && Boolean(fragmentToken)) || Boolean(legacyQueryToken))
    )
  } catch {
    return false
  }
}
function validOpsPayload(type: NotificationJob['type'], payload: Payload): boolean {
  switch (type) {
    case 'ops.backup_failed':
      return (
        hasOnlyKeys(payload, ['failed']) &&
        Array.isArray(payload.failed) &&
        payload.failed.length <= 32 &&
        payload.failed.every(
          (item) =>
            isPayload(item) &&
            hasOnlyKeys(item, ['target', 'reason']) &&
            boundedString(item.target, 128) &&
            boundedString(item.reason, MAX_DETAIL_TEXT_BYTES),
        )
      )
    case 'ops.backup_stale':
      return (
        hasOnlyKeys(payload, ['latest', 'staleTargets']) &&
        (payload.latest === null ||
          (boundedString(payload.latest, 64) && !Number.isNaN(Date.parse(payload.latest)))) &&
        boundedStringArray(payload.staleTargets, 32, 128)
      )
    case 'ops.health_check_failed':
      return hasOnlyKeys(payload, ['down']) && boundedStringArray(payload.down, 32, 128)
    case 'ops.monitor_failed':
      return (
        hasOnlyKeys(payload, ['component', 'failed']) &&
        boundedString(payload.component, 64) &&
        Array.isArray(payload.failed) &&
        payload.failed.length <= 32 &&
        payload.failed.every(
          (item) =>
            isPayload(item) &&
            hasOnlyKeys(item, ['target', 'reason']) &&
            boundedString(item.target, 128) &&
            boundedString(item.reason, MAX_DETAIL_TEXT_BYTES),
        )
      )
    case 'ops.sync_drift':
      return (
        (hasOnlyKeys(payload, ['organizationIds', 'count', 'failed', 'truncated']) &&
          boundedStringArray(payload.organizationIds, 128, 128) &&
          typeof payload.count === 'number' &&
          Number.isInteger(payload.count) &&
          payload.count >= 0 &&
          payload.count <= 128 &&
          boundedStringArray(payload.failed, 128, 128) &&
          typeof payload.truncated === 'boolean') ||
        (hasOnlyKeys(payload, ['reason', 'message']) &&
          payload.reason === 'reconcile_failed' &&
          boundedString(payload.message, MAX_DETAIL_TEXT_BYTES, 0))
      )
    case 'ops.capacity_warning':
      return (
        hasOnlyKeys(payload, ['over', 'thresholdMb']) &&
        Array.isArray(payload.over) &&
        payload.over.length <= 32 &&
        payload.over.every(
          (item) =>
            isPayload(item) &&
            hasOnlyKeys(item, ['target', 'bytes', 'mb']) &&
            boundedString(item.target, 128) &&
            typeof item.bytes === 'number' &&
            Number.isInteger(item.bytes) &&
            item.bytes >= 0 &&
            item.bytes <= 500 * 1024 * 1024 &&
            typeof item.mb === 'number' &&
            item.mb >= 0 &&
            item.mb <= 500,
        ) &&
        typeof payload.thresholdMb === 'number' &&
        payload.thresholdMb > 0 &&
        payload.thresholdMb <= 500
      )
    default:
      return false
  }
}

function validPayloadForType(
  type: NotificationJob['type'],
  payload: unknown,
  env: Bindings,
): boolean {
  if (!isPayload(payload)) return false
  if (type === 'user.invited') return validInvitePayload(payload, env)
  if (type === 'item.created') {
    return (
      hasOnlyKeys(payload, ['itemId', 'title']) &&
      boundedString(payload.itemId, 256) &&
      boundedString(payload.title, 256, 0)
    )
  }
  return validOpsPayload(type, payload)
}

/** All three notifier credentials must be present, long enough, and distinct. */
export function validateCallerKeys(
  env: Pick<Bindings, 'ADMIN_TO_NOTIFIER_KEY' | 'DOMAIN_TO_NOTIFIER_KEY' | 'OPS_TO_NOTIFIER_KEY'>,
): boolean {
  const keys = [env.ADMIN_TO_NOTIFIER_KEY, env.DOMAIN_TO_NOTIFIER_KEY, env.OPS_TO_NOTIFIER_KEY]
  return (
    keys.every((key) => typeof key === 'string' && new TextEncoder().encode(key).length >= 32) &&
    new Set(keys).size === keys.length
  )
}

function configuredEmail(value: string | undefined): string | null {
  const email = value?.trim()
  return email && EmailAddress.safeParse(email).success ? email : null
}

function validJobForCaller(
  caller: NotificationCaller,
  job: NotificationJob,
  env: Bindings,
): boolean {
  if (!validPayloadForType(job.type, job.payload, env)) return false
  if (caller === 'admin' && job.type === 'user.invited') return true
  if (caller === 'domain') {
    const destination =
      configuredEmail(env.DOMAIN_NOTIFICATION_TO) ??
      (env.APP_ENV === 'development' ? 'team@example.com' : null)
    return job.type === 'item.created' && destination !== null && job.to === destination
  }
  const alert = configuredEmail(env.OPS_ALERT_EMAIL)
  return alert !== null && job.to === alert
}

function isNotificationCaller(value: string | undefined): value is NotificationCaller {
  return value === 'admin' || value === 'domain' || value === 'ops'
}

const app = new Hono<{ Bindings: Bindings }>()

const internalBodyLimit = bodyLimit({
  maxSize: MAX_INTERNAL_BODY_BYTES,
  onError: (c) => c.json({ error: 'payload_too_large' }, 413),
})

// Internal endpoint: the key and its declared caller are checked together.
// Keeping both prevents a compromised domain key from being used for admin-only
// invite mail even though all callers share the same transport endpoint.
app.use('/api/internal/*', async (c, next) => {
  const caller = c.req.header('x-internal-caller')
  if (!isNotificationCaller(caller)) return c.json({ error: 'unauthorized' }, 401)
  if (!validateCallerKeys(c.env)) return c.json({ error: 'internal_configuration' }, 503)
  return internalAuth<{ Bindings: Bindings }>(CALLER_KEY_NAMES[caller])(c, next)
})

const routes = app
  .get('/api/health', (c) => c.json({ status: 'ok' as const }))
  .post('/api/internal/send', internalBodyLimit, zValidator('json', NotificationJob), async (c) => {
    const job = c.req.valid('json')
    const caller = c.req.header('x-internal-caller')
    if (
      !isNotificationCaller(caller) ||
      !ALLOWED_NOTIFICATION_TYPES[caller].has(job.type) ||
      !validJobForCaller(caller, job, c.env)
    ) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const dedupeKey = `${caller}:${job.id}`
    // Idempotent: skip a job we already delivered (callers may redeliver).
    // 読み取り失敗(KV 障害・無料枠 read 上限)は at-least-once 側に倒す — throw で
    // 500 にすると呼び出し側が「未送信」と誤認して再送し続けるだけで何も良くならない。
    let duplicate = false
    try {
      duplicate = (await c.env.DEDUPE.get(dedupeKey)) !== null
    } catch (err) {
      console.error('dedupe read failed (proceeding to send)', job.id, err)
    }
    if (duplicate) return c.json({ status: 'duplicate' as const })
    try {
      // Keep the full caller/job key in KV for diagnostics, but send only a
      // stable fixed-length digest to the external provider.
      await pickSender(c.env).send(job, await providerIdempotencyKey(dedupeKey))
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
      await c.env.DEDUPE.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS })
    } catch (err) {
      console.error('dedupe write failed (mail already sent)', job.id, err)
    }
    return c.json({ status: 'sent' as const })
  })

export type AppType = typeof routes

export default app
