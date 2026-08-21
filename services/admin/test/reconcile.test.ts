import { describe, expect, it, vi } from 'vitest'
import {
  type AdminOrgRow,
  type DomainOrgRow,
  MAX_RESYNC_PER_RUN,
  reconcileOrgs,
} from '../src/worker/reconcile'

function mirror(over: Partial<DomainOrgRow>): DomainOrgRow {
  return {
    id: 'o1',
    name: 'Org 1',
    plan: 'free',
    isDisabled: false,
    ...over,
  }
}

const okResync = () => vi.fn(async () => true)

describe('reconcileOrgs', () => {
  it('一致していれば再同期も通知もしない', async () => {
    const admins: AdminOrgRow[] = [{ id: 'o1', name: 'Org 1', plan: 'free', isDisabled: false }]
    const resync = okResync()
    const notifyDrift = vi.fn()
    const { drift } = await reconcileOrgs({
      listAdminOrgs: async () => admins,
      listDomainOrgs: async () => [mirror({ id: 'o1' })],
      resync,
      notifyDrift,
    })
    expect(drift).toEqual([])
    expect(resync).not.toHaveBeenCalled()
    expect(notifyDrift).not.toHaveBeenCalled()
  })

  it('欠落・plan 相違・無効化相違を検出して再同期し、1 回だけ通知', async () => {
    const admins: AdminOrgRow[] = [
      { id: 'missing', name: 'M', plan: 'free', isDisabled: false },
      { id: 'planDrift', name: 'P', plan: 'contracted', isDisabled: false },
      { id: 'disabledDrift', name: 'D', plan: 'free', isDisabled: true },
      { id: 'ok', name: 'OK', plan: 'free', isDisabled: false },
    ]
    const domain: DomainOrgRow[] = [
      mirror({ id: 'planDrift', name: 'P', plan: 'free' }),
      mirror({ id: 'disabledDrift', name: 'D', isDisabled: false }),
      mirror({ id: 'ok', name: 'OK', plan: 'free', isDisabled: false }),
    ]
    const resync = okResync()
    const notifyDrift = vi.fn()
    const { drift } = await reconcileOrgs({
      listAdminOrgs: async () => admins,
      listDomainOrgs: async () => domain,
      resync,
      notifyDrift,
    })
    expect([...drift].sort()).toEqual(['disabledDrift', 'missing', 'planDrift'])
    expect(resync).toHaveBeenCalledTimes(3)
    expect(notifyDrift).toHaveBeenCalledTimes(1)
    expect(notifyDrift).toHaveBeenCalledWith({
      drift: ['missing', 'planDrift', 'disabledDrift'],
      failed: [],
      truncated: false,
    })
  })

  it('name 相違もドリフトとして再同期する', async () => {
    const admins: AdminOrgRow[] = [
      { id: 'renamed', name: 'New Name', plan: 'free', isDisabled: false },
    ]
    const resync = okResync()
    const notifyDrift = vi.fn()
    const { drift } = await reconcileOrgs({
      listAdminOrgs: async () => admins,
      listDomainOrgs: async () => [mirror({ id: 'renamed', name: 'Old Name' })],
      resync,
      notifyDrift,
    })
    expect(drift).toEqual(['renamed'])
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('resync 失敗は failed として通知に載る(黙って握りつぶさない)', async () => {
    const admins: AdminOrgRow[] = [
      { id: 'a', name: 'A', plan: 'free', isDisabled: false },
      { id: 'b', name: 'B', plan: 'free', isDisabled: false },
    ]
    const notifyDrift = vi.fn()
    const result = await reconcileOrgs({
      listAdminOrgs: async () => admins,
      listDomainOrgs: async () => [],
      resync: vi.fn(async (o: AdminOrgRow) => o.id !== 'b'),
      notifyDrift,
    })
    expect(result.failed).toEqual(['b'])
    expect(notifyDrift).toHaveBeenCalledWith({ drift: ['a', 'b'], failed: ['b'], truncated: false })
  })

  it('MAX_RESYNC_PER_RUN を超えるドリフトは打ち切り、truncated で通知する', async () => {
    // Workers 無料枠は 1 呼び出し 50 サブリクエスト — 大量ドリフト(例: 復元直後)で
    // 上限を踏んで途中から静かに全滅しないよう、再同期は 1 回の照合で上限までに抑える。
    const admins: AdminOrgRow[] = Array.from({ length: MAX_RESYNC_PER_RUN + 5 }, (_, i) => ({
      id: `o${i}`,
      name: `Org ${i}`,
      plan: 'free',
      isDisabled: false,
    }))
    const resync = okResync()
    const notifyDrift = vi.fn()
    const result = await reconcileOrgs({
      listAdminOrgs: async () => admins,
      listDomainOrgs: async () => [],
      resync,
      notifyDrift,
    })
    expect(result.drift).toHaveLength(MAX_RESYNC_PER_RUN + 5)
    expect(result.truncated).toBe(true)
    expect(resync).toHaveBeenCalledTimes(MAX_RESYNC_PER_RUN)
  })
})
