import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { EmailAddress, type NotificationJob } from '@app/contracts'
import { sendNotification } from '@app/shared'
import { Hono } from 'hono'
import { type D1ExportConfig, exportD1DumpStream, fetchD1FileSize } from './d1-export'
import {
  backupKey,
  backupSlotKey,
  bytesToMB,
  capacitySlotKey,
  D1_CAPACITY_THRESHOLD_BYTES,
  isOverCapacity,
  isStale,
  prunePlan,
  validateDumpStream,
} from './lib/backup'
import {
  BACKUP_SIGNATURE_ALGORITHM,
  signBackupManifest,
  verifyBackupManifest,
} from './lib/manifest-signature'
import { checkR2BucketPrivate } from './r2-policy'

/**
 * ops サービス。SPA/D1 を持たない運用専用 Worker(無料枠のみで動く)。
 *
 * - **BackupWorkflow**: Cron(JST 2:00/14:00)→ 各 D1 を REST export → 検証 → R2 に
 *   世代保存(30 世代 prune)→ latest.json 更新。失敗は `ops.backup_failed` を 12h
 *   スロット冪等で通知。Workflows は Free プランで利用可(3,000 steps/日)。
 * - **鮮度 + 死活 + 容量 Cron**(JST 3:30/15:30 = +90 分): latest.json が閾値
 *   (既定 13h — lib/backup.ts isStale)超で `ops.backup_stale`、各サービス
 *   /api/health が非 200 で `ops.health_check_failed`、D1 使用量が閾値超で
 *   `ops.capacity_warning`。
 * - Queue は使わない(設計判断 — notifications.md)。通知は NOTIFIER binding へ
 *   同期 POST(/api/internal/send)。
 */

export type Bindings = {
  APP_ENV: string
  // 世代バックアップ置き場(非公開バケット)。
  BACKUPS: R2Bucket
  // バックアップ Workflow(Cron トリガ or scheduled から create)。
  BACKUP_WF: Workflow
  // 通知(binding、best-effort)。
  NOTIFIER: Fetcher
  // 死活監視対象(内部 service binding、/api/health を叩く)。
  // フォーク先で監視対象を増やす場合はここに binding を足し、
  // wrangler.jsonc の `services` と opsTargets() にも追加する。
  ADMIN: Fetcher
  // ops → notifier key; it is not accepted by admin or domain endpoints.
  OPS_TO_NOTIFIER_KEY: string
  // D1 REST export 用(トークンは D1:Read のみに絞る)。
  CF_ACCOUNT_ID: string
  D1_EXPORT_API_TOKEN: string
  // R2 control-plane policy read token; never reuse the D1 or deploy token.
  R2_POLICY_CHECK_API_TOKEN: string
  // export 対象 D1 の database_id(本番は実 ID を vars で設定)。
  // フォーク先で対象 DB を増やす場合は `MYSERVICE_DB_ID` のような var を足し、
  // opsTargets() にエントリを追加する。
  ADMIN_DB_ID: string
  // BACKUPS binding does not expose its bucket name at runtime, so keep the
  // reviewed name explicit for the control-plane public-access monitor.
  BACKUP_BUCKET_NAME: string
  // 運用アラートの宛先(検証済みの実メール)。production では必須。
  OPS_ALERT_EMAIL?: string
  // latest.json の署名鍵。private は ops secret、public は公開設定値。
  BACKUP_SIGNING_PRIVATE_KEY?: string
  BACKUP_SIGNING_PUBLIC_KEY?: string
}

const LATEST_KEY = 'latest.json'
const KEEP_GENERATIONS = 30
const HEALTH_REQUEST_TIMEOUT_MS = 15_000
const MAX_D1_EXPORT_BYTES = 512 * 1024 * 1024
const MAX_R2_LIST_OBJECTS = 10_000
const LATEST_WRITE_ATTEMPTS = 5
const GENERATION_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/

/**
 * 監視対象の宣言テーブル(**単一ソース**)。バックアップ・容量・死活の 3 監視は
 * すべてここから駆動される:
 * - `databaseId` があれば: バックアップ + 容量監視の対象
 * - `healthBinding` があれば: 死活監視(/api/health)の対象
 * フォーク先でサービスを増やすときは**ここに 1 行足すだけ**(+ Bindings 型と
 * wrangler.jsonc の vars / services に対応エントリを追加)。リストが分散していると
 * 「新サービスがバックアップだけ漏れる」事故が起きるので、必ずこの 1 箇所に足す。
 */
type OpsTarget = {
  name: string
  // sentinel = その DB に必ず存在し中身があるはずの表(空 DB 検知用)。
  databaseId?: string
  sentinelTable?: string
  // ダンプ最小バイト数(既定 1,000)。平常サイズが分かったら引き上げる。
  minBytes?: number
  healthBinding?: Fetcher
}
function opsTargets(env: Bindings): OpsTarget[] {
  return [
    {
      name: 'admin',
      databaseId: env.ADMIN_DB_ID,
      sentinelTable: 'users',
      healthBinding: env.ADMIN,
    },
    { name: 'notifier', healthBinding: env.NOTIFIER },
    // 例: { name: 'myservice', databaseId: env.MYSERVICE_DB_ID, sentinelTable: 'items',
    //       healthBinding: env.MYSERVICE },
  ]
}

type BackupTarget = { name: string; databaseId: string; sentinelTable: string; minBytes?: number }

type BackupSummary = {
  target: string
  ok: boolean
  reason?: string
  bytes?: number
  sha256?: string
  accountId?: string
  databaseId?: string
  // R2 の世代オブジェクトキー(成功時)。latest.json 経由でリストア手順が実キーを
  // 特定できるように記録する(wrangler に r2 object list が無いため)。
  key?: string
}

type LatestBackupTarget = {
  at: string
  key?: string
  bytes?: number
  sha256?: string
  accountId?: string
  databaseId?: string
}

type LatestBackup = {
  at: string | null
  summaries: BackupSummary[]
  targets: Record<string, LatestBackupTarget>
  signature?: string
  signatureAlgorithm?: string
}

/** バックアップ + 容量監視の対象(= databaseId を持つ target)。 */
function backupTargetsOf(env: Bindings): BackupTarget[] {
  return opsTargets(env).flatMap((t) =>
    t.databaseId
      ? [
          {
            name: t.name,
            databaseId: t.databaseId,
            sentinelTable: t.sentinelTable ?? 'users',
            minBytes: t.minBytes,
          },
        ]
      : [],
  )
}

/** best-effort 通知(@app/shared の sendNotification に委譲)。 */
function notifyOps(
  env: Bindings,
  job: { id: string; type: NotificationJob['type']; payload?: Record<string, unknown> },
): Promise<boolean> {
  const to = alertTo(env)
  if (!to) {
    console.error(
      'ops notification skipped: OPS_ALERT_EMAIL is missing or invalid',
      job.type,
      job.id,
    )
    return Promise.resolve(false)
  }
  return sendNotification(env.NOTIFIER, env.OPS_TO_NOTIFIER_KEY, 'ops', {
    payload: {},
    ...job,
    to,
  })
}

type MonitorFailure = { target: string; reason: string }

const SAFE_MONITOR_REASONS = new Set([
  'r2_read_failed',
  'r2_policy_check_failed',
  'r2_policy_lookup_failed',
  'r2_policy_response_invalid',
  'r2_policy_api_unsuccessful',
  'r2_policy_account_invalid',
  'r2_policy_bucket_invalid',
  'r2_policy_token_missing',
  'r2_managed_public_access_enabled',
  'r2_custom_public_access_enabled',
  'd1_size_read_failed',
  'd1_get_api_unsuccessful',
  'd1_get_invalid_size',
])

function monitorFailureReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (SAFE_MONITOR_REASONS.has(message)) return message
  if (/^d1_get_http_[45][0-9]{2}$/.test(message)) return 'd1_get_http_error'
  return fallback
}

const SAFE_BACKUP_FAILURE_REASONS = new Set([
  'backup_upload_too_large',
  'backup_validation_digest_missing',
  'export_error',
  'export_timeout',
  'export_failed',
  'export_no_bookmark',
  'export_no_url',
  'export_url_invalid',
  'export_download_empty',
  'export_download_length_unknown',
  'export_download_length_mismatch',
  'export_download_too_large',
  'too_small',
  'too_large',
  'no_schema',
  'no_rows',
  'invalid_utf8',
  'backup_generation_conflict',
])

function backupFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const reason = message.match(/^backup_failed:[^:]+:(.+)$/)?.[1] ?? message
  if (reason === 'backup_upload_too_large' || reason === 'export_download_too_large') {
    return 'too_large'
  }
  if (SAFE_BACKUP_FAILURE_REASONS.has(reason)) return reason
  if (/^export_download_[45][0-9]{2}$/.test(reason)) return 'export_download_http_error'
  return 'export_error'
}

/**
 * Notifier is deliberately synchronous and best-effort, but a failed alert
 * must not disappear with the invocation. Persist a small, secret-free record
 * in the existing private backup bucket as the operator's retry evidence. The
 * record is content-addressed so repeated Cron slots are idempotent; if R2 is
 * also unavailable the error is still emitted to Worker observability logs.
 */
async function persistUndeliveredNotification(
  env: Bindings,
  job: { id: string; type: NotificationJob['type']; payload?: Record<string, unknown> },
): Promise<void> {
  const record = JSON.stringify({ at: new Date().toISOString(), ...job })
  if (new TextEncoder().encode(record).byteLength > 64 * 1024) {
    throw new Error('monitor_failure_record_too_large')
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${job.type}:${job.id}`),
  )
  const suffix = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  await env.BACKUPS.put(`monitor-failures/${suffix}.json`, record, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      kind: 'monitor-failure',
      accountId: env.CF_ACCOUNT_ID,
      bucketName: env.BACKUP_BUCKET_NAME,
    },
  })
}

async function notifyOpsWithFallback(
  env: Bindings,
  job: { id: string; type: NotificationJob['type']; payload?: Record<string, unknown> },
): Promise<boolean> {
  const delivered = await notifyOps(env, job)
  if (delivered) return true
  try {
    await persistUndeliveredNotification(env, job)
  } catch {
    console.error('undelivered ops notification could not be persisted', job.type)
  }
  return false
}

async function notifyMonitorFailure(
  env: Bindings,
  now: Date,
  component: string,
  failed: MonitorFailure[],
): Promise<void> {
  await notifyOpsWithFallback(env, {
    id: `monitor:${component}:${capacitySlotKey(now)}`,
    type: 'ops.monitor_failed',
    payload: { component, failed: failed.slice(0, 32) },
  })
}

/** アラート宛先。production で未設定/不正なら通知を捨てず fail close する。 */
function alertTo(env: Bindings): string | null {
  const configured = env.OPS_ALERT_EMAIL?.trim()
  if (configured && EmailAddress.safeParse(configured).success) return configured
  return env.APP_ENV === 'development' ? 'ops@example.com' : null
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function parseLatestBackup(source: string): LatestBackup | null {
  try {
    const value: unknown = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const targets: Record<string, LatestBackupTarget> = {}
    if (record.targets && typeof record.targets === 'object' && !Array.isArray(record.targets)) {
      for (const [name, candidate] of Object.entries(record.targets)) {
        if (
          name.length > 128 ||
          !candidate ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate)
        ) {
          continue
        }
        const target = candidate as Record<string, unknown>
        if (!isIsoDate(target.at)) continue
        targets[name] = {
          at: target.at,
          ...(typeof target.key === 'string' && target.key.length <= 512
            ? { key: target.key }
            : {}),
          ...(typeof target.bytes === 'number' &&
          Number.isSafeInteger(target.bytes) &&
          target.bytes >= 0
            ? { bytes: target.bytes }
            : {}),
          ...(typeof target.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(target.sha256)
            ? { sha256: target.sha256.toLowerCase() }
            : {}),
          ...(typeof target.accountId === 'string' && target.accountId.length <= 128
            ? { accountId: target.accountId }
            : {}),
          ...(typeof target.databaseId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            target.databaseId,
          )
            ? { databaseId: target.databaseId }
            : {}),
        }
      }
    }
    const summaries = Array.isArray(record.summaries)
      ? record.summaries
          .filter((summary): summary is BackupSummary => {
            if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false
            const item = summary as Record<string, unknown>
            return (
              typeof item.target === 'string' &&
              item.target.length <= 128 &&
              typeof item.ok === 'boolean' &&
              (item.reason === undefined ||
                (typeof item.reason === 'string' && item.reason.length <= 2048)) &&
              (item.key === undefined ||
                (typeof item.key === 'string' && item.key.length <= 512)) &&
              (item.bytes === undefined ||
                (typeof item.bytes === 'number' &&
                  Number.isSafeInteger(item.bytes) &&
                  item.bytes >= 0)) &&
              (item.sha256 === undefined ||
                (typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(item.sha256))) &&
              (item.accountId === undefined ||
                (typeof item.accountId === 'string' && item.accountId.length <= 128)) &&
              (item.databaseId === undefined ||
                (typeof item.databaseId === 'string' &&
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    item.databaseId,
                  )))
            )
          })
          .slice(0, 32)
      : []
    return {
      at: isIsoDate(record.at) ? record.at : null,
      summaries,
      targets,
      ...(typeof record.signature === 'string' && /^[A-Za-z0-9_-]+$/.test(record.signature)
        ? { signature: record.signature }
        : {}),
      ...(typeof record.signatureAlgorithm === 'string'
        ? { signatureAlgorithm: record.signatureAlgorithm }
        : {}),
    }
  } catch {
    return null
  }
}

type LatestBackupObject = { latest: LatestBackup | null; etag: string }

async function readLatestBackupObject(env: Bindings): Promise<LatestBackupObject | null> {
  const object = await env.BACKUPS.get(LATEST_KEY)
  if (!object) return null
  // Check R2 metadata before materializing attacker-controlled/corrupt content.
  if (object.size > 256 * 1024) return null
  // R2 bindings do not expose their bucket name to Worker code. The deploy
  // preflight therefore binds the reviewed name into the Worker config, and
  // every manifest records that identity as a data-plane consistency check.
  // A manifest from a stale/wrong binding is rejected before JSON parsing.
  if (
    env.APP_ENV !== 'development' &&
    (object.customMetadata?.kind !== 'latest-manifest' ||
      object.customMetadata?.accountId !== env.CF_ACCOUNT_ID ||
      object.customMetadata?.bucketName !== env.BACKUP_BUCKET_NAME)
  ) {
    console.error('latest backup manifest R2 binding identity mismatch')
    return { latest: null, etag: object.etag }
  }
  const source = await object.text()
  // latest.json is generated by this Worker and should stay tiny. Refuse an
  // unexpectedly large/corrupt object before JSON parsing to keep the monitor
  // from becoming an R2-backed memory sink.
  const latest = source.length > 256 * 1024 ? null : parseLatestBackup(source)
  if (!latest) return { latest: null, etag: object.etag }
  // Any non-development environment is treated as production for integrity
  // purposes. A typo such as `staging` must never silently turn off manifest
  // verification and make the monitor trust attacker-controlled R2 state.
  if (env.APP_ENV !== 'development') {
    if (
      latest.signatureAlgorithm !== BACKUP_SIGNATURE_ALGORITHM ||
      !latest.signature ||
      !env.BACKUP_SIGNING_PUBLIC_KEY
    ) {
      console.error('latest backup manifest signature is missing')
      return { latest: null, etag: object.etag }
    }
    const unsigned = { ...latest }
    delete unsigned.signature
    delete unsigned.signatureAlgorithm
    try {
      if (
        !(await verifyBackupManifest(unsigned, latest.signature, env.BACKUP_SIGNING_PUBLIC_KEY))
      ) {
        console.error('latest backup manifest signature is invalid')
        return { latest: null, etag: object.etag }
      }
    } catch {
      console.error('latest backup manifest signature could not be verified')
      return { latest: null, etag: object.etag }
    }
  }
  return { latest, etag: object.etag }
}

async function readLatestBackup(env: Bindings): Promise<LatestBackup | null> {
  return (await readLatestBackupObject(env))?.latest ?? null
}

function latestTargetNames(latest: LatestBackup | null, configured: string[]): string[] {
  const names = new Set(configured)
  if (latest) {
    for (const name of Object.keys(latest.targets)) names.add(name)
  }
  return [...names].filter((name) => name.length > 0).slice(0, 32)
}

function hasValidGenerationMetadata(
  target: BackupTarget,
  entry: LatestBackupTarget | undefined,
  env: Bindings,
): entry is LatestBackupTarget & {
  key: string
  bytes: number
  sha256: string
  accountId: string
  databaseId: string
} {
  if (!entry || typeof entry.key !== 'string' || typeof entry.sha256 !== 'string') return false
  if (
    !entry.key.startsWith(`${target.name}/`) ||
    !GENERATION_FILENAME_PATTERN.test(entry.key.slice(target.name.length + 1)) ||
    typeof entry.bytes !== 'number' ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    entry.bytes > MAX_D1_EXPORT_BYTES ||
    !/^[0-9a-f]{64}$/i.test(entry.sha256) ||
    entry.accountId !== env.CF_ACCOUNT_ID ||
    entry.databaseId?.toLowerCase() !== target.databaseId.toLowerCase()
  ) {
    return false
  }
  return true
}

/**
 * latest.json の時刻だけを信頼せず、世代オブジェクトの存在・サイズ・生成時 metadata
 * と本文の SHA/SQL 構造まで照合する。R2 上の object が消えた/差し替わった場合は
 * stale として通知し、fresh と誤判定しない。
 */
async function hasFreshLatestTarget(
  env: Bindings,
  target: BackupTarget,
  entry: LatestBackupTarget | undefined,
  now: Date,
): Promise<boolean | 'unavailable'> {
  if (!hasValidGenerationMetadata(target, entry, env) || isStale(entry.at, now)) return false
  try {
    const object = await env.BACKUPS.head(entry.key)
    if (!object || object.size !== entry.bytes) return false
    const metadata = object.customMetadata
    if (
      metadata?.target === target.name &&
      metadata?.accountId === env.CF_ACCOUNT_ID &&
      metadata?.databaseId?.toLowerCase() === target.databaseId.toLowerCase() &&
      metadata?.createdAt === entry.at
    ) {
      const body = await env.BACKUPS.get(entry.key)
      if (!body || body.size !== entry.bytes || !body.body) return false
      const verification = await validateDumpStream(
        body.body,
        target.sentinelTable,
        target.minBytes,
      )
      return (
        verification.ok &&
        verification.bytes === entry.bytes &&
        verification.sha256 === entry.sha256
      )
    }
    return false
  } catch (error) {
    console.error(
      'latest backup integrity check failed',
      target.name,
      monitorFailureReason(error, 'r2_read_failed'),
    )
    return 'unavailable'
  }
}

async function listBackupKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  while (true) {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    keys.push(...page.objects.map((object) => object.key))
    if (keys.length > MAX_R2_LIST_OBJECTS) throw new Error('backup_generation_limit_exceeded')
    if (!page.truncated) return keys
    cursor = page.cursor
    if (!cursor) throw new Error('backup_list_cursor_missing')
  }
}

async function existingGenerationMatches(
  env: Bindings,
  target: BackupTarget,
  key: string,
  bytes: number,
  sha256: string,
  now: Date,
): Promise<boolean> {
  const object = await env.BACKUPS.get(key)
  if (!object || object.size !== bytes) return false
  const metadata = object.customMetadata
  if (
    metadata?.target !== target.name ||
    metadata?.accountId !== env.CF_ACCOUNT_ID ||
    metadata?.databaseId?.toLowerCase() !== target.databaseId.toLowerCase() ||
    metadata?.createdAt !== now.toISOString()
  ) {
    return false
  }
  const verification = await validateDumpStream(object.body, target.sentinelTable, target.minBytes)
  return verification.ok && verification.bytes === bytes && verification.sha256 === sha256
}

async function pruneGenerations(bucket: R2Bucket, targetName: string): Promise<void> {
  // prune: 対象 prefix の世代を列挙し 30 を超える古い分を一括削除
  // (R2Bucket.delete は key 配列を受ける — 逐次 delete の N 往復を避ける)。
  const listed = await listBackupKeys(bucket, `${targetName}/`)
  const del = prunePlan(listed, KEEP_GENERATIONS)
  for (let index = 0; index < del.length; index += 1_000) {
    const chunk = del.slice(index, index + 1_000)
    if (chunk.length > 0) await bucket.delete(chunk)
  }
}

/**
 * 1 ターゲットのバックアップ(export→検証→R2 put→prune)。失敗は例外を投げず
 * summary で返し、呼び出し側がまとめて `ops.backup_failed` を 12h スロット冪等で通知。
 * fetchImpl / now は注入可能(テスト用)。
 */
export async function backupTarget(
  env: Bindings,
  target: BackupTarget,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<BackupSummary> {
  try {
    const cfg: D1ExportConfig = {
      accountId: env.CF_ACCOUNT_ID,
      databaseId: target.databaseId,
      apiToken: env.D1_EXPORT_API_TOKEN,
    }
    const key = backupKey(target.name, now)
    const dump = await exportD1DumpStream(cfg, fetchImpl)
    const [uploadSource, validationStream] = dump.stream.tee()
    const fixedLength = new FixedLengthStream(dump.contentLength)
    const upload = env.BACKUPS.put(key, fixedLength.readable, {
      // A replayed Workflow must never replace a previously accepted
      // generation for the same deterministic slot. R2 returns null when the
      // condition fails, which is handled below without deleting that object.
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: {
        target: target.name,
        accountId: env.CF_ACCOUNT_ID,
        databaseId: target.databaseId,
        createdAt: now.toISOString(),
      },
    })
    const feed = uploadSource.pipeTo(fixedLength.writable)
    let check: Awaited<ReturnType<typeof validateDumpStream>>
    try {
      check = await validateDumpStream(validationStream, target.sentinelTable, target.minBytes)
    } catch (error) {
      // The upload may have consumed the other tee branch before validation
      // failed. Remove it after waiting so a failed/oversized dump cannot be
      // mistaken for a usable generation. Promise.allSettled also prevents a
      // rejected fixed-length/upload branch from becoming an unhandled error.
      const [uploadResult] = await Promise.allSettled([upload, feed])
      if (uploadResult.status === 'fulfilled' && uploadResult.value) {
        await env.BACKUPS.delete(key).catch(() => undefined)
      }
      throw error
    }
    const [uploadResult, feedResult] = await Promise.allSettled([upload, feed])
    if (feedResult.status === 'rejected') {
      // If R2 accepted the object before the fixed-length feeder reported an
      // error, remove that object rather than leaving an unverifiable
      // generation behind.
      if (uploadResult.status === 'fulfilled' && uploadResult.value) {
        await env.BACKUPS.delete(key).catch(() => undefined)
      }
      throw feedResult.reason
    }
    if (uploadResult.status === 'rejected') {
      throw uploadResult.reason
    }
    const uploaded = uploadResult.value
    if (!check.ok) {
      if (uploaded) await env.BACKUPS.delete(key)
      return { target: target.name, ok: false, reason: check.reason }
    }
    const sha256 = check.sha256
    if (!sha256) throw new Error('backup_validation_digest_missing')
    if (!uploaded) {
      // Another replay won the conditional put. Reuse it only after checking
      // its metadata and streaming it through the same dump validator; never
      // delete or overwrite an object we did not create.
      if (await existingGenerationMatches(env, target, key, check.bytes, sha256, now)) {
        // A replay is still a successful backup run. Run retention here too;
        // otherwise a transient prune failure on the original run can leave
        // more than KEEP_GENERATIONS objects forever because the deterministic
        // slot returns before the normal upload path.
        await pruneGenerations(env.BACKUPS, target.name)
        return {
          target: target.name,
          ok: true,
          bytes: check.bytes,
          sha256,
          accountId: env.CF_ACCOUNT_ID,
          databaseId: target.databaseId,
          key,
        }
      }
      // A same-slot object with invalid metadata/content is never deleted or
      // overwritten automatically: it may be operator evidence or an object
      // written by an unexpected principal. Return a visible backup failure so
      // the operator can inspect/quarantine it explicitly.
      return { target: target.name, ok: false, reason: 'backup_generation_conflict' }
    }

    await pruneGenerations(env.BACKUPS, target.name)

    // bytes は validateDumpStream が計算済み(巨大ダンプを再エンコードしない)。
    return {
      target: target.name,
      ok: true,
      bytes: check.bytes,
      sha256,
      accountId: env.CF_ACCOUNT_ID,
      databaseId: target.databaseId,
      key,
    }
  } catch (err) {
    const reason = backupFailureReason(err)
    console.error('backup target failed', target.name, reason)
    return { target: target.name, ok: false, reason }
  }
}

/**
 * バックアップ結果の確定処理: 失敗があれば 12h スロット冪等で `ops.backup_failed` を
 * 通知し、1 つでも成功していれば latest.json(鮮度の根拠)を更新する。
 * Workflow ではリトライ枯渇後に 1 回だけ呼ぶ(途中失敗で通知しない)。
 */
export async function finalizeBackup(
  env: Bindings,
  now: Date,
  summaries: BackupSummary[],
): Promise<void> {
  const failed = summaries.filter((s) => !s.ok)
  if (failed.length > 0) {
    await notifyOpsWithFallback(env, {
      id: backupSlotKey('backup_failed', now),
      type: 'ops.backup_failed',
      payload: { failed: failed.map((f) => ({ target: f.target, reason: f.reason })) },
    })
  }

  const successful = summaries.filter((s) => s.ok)
  if (successful.length === 0) return

  // latest.json is a shared R2 object. Use a bounded compare-and-swap loop so
  // a delayed/duplicated Workflow cannot roll a newer manifest back to an
  // older read-modify-write result.
  for (let attempt = 0; attempt < LATEST_WRITE_ATTEMPTS; attempt += 1) {
    const previousObject = await readLatestBackupObject(env)
    const previous = previousObject?.latest
    const targets: Record<string, LatestBackupTarget> = { ...(previous?.targets ?? {}) }
    const nowIso = now.toISOString()
    const nowMs = now.getTime()
    for (const summary of successful) {
      if (
        !summary.key ||
        summary.bytes === undefined ||
        !summary.sha256 ||
        !summary.accountId ||
        !summary.databaseId
      ) {
        throw new Error('successful_backup_metadata_missing')
      }
      // A delayed Workflow may finish after a newer run has already published
      // its manifest. Keep a complete, target-bound newer entry instead of
      // replacing it with this older successful export. The CAS below protects
      // concurrent writers; this per-target check protects out-of-order ones.
      const previousTarget = targets[summary.target]
      const targetDefinition = backupTargetsOf(env).find((t) => t.name === summary.target)
      if (
        targetDefinition &&
        hasValidGenerationMetadata(targetDefinition, previousTarget, env) &&
        Date.parse(previousTarget.at) >= nowMs
      ) {
        continue
      }
      targets[summary.target] = {
        at: nowIso,
        key: summary.key,
        bytes: summary.bytes,
        sha256: summary.sha256,
        ...(summary.accountId ? { accountId: summary.accountId } : {}),
        ...(summary.databaseId ? { databaseId: summary.databaseId } : {}),
      }
    }
    const at =
      Object.values(targets)
        .map((target) => target.at)
        .filter(isIsoDate)
        .sort()
        .at(-1) ?? nowIso
    const unsignedManifest = { at, summaries, targets }
    let manifest:
      | typeof unsignedManifest
      | (typeof unsignedManifest & {
          signatureAlgorithm: typeof BACKUP_SIGNATURE_ALGORITHM
          signature: string
        }) = unsignedManifest
    if (env.BACKUP_SIGNING_PRIVATE_KEY) {
      if (!env.BACKUP_SIGNING_PUBLIC_KEY) throw new Error('backup_signing_key_invalid')
      try {
        const signature = await signBackupManifest(unsignedManifest, env.BACKUP_SIGNING_PRIVATE_KEY)
        if (
          !(await verifyBackupManifest(unsignedManifest, signature, env.BACKUP_SIGNING_PUBLIC_KEY))
        ) {
          throw new Error('key pair mismatch')
        }
        manifest = {
          ...unsignedManifest,
          signatureAlgorithm: BACKUP_SIGNATURE_ALGORITHM,
          signature,
        }
      } catch {
        // Do not publish a manifest that this Worker cannot verify on its next
        // invocation. The public half is configuration, but the private half
        // must never be echoed into the error or logs.
        throw new Error('backup_signing_key_invalid')
      }
    } else if (env.APP_ENV !== 'development') {
      throw new Error('backup_signing_key_missing')
    }
    const written = await env.BACKUPS.put(LATEST_KEY, JSON.stringify(manifest), {
      onlyIf: previousObject ? { etagMatches: previousObject.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        kind: 'latest-manifest',
        accountId: env.CF_ACCOUNT_ID,
        bucketName: env.BACKUP_BUCKET_NAME,
      },
    })
    if (written) return
  }
  throw new Error('latest_manifest_conflict')
}

/** 全ターゲットをバックアップし finalizeBackup で通知 + latest.json 更新(一発実行版)。 */
export async function performBackup(
  env: Bindings,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<BackupSummary[]> {
  // 対象は互いに独立なので並行にバックアップする(壁時計 = 最遅ターゲット)。
  const summaries: BackupSummary[] = await Promise.all(
    backupTargetsOf(env).map((t) => backupTarget(env, t, now, fetchImpl)),
  )
  await finalizeBackup(env, now, summaries)
  return summaries
}

/** 鮮度チェック: latest.json が閾値超で ops.backup_stale。 */
export async function checkFreshness(env: Bindings, now: Date): Promise<boolean> {
  let latest: LatestBackup | null
  try {
    latest = await readLatestBackup(env)
  } catch (error) {
    // A failure to read latest.json is not equivalent to "no warning". Keep
    // the scheduled fan-out alive, but leave an explicit monitor failure in
    // the operator channel so an R2 outage cannot hide backup staleness.
    console.error('freshness monitor failed')
    await notifyMonitorFailure(env, now, 'freshness', [
      { target: LATEST_KEY, reason: monitorFailureReason(error, 'r2_read_failed') },
    ])
    return true
  }
  const latestIso = latest?.at ?? null
  const configured = backupTargetsOf(env)
  const configuredTargets = configured.map((target) => target.name)
  const targetNames = latestTargetNames(latest, configuredTargets)
  const configuredByName = new Map(configured.map((target) => [target.name, target]))
  const checks = await Promise.all(
    targetNames.map(async (name) => {
      const target = configuredByName.get(name)
      if (!target) return { name, status: 'stale' as const }
      const fresh = await hasFreshLatestTarget(env, target, latest?.targets[name], now)
      return {
        name,
        status:
          fresh === 'unavailable'
            ? ('unavailable' as const)
            : fresh
              ? ('fresh' as const)
              : ('stale' as const),
      }
    }),
  )
  const unavailableTargets = checks
    .filter((check) => check.status === 'unavailable')
    .map((check) => check.name)
  if (unavailableTargets.length > 0) {
    await notifyMonitorFailure(
      env,
      now,
      'freshness',
      unavailableTargets.map((target) => ({ target, reason: 'r2_read_failed' })),
    )
  }
  const staleTargets = checks.filter((check) => check.status === 'stale').map((check) => check.name)
  if (staleTargets.length > 0) {
    await notifyOpsWithFallback(env, {
      id: backupSlotKey('backup_stale', now),
      type: 'ops.backup_stale',
      payload: { latest: latestIso, staleTargets },
    })
    return true
  }
  return unavailableTargets.length > 0
}

/**
 * R2 control-plane drift monitor. Deploy/bootstrap/restore preflights prevent
 * known-bad changes; this scheduled check detects a later dashboard/API change
 * and emits an operator alert instead of silently trusting the binding.
 */
export async function checkR2Policy(
  env: Bindings,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (env.APP_ENV === 'development') return false
  try {
    await checkR2BucketPrivate(
      env.CF_ACCOUNT_ID,
      env.BACKUP_BUCKET_NAME,
      env.R2_POLICY_CHECK_API_TOKEN,
      fetchImpl,
    )
    return false
  } catch (error) {
    console.error('r2 public-access monitor failed')
    await notifyMonitorFailure(env, now, 'r2-public-access', [
      {
        target: env.BACKUP_BUCKET_NAME || 'BACKUPS',
        reason: monitorFailureReason(error, 'r2_policy_check_failed'),
      },
    ])
    return true
  }
}

/**
 * 死活監視: opsTargets の healthBinding を持つサービスの /api/health を並行に叩き、
 * 非 200 / 例外を ops.health_check_failed で通知(1h スロット集約)。
 */
export async function checkHealth(env: Bindings, now: Date): Promise<string[]> {
  const targets = opsTargets(env).flatMap((t) =>
    t.healthBinding ? [{ name: t.name, binding: t.healthBinding }] : [],
  )
  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        const r = await t.binding.fetch(`http://${t.name}/api/health`, {
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        })
        return r.status === 200 ? null : t.name
      } catch {
        return t.name
      }
    }),
  )
  const down = results.filter((n): n is string => n !== null)
  if (down.length > 0) {
    const y = now.toISOString().slice(0, 13) // 時刻スロット(1h)で集約
    await notifyOpsWithFallback(env, {
      id: `health:${y}`,
      type: 'ops.health_check_failed',
      payload: { down },
    })
  }
  return down
}

/**
 * 容量監視: 各対象 D1 の使用バイト数を REST で取得し、閾値(400MB =
 * Free 500MB/DB の 80%)超を `ops.capacity_warning` で通知。取得失敗は per-target で
 * 分離し、他の監視を止めず `ops.monitor_failed` で明示する。冪等キーは日付スロット。
 * fetchImpl は注入可能(テストでモック)。超過した target 名の配列を返す。
 */
export async function checkCapacity(
  env: Bindings,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  type CapacityResult =
    | { status: 'over'; target: string; bytes: number; mb: number }
    | { status: 'ok' }
    | { status: 'failed'; target: string; reason: string }

  // 対象ごとに独立なので並行取得。1 DB の失敗で他の監視を止めないが、
  // 未取得を「容量問題なし」として捨てない。
  const checked = await Promise.all(
    backupTargetsOf(env).map(async (t) => {
      try {
        const cfg: D1ExportConfig = {
          accountId: env.CF_ACCOUNT_ID,
          databaseId: t.databaseId,
          apiToken: env.D1_EXPORT_API_TOKEN,
        }
        const bytes = await fetchD1FileSize(cfg, fetchImpl)
        return isOverCapacity(bytes)
          ? { status: 'over' as const, target: t.name, bytes, mb: bytesToMB(bytes) }
          : { status: 'ok' as const }
      } catch (err) {
        const reason = monitorFailureReason(err, 'd1_size_read_failed')
        console.error('capacity check failed', t.name, reason)
        return {
          status: 'failed' as const,
          target: t.name,
          reason,
        }
      }
    }),
  )
  const results = checked as CapacityResult[]
  const failures = results
    .filter(
      (result): result is Extract<CapacityResult, { status: 'failed' }> =>
        result.status === 'failed',
    )
    .map(({ target, reason }) => ({ target, reason }))
  if (failures.length > 0) await notifyMonitorFailure(env, now, 'capacity', failures)
  const over = results.filter(
    (result): result is Extract<CapacityResult, { status: 'over' }> => result.status === 'over',
  )
  if (over.length > 0) {
    await notifyOpsWithFallback(env, {
      id: capacitySlotKey(now),
      type: 'ops.capacity_warning',
      payload: { over, thresholdMb: bytesToMB(D1_CAPACITY_THRESHOLD_BYTES) },
    })
  }
  return over.map((o) => o.target)
}

// --- Workflow ---

const BACKUP_STEP_RETRIES = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const

// 再実行しても結果が変わらない検証系の失敗。リトライは D1 をブロックする export を
// 無駄に繰り返すだけなので NonRetryableError で即打ち切る。
const NON_RETRYABLE_BACKUP_REASONS = new Set([
  'too_small',
  'too_large',
  'no_schema',
  'no_rows',
  'export_download_empty',
  'export_download_length_unknown',
  'export_download_too_large',
  'export_no_bookmark',
  'export_no_url',
  'export_url_invalid',
  'invalid_utf8',
  'backup_generation_conflict',
])

/**
 * WorkflowStep のうち配線テストに必要な最小面。run() の中身を注入可能な形で
 * 切り出し、step の失敗変換・finalize の呼び出し順をユニットテストできるようにする
 * (実エンジンのリトライ再現はテスト不能なので、こちらの配線だけでも守る)。
 */
export type StepLike = {
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>
}

/**
 * バックアップ Workflow の本体。ターゲットごとに独立した step にする:
 * - step 内で失敗を **throw** するので durable リトライ(30s 指数)が実際に効く
 *   (失敗を summary で握りつぶすと step が常に「成功」してリトライが死文化する)。
 * - 1 ターゲットの失敗が他ターゲットの再実行(= 余計な export での DB ブロック)を
 *   引き起こさない。検証系の失敗はリトライしない(NonRetryableError)。
 * - 通知 + latest.json 更新はリトライ枯渇後の finalize step で 1 回だけ。
 *   個別 target の失敗は他 target の結果と一緒に通知するが、全 target が失敗した
 *   場合は finalize step 自体を失敗させ、通知障害でも Workflow 履歴に durable な
 *   failure を残す。
 */
export async function runBackupWorkflow(
  env: Bindings,
  step: StepLike,
  fetchImpl: typeof fetch = fetch,
): Promise<BackupSummary[]> {
  // now は step の戻り値として確定する(step 外のローカル値は replay で再計算され
  // 決定性が壊れる。step の戻り値は永続化されるので replay しても同じ値)。
  const nowIso = await step.do('resolve now', {}, async () => new Date().toISOString())
  const now = new Date(nowIso)

  const summaries: BackupSummary[] = await Promise.all(
    backupTargetsOf(env).map((t) =>
      step
        .do(`backup ${t.name}`, BACKUP_STEP_RETRIES, async () => {
          const s = await backupTarget(env, t, now, fetchImpl)
          if (!s.ok) {
            const message = `backup_failed:${t.name}:${s.reason ?? 'export_error'}`
            if (s.reason && NON_RETRYABLE_BACKUP_REASONS.has(s.reason)) {
              throw new NonRetryableError(message)
            }
            throw new Error(message)
          }
          return s
        })
        // リトライ枯渇 → 失敗 summary に変換して続行(他ターゲットと finalize は走る)。
        // reason は step が投げた実メッセージから復元する(export_error に潰すと
        // 「ダンプが小さすぎる = データ消失の兆候」が一過性エラーの顔をして届く)。
        .catch((err: unknown) => ({
          target: t.name,
          ok: false,
          reason: backupFailureReason(err),
        })),
    ),
  )

  await step.do('finalize', {}, async () => {
    await finalizeBackup(env, now, summaries)
    if (summaries.length > 0 && summaries.every((summary) => !summary.ok)) {
      throw new Error('all_backup_targets_failed')
    }
  })
  return summaries
}

export class BackupWorkflow extends WorkflowEntrypoint<Bindings> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    await runBackupWorkflow(this.env, step as unknown as StepLike)
  }
}

// --- HTTP (health) + scheduled dispatch ---

const app = new Hono<{ Bindings: Bindings }>()
app.get('/api/health', (c) => c.json({ status: 'ok' as const }))

/**
 * Cron 文字列(**wrangler.jsonc の triggers.crons と 1 字一致必須**)。片方だけ
 * 変えると振り分けが静かに壊れるので、変更時は両方を必ず同時に更新すること。
 */
export const BACKUP_CRON = '0 17,5 * * *' // JST 2:00/14:00
export const MONITOR_CRON = '30 18,6 * * *' // JST 3:30/15:30

/**
 * Cron 振り分け(テスト可能に export):
 *  - BACKUP_CRON = バックアップ Workflow を起動
 *  - MONITOR_CRON = 鮮度 + 死活 + 容量チェック
 */
export async function handleScheduled(
  event: { cron: string },
  env: Bindings,
  now: Date = new Date(),
): Promise<void> {
  if (event.cron === MONITOR_CRON) {
    // 3 チェックは独立(R2 / service binding / REST)なので並行に。1 つが遅延・
    // ハングしても他の警告(特に容量)を道連れにしない。
    await Promise.all([
      checkFreshness(env, now),
      checkHealth(env, now),
      checkCapacity(env, now),
      checkR2Policy(env, now),
    ])
    return
  }
  // wrangler.jsonc とここの定数がズレると監視系がバックアップ枠に化ける。
  // 未知の値は fail closed にして、意図しない export を起動しない。
  if (event.cron !== BACKUP_CRON) {
    console.error('unknown cron (update BACKUP_CRON/MONITOR_CRON with wrangler.jsonc)', event.cron)
    await notifyOpsWithFallback(env, {
      id: `cron_configuration:${event.cron}`,
      type: 'ops.backup_failed',
      payload: { failed: [{ target: 'workflow', reason: 'cron_configuration_failed' }] },
    })
    return
  }
  try {
    await env.BACKUP_WF.create()
  } catch {
    // Workflow の起動自体に失敗すると performBackup 内の失敗通知は一切走らない。
    // ここで通知しないと次の鮮度チェックが stale 判定するまで丸 1 日気づけない。
    console.error('backup workflow create failed')
    await notifyOpsWithFallback(env, {
      id: backupSlotKey('backup_failed', now),
      type: 'ops.backup_failed',
      payload: { failed: [{ target: 'workflow', reason: 'create_failed' }] },
    })
  }
}

export default {
  fetch: app.fetch,
  scheduled: (event: { cron: string }, env: Bindings) => handleScheduled(event, env),
}
