import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { NotificationJob } from '@app/contracts'
import { sendNotification } from '@app/shared'
import { Hono } from 'hono'
import { type D1ExportConfig, exportD1Dump, fetchD1FileSize } from './d1-export'
import {
  backupKey,
  backupSlotKey,
  bytesToMB,
  capacitySlotKey,
  D1_CAPACITY_THRESHOLD_BYTES,
  isOverCapacity,
  isStale,
  prunePlan,
  validateDump,
} from './lib/backup'

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
  INTERNAL_KEY: string
  // D1 REST export 用(トークンは D1:Read のみに絞る)。
  CF_ACCOUNT_ID: string
  D1_EXPORT_API_TOKEN: string
  // export 対象 D1 の database_id(本番は実 ID を vars で設定)。
  // フォーク先で対象 DB を増やす場合は `MYSERVICE_DB_ID` のような var を足し、
  // opsTargets() にエントリを追加する。
  ADMIN_DB_ID: string
  // 運用アラートの宛先(検証済みの実メール)。未設定時は 'ops'(dev LogSender 用)。
  OPS_ALERT_EMAIL?: string
}

const LATEST_KEY = 'latest.json'
const KEEP_GENERATIONS = 30

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
  // R2 の世代オブジェクトキー(成功時)。latest.json 経由でリストア手順が実キーを
  // 特定できるように記録する(wrangler に r2 object list が無いため)。
  key?: string
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
function notify(
  env: Bindings,
  job: { id: string; type: NotificationJob['type']; to: string; payload?: Record<string, unknown> },
): Promise<boolean> {
  return sendNotification(env.NOTIFIER, env.INTERNAL_KEY, { payload: {}, ...job })
}

/** アラート宛先(検証済み実メール or dev の 'ops')。 */
function alertTo(env: Bindings): string {
  return env.OPS_ALERT_EMAIL || 'ops'
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
    const dump = await exportD1Dump(cfg, fetchImpl)
    const check = validateDump(dump, target.sentinelTable, target.minBytes)
    if (!check.ok) return { target: target.name, ok: false, reason: check.reason }

    const key = backupKey(target.name, now)
    await env.BACKUPS.put(key, dump)

    // prune: 対象 prefix の世代を列挙し 30 を超える古い分を一括削除
    // (R2Bucket.delete は key 配列を受ける — 逐次 delete の N 往復を避ける)。
    const listed = await env.BACKUPS.list({ prefix: `${target.name}/` })
    const del = prunePlan(
      listed.objects.map((o) => o.key),
      KEEP_GENERATIONS,
    )
    if (del.length > 0) await env.BACKUPS.delete(del)

    // bytes は validateDump が計算済み(巨大ダンプを再エンコードしない)。
    return { target: target.name, ok: true, bytes: check.bytes, key }
  } catch (err) {
    console.error('backup target failed', target.name, err)
    const reason = err instanceof Error && err.message ? err.message : 'export_error'
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
    await notify(env, {
      id: backupSlotKey('backup_failed', now),
      type: 'ops.backup_failed',
      to: alertTo(env),
      payload: { failed: failed.map((f) => ({ target: f.target, reason: f.reason })) },
    })
  }

  // latest.json は成功したターゲットの記録(1 つでも成功していれば鮮度は更新)。
  if (summaries.some((s) => s.ok)) {
    await env.BACKUPS.put(LATEST_KEY, JSON.stringify({ at: now.toISOString(), summaries }), {
      httpMetadata: { contentType: 'application/json' },
    })
  }
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
  const obj = await env.BACKUPS.get(LATEST_KEY)
  let latestIso: string | null = null
  if (obj) {
    try {
      latestIso = (JSON.parse(await obj.text()) as { at?: string }).at ?? null
    } catch {
      latestIso = null
    }
  }
  if (isStale(latestIso, now)) {
    await notify(env, {
      id: backupSlotKey('backup_stale', now),
      type: 'ops.backup_stale',
      to: alertTo(env),
      payload: { latest: latestIso },
    })
    return true
  }
  return false
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
        const r = await t.binding.fetch(`http://${t.name}/api/health`)
        return r.ok ? null : t.name
      } catch {
        return t.name
      }
    }),
  )
  const down = results.filter((n): n is string => n !== null)
  if (down.length > 0) {
    const y = now.toISOString().slice(0, 13) // 時刻スロット(1h)で集約
    await notify(env, {
      id: `health:${y}`,
      type: 'ops.health_check_failed',
      to: alertTo(env),
      payload: { down },
    })
  }
  return down
}

/**
 * 容量監視: 各対象 D1 の使用バイト数を REST で取得し、閾値(400MB =
 * Free 500MB/DB の 80%)超を `ops.capacity_warning` で通知。取得失敗は per-target で
 * 握りつぶす(1 DB のエラーで他の監視を止めない)。冪等キーは日付スロット。
 * fetchImpl は注入可能(テストでモック)。超過した target 名の配列を返す。
 */
export async function checkCapacity(
  env: Bindings,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  // 対象ごとに独立なので並行取得。取得失敗は per-target で握りつぶす。
  const checked = await Promise.all(
    backupTargetsOf(env).map(async (t) => {
      try {
        const cfg: D1ExportConfig = {
          accountId: env.CF_ACCOUNT_ID,
          databaseId: t.databaseId,
          apiToken: env.D1_EXPORT_API_TOKEN,
        }
        const bytes = await fetchD1FileSize(cfg, fetchImpl)
        return isOverCapacity(bytes) ? { target: t.name, bytes, mb: bytesToMB(bytes) } : null
      } catch (err) {
        console.error('capacity check failed', t.name, err)
        return null
      }
    }),
  )
  const over = checked.filter((c): c is { target: string; bytes: number; mb: number } => c !== null)
  if (over.length > 0) {
    await notify(env, {
      id: capacitySlotKey(now),
      type: 'ops.capacity_warning',
      to: alertTo(env),
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
const VALIDATION_REASONS = new Set(['too_small', 'no_schema', 'no_rows'])

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
 *   全 step のエラーをここで吸収するため Workflow インスタンス自体は常に
 *   Complete で終わる — 失敗の観測は通知(best-effort)と latest.json が担う。
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
            if (s.reason && VALIDATION_REASONS.has(s.reason)) throw new NonRetryableError(message)
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
          reason:
            err instanceof Error && err.message
              ? err.message.replace(`backup_failed:${t.name}:`, '')
              : 'export_error',
        })),
    ),
  )

  await step.do('finalize', {}, async () => {
    await finalizeBackup(env, now, summaries)
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
    await Promise.all([checkFreshness(env, now), checkHealth(env, now), checkCapacity(env, now)])
    return
  }
  // wrangler.jsonc とここの定数がズレると監視系がバックアップ枠に化けて静かに
  // 止まる。既定はバックアップ扱いで実害を最小化しつつ、不一致は必ずログに残す。
  if (event.cron !== BACKUP_CRON) {
    console.error('unknown cron (update BACKUP_CRON/MONITOR_CRON with wrangler.jsonc)', event.cron)
  }
  try {
    await env.BACKUP_WF.create()
  } catch (err) {
    // Workflow の起動自体に失敗すると performBackup 内の失敗通知は一切走らない。
    // ここで通知しないと次の鮮度チェックが stale 判定するまで丸 1 日気づけない。
    console.error('backup workflow create failed', err)
    await notify(env, {
      id: backupSlotKey('backup_failed', now),
      type: 'ops.backup_failed',
      to: alertTo(env),
      payload: { failed: [{ target: 'workflow', reason: 'create_failed' }] },
    })
  }
}

export default {
  fetch: app.fetch,
  scheduled: (event: { cron: string }, env: Bindings) => handleScheduled(event, env),
}
