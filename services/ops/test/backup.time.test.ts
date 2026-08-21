/**
 * バックアップ運用の**時刻境界**テスト。
 *
 * 監視は「時計の境目」で誤検知/見逃しが起きる:
 *  - 鮮度閾値ちょうど(13h)は stale か否か
 *  - 12h スロット(am/pm)の切り替わりは 12:00:00Z ちょうどでどちらに属するか
 *  - 容量警告の日次スロットは UTC 日跨ぎでどう変わるか
 *  - 世代キーが「時系列 = 辞書順」を保ち、prune が古い方だけを消すか
 *
 * backup.test.ts の代表ケースに対し、ここは境界と運用シナリオの担当。
 */
import { describe, expect, it } from 'vitest'
import { backupKey, backupSlotKey, capacitySlotKey, isStale, prunePlan } from '../src/lib/backup'

const at = (iso: string) => new Date(iso)
const HOUR = 60 * 60 * 1000

describe('isStale: 鮮度閾値(既定 13h)の境界', () => {
  const now = at('2026-07-10T12:00:00.000Z')

  it('閾値ちょうど(13h 前)は stale ではない', () => {
    expect(isStale(new Date(now.getTime() - 13 * HOUR).toISOString(), now)).toBe(false)
  })

  it('閾値を 1 ミリ秒でも超えたら stale', () => {
    expect(isStale(new Date(now.getTime() - 13 * HOUR - 1).toISOString(), now)).toBe(true)
  })

  it('正常運用(12h 間隔・+1.5h でチェック)は常に fresh', () => {
    // バックアップ 02:00 JST → チェック 03:30 JST(= 1.5h 後)
    expect(isStale(new Date(now.getTime() - 1.5 * HOUR).toISOString(), now)).toBe(false)
  })

  it('1 回欠落した直後のチェック(13.5h 前)は stale として検知できる', () => {
    expect(isStale(new Date(now.getTime() - 13.5 * HOUR).toISOString(), now)).toBe(true)
  })

  it('未来時刻(時計ずれ)は stale ではない', () => {
    expect(isStale(new Date(now.getTime() + HOUR).toISOString(), now)).toBe(false)
  })

  it('latest 不在・壊れた時刻は stale 扱い(fail closed)', () => {
    expect(isStale(null, now)).toBe(true)
    expect(isStale('garbage', now)).toBe(true)
    expect(isStale('', now)).toBe(true)
  })

  it('閾値は明示指定でき、その境界も同じ規則(ちょうどは fresh)', () => {
    expect(isStale(new Date(now.getTime() - 6 * HOUR).toISOString(), now, 6)).toBe(false)
    expect(isStale(new Date(now.getTime() - 6 * HOUR - 1).toISOString(), now, 6)).toBe(true)
  })
})

describe('backupSlotKey: 12h スロット(am/pm)の切り替わり', () => {
  it('11:59:59.999Z は am、12:00:00.000Z から pm', () => {
    expect(backupSlotKey('ops.backup_failed', at('2026-07-10T11:59:59.999Z'))).toBe(
      'ops.backup_failed:2026-07-10:am',
    )
    expect(backupSlotKey('ops.backup_failed', at('2026-07-10T12:00:00.000Z'))).toBe(
      'ops.backup_failed:2026-07-10:pm',
    )
  })

  it('同一スロット内の別時刻は同じキー(12h に 1 回だけ通知)', () => {
    const a = backupSlotKey('k', at('2026-07-10T12:00:00Z'))
    const b = backupSlotKey('k', at('2026-07-10T23:59:59Z'))
    expect(a).toBe(b)
  })

  it('UTC 日跨ぎで別スロットになる', () => {
    expect(backupSlotKey('k', at('2026-07-10T23:59:59Z'))).not.toBe(
      backupSlotKey('k', at('2026-07-11T00:00:00Z')),
    )
    expect(backupSlotKey('k', at('2026-07-11T00:00:00Z'))).toBe('k:2026-07-11:am')
  })

  it('月跨ぎ・年跨ぎでゼロ埋めが崩れない', () => {
    expect(backupSlotKey('k', at('2026-01-01T00:00:00Z'))).toBe('k:2026-01-01:am')
    expect(backupSlotKey('k', at('2025-12-31T23:00:00Z'))).toBe('k:2025-12-31:pm')
  })

  it('kind が違えば別キー(失敗種別ごとに独立して通知)', () => {
    const now = at('2026-07-10T01:00:00Z')
    expect(backupSlotKey('ops.backup_failed', now)).not.toBe(backupSlotKey('ops.backup_stale', now))
  })
})

describe('capacitySlotKey: 容量警告の日次スロット(UTC)', () => {
  it('同一 UTC 日の 2 回の Cron(18:30/06:30 相当)は同じキー', () => {
    expect(capacitySlotKey(at('2026-07-10T06:30:00Z'))).toBe(
      capacitySlotKey(at('2026-07-10T18:30:00Z')),
    )
  })

  it('23:59:59.999Z と 00:00:00.000Z は別日', () => {
    expect(capacitySlotKey(at('2026-07-10T23:59:59.999Z'))).toBe('capacity:2026-07-10')
    expect(capacitySlotKey(at('2026-07-11T00:00:00.000Z'))).toBe('capacity:2026-07-11')
  })

  it('年末年始もゼロ埋めが崩れない', () => {
    expect(capacitySlotKey(at('2026-12-31T23:00:00Z'))).toBe('capacity:2026-12-31')
    expect(capacitySlotKey(at('2027-01-01T00:00:00Z'))).toBe('capacity:2027-01-01')
  })
})

describe('backupKey: 世代キーは「時系列 = 辞書順」', () => {
  it('コロンを含まないソート可能な命名(ミリ秒は落とす)', () => {
    expect(backupKey('admin', at('2026-07-10T02:00:00.123Z'))).toBe('admin/2026-07-10T02-00-00.sql')
  })

  it('時系列に並べた世代は文字列ソートでも同じ順になる', () => {
    const times = [
      '2026-01-01T02-00-00',
      '2026-07-10T02-00-00',
      '2026-07-10T14-00-00',
      '2026-12-31T14-00-00',
      '2027-01-01T02-00-00',
    ]
    const keys = times.map((t) =>
      backupKey('admin', at(`${t.replace(/-(\d{2})-(\d{2})$/, ':$1:$2')}Z`)),
    )
    expect([...keys].sort()).toEqual(keys)
  })

  it('ターゲットごとに接頭辞が分かれる(prune が他 DB を巻き込まない)', () => {
    const now = at('2026-07-10T02:00:00Z')
    expect(backupKey('admin', now).startsWith('admin/')).toBe(true)
    expect(backupKey('booking', now).startsWith('booking/')).toBe(true)
  })
})

describe('prunePlan: 世代保持(時系列との組み合わせ)', () => {
  /** 12h 間隔で n 世代のキーを作る(古い順)。 */
  function generations(n: number, start = at('2026-01-01T02:00:00Z')): string[] {
    return Array.from({ length: n }, (_, i) =>
      backupKey('admin', new Date(start.getTime() + i * 12 * HOUR)),
    )
  }

  it('31 世代なら最古の 1 件だけが削除対象', () => {
    const keys = generations(31)
    expect(prunePlan(keys, 30)).toEqual([keys[0]])
  })

  it('60 世代なら古い 30 件が削除対象(新しい 30 件が残る)', () => {
    const keys = generations(60)
    const deleted = prunePlan(keys, 30)
    expect(deleted).toHaveLength(30)
    // 削除対象は「古い方の 30 件」(戻り値は新しい順なので集合として比較する)
    expect([...deleted].sort()).toEqual(keys.slice(0, 30).sort())
  })

  it('入力順に依存しない(シャッフルしても同じ結果)', () => {
    const keys = generations(35)
    const shuffled = [...keys].reverse()
    expect(prunePlan(shuffled, 30).sort()).toEqual(prunePlan(keys, 30).sort())
  })

  it('keep 以下なら削除しない / keep=0 なら全件削除', () => {
    const keys = generations(5)
    expect(prunePlan(keys, 30)).toEqual([])
    expect(prunePlan(keys, 0)).toHaveLength(5)
  })

  it('年跨ぎの世代でも新しい方が残る', () => {
    const keys = [
      backupKey('admin', at('2025-12-31T14:00:00Z')),
      backupKey('admin', at('2026-01-01T02:00:00Z')),
    ]
    expect(prunePlan(keys, 1)).toEqual([keys[0]])
  })
})
