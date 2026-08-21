/**
 * バックアップの純ロジック。HTTP/R2 I/O から分離してテスト可能にする。
 * ここには I/O を持ち込まない。
 */

/**
 * 検証: 空 DB / 破損ダンプを弾く(≥minBytes・CREATE TABLE・sentinel テーブルへの
 * INSERT が 1 件以上)。sentinel はターゲットごとに異なる(例: admin=users)ため、
 * その DB に必ず存在し中身があるはずの表を指定する(別サービスの表名を流用しない)。
 * minBytes の既定は 1,000 — seed 直後の小さな健全 DB(数 KB)を弾かないための床。
 * 運用でダンプサイズの平常値が分かったら per-target に引き上げるとよい。
 * 計算済みバイト長を返すので、呼び出し側で再エンコードしないこと(巨大ダンプの二重
 * メモリ確保を防ぐ)。
 */
export function validateDump(
  sql: string,
  sentinelTable = 'users',
  minBytes = 1_000,
): { ok: boolean; reason?: string; bytes: number } {
  const bytes = new TextEncoder().encode(sql).length
  if (bytes < minBytes) return { ok: false, reason: 'too_small', bytes }
  if (!/CREATE TABLE/i.test(sql)) return { ok: false, reason: 'no_schema', bytes }
  // sentinel テーブルへの INSERT が 1 件以上(空 DB 検知)。
  const re = new RegExp(`INSERT INTO\\s+["'\`]?${sentinelTable}["'\`]?`, 'i')
  if (!re.test(sql)) return { ok: false, reason: 'no_rows', bytes }
  return { ok: true, bytes }
}

/**
 * 世代 prune 計画。世代キー(例 `admin/2026-07-12T02-00-00.sql`)を新しい順に keep 世代
 * だけ残し、超過分の削除対象キーを返す。時刻順は文字列辞書順(ISO 風命名)で担保。
 */
export function prunePlan(keys: string[], keep = 30): string[] {
  const sorted = [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // 降順(新しいものが先頭)
  return sorted.slice(keep)
}

/**
 * 通知の冪等スロットキー(12h 単位)。同一失敗を 12h に 1 回だけ通知するため、
 * job.id をこのスロットから決定的に導出する。UTC 基準・日付 + 午前/午後で分割。
 */
export function backupSlotKey(kind: string, now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const half = now.getUTCHours() < 12 ? 'am' : 'pm'
  return `${kind}:${y}-${m}-${d}:${half}`
}

/**
 * 鮮度判定: latest.json の作成時刻が閾値(既定 13h)より古ければ stale。
 * 閾値の根拠: バックアップは 12h 間隔・鮮度チェックはその +1.5h 後に走るので、
 * 1 回欠落した直後のチェック時点で latest は 13.5h 前。閾値が 13.5h を超える
 * (例: 14h)と、その欠落を検知できるのが翌日のチェック(25.5h 後)までずれ込む。
 * 13h なら欠落を最初のチェックで検知しつつ、正常時(1.5h)には遠く届かない。
 */
export function isStale(latestIso: string | null, now: Date, thresholdHours = 13): boolean {
  if (!latestIso) return true
  const t = Date.parse(latestIso)
  if (Number.isNaN(t)) return true
  const ageMs = now.getTime() - t
  return ageMs > thresholdHours * 60 * 60 * 1000
}

/** 世代オブジェクトキー命名(R2 内でソート可能・人間可読)。 */
export function backupKey(target: string, now: Date): string {
  const iso = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  return `${target}/${iso}.sql`
}

/**
 * D1 容量監視の閾値。Free プランの上限は 500MB/DB。その 80% = 400MB を超えたら
 * `ops.capacity_warning` を出し、上限到達前に手を打てるようにする。
 */
export const D1_CAPACITY_THRESHOLD_BYTES = 400 * 1024 * 1024

/** バイト → MB(小数第 1 位まで)。通知 payload / ログの可読化用。 */
export function bytesToMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

/** 容量超過判定: 使用バイト数が閾値(既定 400MB)を超えていれば true。 */
export function isOverCapacity(bytes: number, threshold = D1_CAPACITY_THRESHOLD_BYTES): boolean {
  return bytes > threshold
}

/**
 * 容量警告の冪等スロットキー(日付単位・UTC)。同一日の複数 Cron(18:30/06:30)で
 * 二重通知しないよう、job.id をこの日付スロットから決定的に導出する。
 */
export function capacitySlotKey(now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `capacity:${y}-${m}-${d}`
}
