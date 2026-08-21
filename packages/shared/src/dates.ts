/**
 * JST 業務日付ユーティリティ。
 *
 * 業務日付・集計境界(「今月」「前月比」「未来日拒否」など)は
 * すべて Asia/Tokyo で判定する。Cloudflare の実行環境は UTC なので、日付比較は
 * 必ずこのモジュール経由で行い、`new Date()` の getMonth() 等を直呼びしないこと。
 *
 * 実装は UTC からの固定オフセット +9h。JST は夏時間がないため固定で正しい。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * ISO 文字列を UTC として解釈して parse する。ES 仕様では「オフセット無しの
 * 日時文字列」(例 '2026-07-10T14:59:00')は**ホストのローカルタイム**として
 * 解釈される — Workers(UTC)では偶然正しいが、非 UTC の開発マシン(node)だと
 * 同じ入力で日付がずれる。オフセット無しは 'Z' を補って実行環境非依存にする。
 */
function parseAsUtc(input: string): Date {
  const offsetless = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(input)
  return new Date(offsetless ? `${input}Z` : input)
}

/** ISO 文字列 or Date を JST のローカル日付 `YYYY-MM-DD` に変換。 */
export function toJstDateString(input: string | Date): string {
  const ms = (typeof input === 'string' ? parseAsUtc(input) : input).getTime()
  if (Number.isNaN(ms)) throw new Error(`invalid date: ${String(input)}`)
  const shifted = new Date(ms + JST_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** JST の年月 `YYYY-MM`(月次集計キー)。 */
export function toJstMonthKey(input: string | Date): string {
  return toJstDateString(input).slice(0, 7)
}

/** JST の「今日」を跨いだ日数差(a, b は日付 or ISO)。同日=0、翌日=1。 */
export function jstDaysBetween(a: string | Date, b: string | Date): number {
  const da = Date.parse(`${toJstDateString(a)}T00:00:00Z`)
  const db = Date.parse(`${toJstDateString(b)}T00:00:00Z`)
  return Math.round((db - da) / (24 * 60 * 60 * 1000))
}

/** `date` が `now`(既定は実時刻)より JST 日付で未来なら true(未来日拒否に使う)。 */
export function isJstFuture(date: string | Date, now: string | Date = new Date()): boolean {
  return jstDaysBetween(now, date) > 0
}

/** JST で同一月か(「今月」の判定)。 */
export function isSameJstMonth(a: string | Date, b: string | Date): boolean {
  return toJstMonthKey(a) === toJstMonthKey(b)
}

/**
 * `now` の JST 前月キー `YYYY-MM`(前月比)。月・年跨ぎを正しく扱う。
 */
export function jstPrevMonthKey(now: string | Date = new Date()): string {
  const key = toJstMonthKey(now)
  const parts = key.split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }
  return `${prev.y}-${String(prev.m).padStart(2, '0')}`
}

/**
 * 稼働状態。最終活動日時からの JST 日数で判定(閾値はドメイン要件に合わせて調整)。
 * - active: ≤activeDays / dormant: activeDays+1〜dormantDays / unused: 活動なし or >dormantDays
 */
export function activityStatus(
  lastActiveAt: string | null,
  now: string | Date = new Date(),
  { activeDays = 30, dormantDays = 90 } = {},
): 'active' | 'dormant' | 'unused' {
  if (!lastActiveAt) return 'unused'
  const days = jstDaysBetween(lastActiveAt, now)
  if (days <= activeDays) return 'active'
  if (days <= dormantDays) return 'dormant'
  return 'unused'
}
