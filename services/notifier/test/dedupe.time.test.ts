/**
 * 通知の**冪等キーと保持期間**のテスト。
 *
 * Queue が無い設計では「同期送信 + 呼び出し側の再送」が前提なので、二重送信を
 * 防ぐのは KV の冪等キー(TTL 24h)だけ。ここが緩むと利用者に同じメールが何通も
 * 届き、逆に厳しすぎると翌日以降の正当な再通知が飛ばなくなる。
 */
import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

const BASE = 'https://notifier.test'
const HEADERS = {
  'content-type': 'application/json',
  'x-internal-key': 'dev-admin-to-notifier-key-000000000000',
  'x-internal-caller': 'admin',
}
const OPS_HEADERS = {
  'content-type': 'application/json',
  'x-internal-key': 'dev-ops-to-notifier-key-000000000000',
  'x-internal-caller': 'ops',
}
const DEDUPE_TTL_SECONDS = 60 * 60 * 24

afterEach(() => vi.restoreAllMocks())

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'user.invited',
    to: 'team@example.com',
    payload: { acceptUrl: 'https://app.test/invite#token=t' },
    ...over,
  }
}

async function send(body: unknown, headers: Record<string, string> = HEADERS) {
  const res = await SELF.fetch(`${BASE}/api/internal/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { status?: string } }
}

describe('冪等キーの保持期間', () => {
  it('送信済みマークは TTL 24h で書かれる(翌日の同一 id は再送できる)', async () => {
    const put = vi.spyOn(env.DEDUPE, 'put')
    const id = `ttl-${crypto.randomUUID()}`
    expect((await send(job(id))).body.status).toBe('sent')

    expect(put).toHaveBeenCalledWith(`admin:${id}`, '1', {
      expirationTtl: DEDUPE_TTL_SECONDS,
    })
  })

  it('同一 id の再送は duplicate(送信手段を呼ばない)', async () => {
    const id = `dup-${crypto.randomUUID()}`
    expect((await send(job(id))).body.status).toBe('sent')
    expect((await send(job(id))).body.status).toBe('duplicate')
  })

  it('id が違えば別の通知として送る(payload が同じでも抑止しない)', async () => {
    const payload = { acceptUrl: 'https://app.test/invite#token=same' }
    expect((await send(job(`a-${crypto.randomUUID()}`, { payload }))).body.status).toBe('sent')
    expect((await send(job(`b-${crypto.randomUUID()}`, { payload }))).body.status).toBe('sent')
  })
})

describe('時刻スロット由来の id(運用アラートの連打防止)', () => {
  it('同じ日次スロットの ops 通知は 1 通だけ、翌日スロットは再び届く', async () => {
    const day1 = `ops.sync_drift:2026-07-10`
    const day2 = `ops.sync_drift:2026-07-11`
    const opsJob = (id: string) =>
      job(id, {
        type: 'ops.sync_drift',
        to: 'ops@example.com',
        payload: { organizationIds: ['o1'], count: 1, failed: [], truncated: false },
      })

    expect((await send(opsJob(day1), HEADERS)).body.status).toBe('sent')
    expect((await send(opsJob(day1), HEADERS)).body.status).toBe('duplicate')
    expect((await send(opsJob(day2), HEADERS)).body.status).toBe('sent')
  })

  it('12h スロットの backup 通知も同様に 1 スロット 1 通', async () => {
    const am = 'ops.backup_failed:2026-07-10:am'
    const pm = 'ops.backup_failed:2026-07-10:pm'
    const backupJob = (id: string) =>
      job(id, {
        type: 'ops.backup_failed',
        to: 'ops@example.com',
        payload: { failed: [{ target: 'admin', reason: 'export_timeout' }] },
      })

    expect((await send(backupJob(am), OPS_HEADERS)).body.status).toBe('sent')
    expect((await send(backupJob(am), OPS_HEADERS)).body.status).toBe('duplicate')
    expect((await send(backupJob(pm), OPS_HEADERS)).body.status).toBe('sent')
  })
})

describe('冪等マークは「送信済み」の証跡である', () => {
  it('送信前には冪等マークを書かない(送信に失敗した id は再送できる)', async () => {
    // 送信失敗時に 502 を返し KV を汚さないことは notifier.integration.test.ts が
    // 見ている。ここでは「送信成功のときだけ put が起きる」順序を固定する。
    const put = vi.spyOn(env.DEDUPE, 'put')
    const id = `order-${crypto.randomUUID()}`
    expect(put).not.toHaveBeenCalled()

    const { body } = await send(job(id))
    expect(body.status).toBe('sent')
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0]?.[0]).toBe(`admin:${id}`)
  })
})
