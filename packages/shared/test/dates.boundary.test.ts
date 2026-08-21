/**
 * JST 日付ユーティリティの**境界値**テスト。
 *
 * dates.test.ts が代表ケースを押さえるのに対し、ここは「1 ミリ秒ずれると業務日付が
 * 変わる」境目・うるう年・年跨ぎ・負の日数など、事故が起きる側を網羅する。
 * 時刻に依存する関数は必ず `now` を明示注入し、実時刻に依存させない。
 */
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

describe('toJstDateString: JST 日跨ぎの境界(15:00:00Z ちょうど)', () => {
  it('14:59:59.999Z は当日、15:00:00.000Z から翌日', () => {
    expect(toJstDateString('2026-07-10T14:59:59.999Z')).toBe('2026-07-10')
    expect(toJstDateString('2026-07-10T15:00:00.000Z')).toBe('2026-07-11')
  })

  it('Date オブジェクトでも文字列と同じ結果になる', () => {
    const d = new Date('2026-07-10T15:00:00.000Z')
    expect(toJstDateString(d)).toBe(toJstDateString('2026-07-10T15:00:00.000Z'))
  })

  it('日付のみの文字列は UTC 00:00 として扱われ、JST でも同じ日付になる', () => {
    // '2026-07-10' = 2026-07-10T00:00Z = JST 09:00 → 同日
    expect(toJstDateString('2026-07-10')).toBe('2026-07-10')
  })

  it('不正な日付は throw する(黙って NaN 日付を作らない)', () => {
    expect(() => toJstDateString('not-a-date')).toThrow(/invalid date/)
    expect(() => toJstDateString(new Date(Number.NaN))).toThrow(/invalid date/)
  })

  it('うるう年 2028-02-29 を跨ぐ境界', () => {
    expect(toJstDateString('2028-02-28T15:00:00Z')).toBe('2028-02-29')
    expect(toJstDateString('2028-02-29T15:00:00Z')).toBe('2028-03-01')
  })

  it('年跨ぎ(大晦日 15:00Z = JST 元日)', () => {
    expect(toJstDateString('2026-12-31T14:59:59Z')).toBe('2026-12-31')
    expect(toJstDateString('2026-12-31T15:00:00Z')).toBe('2027-01-01')
  })
})

describe('toJstMonthKey: 月境界', () => {
  it('月末 15:00Z は翌月の月キーになる', () => {
    expect(toJstMonthKey('2026-07-31T14:59:59Z')).toBe('2026-07')
    expect(toJstMonthKey('2026-07-31T15:00:00Z')).toBe('2026-08')
  })
  it('Date 入力も同じ', () => {
    expect(toJstMonthKey(new Date('2026-07-31T15:00:00Z'))).toBe('2026-08')
  })
})

describe('jstPrevMonthKey: 年跨ぎ・月末起点', () => {
  it('1 月起点は前年 12 月', () => {
    expect(jstPrevMonthKey('2026-01-01T00:00:00Z')).toBe('2025-12')
  })
  it('3 月起点は 2 月(うるう年でもキーは月単位)', () => {
    expect(jstPrevMonthKey('2028-03-31T00:00:00Z')).toBe('2028-02')
  })
  it('JST で翌月に繰り上がる時刻を起点にすると前月も 1 つずれる', () => {
    // 2026-07-31T15:00Z は JST 8/1 → 前月キーは 7 月
    expect(jstPrevMonthKey('2026-07-31T15:00:00Z')).toBe('2026-07')
    // 同 14:59Z は JST 7/31 → 前月キーは 6 月
    expect(jstPrevMonthKey('2026-07-31T14:59:59Z')).toBe('2026-06')
  })
})

describe('jstDaysBetween: 符号と跨ぎ日数', () => {
  it('過去方向は負の値になる', () => {
    expect(jstDaysBetween('2026-07-11T00:00:00Z', '2026-07-10T00:00:00Z')).toBe(-1)
  })
  it('時刻差が 24h 未満でも JST 日付が変われば 1 日', () => {
    // JST 7/10 23:59 → JST 7/11 00:00(実時間差 1 分)
    expect(jstDaysBetween('2026-07-10T14:59:00Z', '2026-07-10T15:00:00Z')).toBe(1)
  })
  it('うるう年 2 月を跨ぐ日数', () => {
    expect(jstDaysBetween('2028-02-28', '2028-03-01')).toBe(2) // 2/29 が存在する
    expect(jstDaysBetween('2027-02-28', '2027-03-01')).toBe(1) // 平年
  })
  it('1 年(平年)は 365 日', () => {
    expect(jstDaysBetween('2026-01-01', '2027-01-01')).toBe(365)
  })
})

describe('isJstFuture: 未来日拒否の境界', () => {
  const now = '2026-07-10T14:59:59Z' // JST 7/10 23:59:59

  it('同日は未来ではない(時刻が先でも日付が同じなら false)', () => {
    expect(isJstFuture('2026-07-10T15:00:00Z', '2026-07-10T00:00:00Z')).toBe(true) // JST 7/11
    expect(isJstFuture('2026-07-10T14:00:00Z', now)).toBe(false)
  })
  it('JST の日付が 1 日でも先なら true', () => {
    expect(isJstFuture('2026-07-11', now)).toBe(true)
  })
  it('過去日は false', () => {
    expect(isJstFuture('2026-07-09', now)).toBe(false)
  })
})

describe('isSameJstMonth: 月境界', () => {
  it('UTC では別月でも JST で同月なら true', () => {
    // 2026-06-30T15:00Z = JST 7/1
    expect(isSameJstMonth('2026-06-30T15:00:00Z', '2026-07-20')).toBe(true)
  })
  it('JST で月が変われば false', () => {
    expect(isSameJstMonth('2026-06-30T14:59:00Z', '2026-07-01')).toBe(false)
  })
})

describe('activityStatus: 閾値ちょうどの分岐', () => {
  const now = '2026-07-10T00:00:00Z'

  it('30 日ちょうどは active、31 日で dormant', () => {
    expect(activityStatus('2026-06-10', now)).toBe('active') // 30 日
    expect(activityStatus('2026-06-09', now)).toBe('dormant') // 31 日
  })
  it('90 日ちょうどは dormant、91 日で unused', () => {
    expect(activityStatus('2026-04-11', now)).toBe('dormant') // 90 日
    expect(activityStatus('2026-04-10', now)).toBe('unused') // 91 日
  })
  it('未活動(null)は unused', () => {
    expect(activityStatus(null, now)).toBe('unused')
  })
  it('同日の活動は active(0 日)', () => {
    expect(activityStatus('2026-07-10T00:00:00Z', now)).toBe('active')
  })
  it('閾値はドメインごとに上書きできる', () => {
    expect(activityStatus('2026-07-03', now, { activeDays: 7, dormantDays: 14 })).toBe('active')
    expect(activityStatus('2026-07-02', now, { activeDays: 7, dormantDays: 14 })).toBe('dormant')
    expect(activityStatus('2026-06-25', now, { activeDays: 7, dormantDays: 14 })).toBe('unused')
  })
  it('未来の活動日時(時計ずれ)は負の日数 → active に倒れる', () => {
    // クライアント時計のずれで未来日が来ても unused には落とさない(誤って
    // 「使われていない」と判定して機能を止めないため)。
    expect(activityStatus('2026-07-20', now)).toBe('active')
  })
})
