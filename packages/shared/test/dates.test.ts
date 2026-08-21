import { describe, expect, it } from 'vitest'
import {
  activityStatus,
  isJstFuture,
  isSameJstMonth,
  jstDaysBetween,
  jstPrevMonthKey,
  toJstDateString,
  toJstMonthKey,
} from '../src/dates'

describe('toJstDateString(UTC→JST の日跨ぎ)', () => {
  it('UTC 深夜は JST では翌日になる', () => {
    // 2026-07-10T15:30:00Z = JST 2026-07-11 00:30
    expect(toJstDateString('2026-07-10T15:30:00Z')).toBe('2026-07-11')
    // 2026-07-10T14:59:00Z = JST 2026-07-10 23:59
    expect(toJstDateString('2026-07-10T14:59:00Z')).toBe('2026-07-10')
  })
  it('オフセット無しの日時文字列は UTC として解釈する(実行環境の TZ に依存しない)', () => {
    // ES 仕様ではオフセット無しはホストローカル解釈 — 非 UTC の開発マシンで
    // 日付がずれる罠を塞ぐ(Z 補完の回帰テスト)。
    expect(toJstDateString('2026-07-10T15:30:00')).toBe('2026-07-11')
    expect(toJstDateString('2026-07-10T14:59:00')).toBe('2026-07-10')
  })
})

describe('toJstMonthKey / jstPrevMonthKey(月・年跨ぎ)', () => {
  it('月初 UTC が JST で前月末に戻るケース', () => {
    // 2026-03-01T00:00Z = JST 2026-03-01 09:00 → 3月
    expect(toJstMonthKey('2026-03-01T00:00:00Z')).toBe('2026-03')
    // 2026-02-28T20:00Z = JST 2026-03-01 05:00 → 3月
    expect(toJstMonthKey('2026-02-28T20:00:00Z')).toBe('2026-03')
  })
  it('前月キーは年跨ぎを正しく扱う', () => {
    expect(jstPrevMonthKey('2026-01-15T00:00:00Z')).toBe('2025-12')
    expect(jstPrevMonthKey('2026-03-15T00:00:00Z')).toBe('2026-02')
  })
})

describe('jstDaysBetween / isJstFuture(未来日拒否)', () => {
  it('同日 0・翌日 1(JST 日付で判定)', () => {
    // どちらも JST 2026-07-10(UTC 07-09T15:00 〜 07-10T14:59 の範囲)
    expect(jstDaysBetween('2026-07-09T16:00:00Z', '2026-07-10T14:00:00Z')).toBe(0)
    // JST 07-10 → 07-11
    expect(jstDaysBetween('2026-07-10T00:00:00Z', '2026-07-11T00:00:00Z')).toBe(1)
  })
  it('未来日は拒否対象', () => {
    const now = '2026-07-10T03:00:00Z' // JST 07-10 12:00
    expect(isJstFuture('2026-07-11', now)).toBe(true)
    expect(isJstFuture('2026-07-10', now)).toBe(false)
    expect(isJstFuture('2026-07-09', now)).toBe(false)
  })
})

describe('isSameJstMonth / activityStatus', () => {
  it('今月来院の判定', () => {
    expect(isSameJstMonth('2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')).toBe(true)
    expect(isSameJstMonth('2026-06-30T20:00:00Z', '2026-07-01')).toBe(true) // JST で両方 7 月
  })
  it('稼働状態: ≤30 active / 31-90 dormant / なし・>90 unused', () => {
    const now = '2026-07-10T00:00:00Z'
    expect(activityStatus(null, now)).toBe('unused')
    expect(activityStatus('2026-07-01', now)).toBe('active')
    expect(activityStatus('2026-06-01', now)).toBe('dormant')
    expect(activityStatus('2026-01-01', now)).toBe('unused')
  })
})
