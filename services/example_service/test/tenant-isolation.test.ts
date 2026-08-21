/**
 * テナント分離と認可の**網羅**テスト(絶対ルール 6: 全 DB クエリを organization_id で
 * スコープ)。items.integration.test.ts が代表フローを見るのに対し、ここは
 * 「他テナントのデータに手が届く経路が本当に無いか」を複数テナント・複数ロール・
 * 偽装入力・期限切れトークンの組み合わせで潰す。
 *
 * D1 はテストファイル内で共有されるため、org id は毎回ユニークにする。
 */

import { SELF } from 'cloudflare:test'
import { signAccessToken } from '@app/shared'
import { describe, expect, it } from 'vitest'

const BASE = 'https://example-service.test'
const JSON_HEADERS = { 'content-type': 'application/json' }
const INTERNAL = { ...JSON_HEADERS, 'x-internal-key': 'dev-internal-key' }
const JWT_SECRET = 'dev-jwt-secret-change-me'

const orgId = () => `org-${crypto.randomUUID()}`

/** dev グラント(org 同期行も作られる)でテナントのトークンを取る。 */
async function tokenFor(org: string, role: 'admin' | 'staff' = 'staff'): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ organizationId: org, role }),
  })
  return ((await res.json()) as { token: string }).token
}

function authed(token: string) {
  return { ...JSON_HEADERS, authorization: `Bearer ${token}` }
}

async function createItem(token: string, title: string, body = '') {
  const res = await SELF.fetch(`${BASE}/api/items`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify({ title, body }),
  })
  return { status: res.status, item: (await res.json()) as Record<string, unknown> }
}

async function listItems(token: string) {
  const res = await SELF.fetch(`${BASE}/api/items`, { headers: authed(token) })
  return {
    status: res.status,
    items: (await res.json().catch(() => [])) as Array<{ id: string; title: string }>,
  }
}

describe('複数テナントの相互不可視', () => {
  it('3 テナントが同時に書き込んでも、各自の item しか見えない', async () => {
    const [a, b, c] = [orgId(), orgId(), orgId()]
    const [ta, tb, tc] = await Promise.all([tokenFor(a), tokenFor(b), tokenFor(c)])

    await createItem(ta, 'A-1')
    await createItem(ta, 'A-2')
    await createItem(tb, 'B-1')
    await createItem(tc, 'C-1')

    const listA = await listItems(ta)
    const listB = await listItems(tb)
    const listC = await listItems(tc)

    expect(listA.items.map((i) => i.title).sort()).toEqual(['A-1', 'A-2'])
    expect(listB.items.map((i) => i.title)).toEqual(['B-1'])
    expect(listC.items.map((i) => i.title)).toEqual(['C-1'])
  })

  it('作成された item は必ずトークンの org に紐づく(body で org を偽装できない)', async () => {
    const mine = orgId()
    const victim = orgId()
    await tokenFor(victim) // 被害者 org も存在させる
    const token = await tokenFor(mine)

    // 契約(CreateItem)に organizationId は無いので、送っても strict に無視される
    const res = await SELF.fetch(`${BASE}/api/items`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ title: 'spoof', body: '', organizationId: victim }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()) as { organizationId: string }).toMatchObject({
      organizationId: mine,
    })

    // 被害者側の一覧には現れない
    const victimList = await listItems(await tokenFor(victim))
    expect(victimList.items.some((i) => i.title === 'spoof')).toBe(false)
  })

  it('同一 email・別 org のトークンでもデータは混ざらない(スコープは org のみ)', async () => {
    const [a, b] = [orgId(), orgId()]
    const ta = await signAccessToken(
      { sub: 'same-user', org: a, email: 'same@person.test', role: 'staff' },
      JWT_SECRET,
    )
    const tb = await signAccessToken(
      { sub: 'same-user', org: b, email: 'same@person.test', role: 'staff' },
      JWT_SECRET,
    )
    // 同期行を作る(dev グラント経由)
    await tokenFor(a)
    await tokenFor(b)

    await createItem(ta, 'in-A')
    expect((await listItems(tb)).items).toHaveLength(0)
    expect((await listItems(ta)).items.map((i) => i.title)).toEqual(['in-A'])
  })
})

describe('ロールによる違い(このドメインは role ゲートを持たない)', () => {
  it('staff も admin も items を読み書きできる(仕様の明示 — 将来の role ゲート追加時に気づける)', async () => {
    const org = orgId()
    const staff = await tokenFor(org, 'staff')
    const admin = await tokenFor(org, 'admin')

    expect((await createItem(staff, 'by-staff')).status).toBe(201)
    expect((await createItem(admin, 'by-admin')).status).toBe(201)
    // 同一 org なので互いの item が見える(テナント内は共有)
    expect((await listItems(staff)).items.map((i) => i.title).sort()).toEqual([
      'by-admin',
      'by-staff',
    ])
  })
})

describe('トークンの状態による拒否', () => {
  it('期限切れトークンは 401', async () => {
    const org = orgId()
    await tokenFor(org) // 同期行は作っておく(401 が期限由来だと確定させる)
    const expired = await signAccessToken(
      { sub: 'u', org, email: 'e@x.test', role: 'staff' },
      JWT_SECRET,
      -1,
    )
    expect((await listItems(expired)).status).toBe(401)
  })

  it('別 secret で署名されたトークンは 401(JWT_SECRET 不一致のサービスは通さない)', async () => {
    const org = orgId()
    await tokenFor(org)
    const foreign = await signAccessToken(
      { sub: 'u', org, email: 'e@x.test', role: 'staff' },
      'another-services-secret',
    )
    expect((await listItems(foreign)).status).toBe(401)
  })

  it('Bearer 以外のスキームは 401', async () => {
    const org = orgId()
    const token = await tokenFor(org)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { authorization: `Basic ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('Authorization ヘッダの大文字小文字は問わない', async () => {
    const org = orgId()
    const token = await tokenFor(org)
    const res = await SELF.fetch(`${BASE}/api/items`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('org の状態変化に追従する(毎リクエスト判定)', () => {
  async function upsertOrg(id: string, over: Record<string, unknown> = {}) {
    return SELF.fetch(`${BASE}/api/internal/organizations`, {
      method: 'POST',
      headers: INTERNAL,
      body: JSON.stringify({
        id,
        name: 'Acme',
        plan: 'free',
        isDisabled: false,
        createdAt: new Date().toISOString(),
        ...over,
      }),
    })
  }

  it('無効化 → 403、再有効化 → 200(次のリクエストで即反映)', async () => {
    const org = orgId()
    const token = await tokenFor(org)
    expect((await listItems(token)).status).toBe(200)

    await upsertOrg(org, { isDisabled: true })
    expect((await listItems(token)).status).toBe(403)

    await upsertOrg(org, { isDisabled: false })
    expect((await listItems(token)).status).toBe(200)
  })

  it('未同期の org は 503 not_synced(無効化 403 と区別する)', async () => {
    const unsynced = orgId()
    const token = await signAccessToken(
      { sub: 'u', org: unsynced, email: 'e@x.test', role: 'staff' },
      JWT_SECRET,
    )
    const { status } = await listItems(token)
    expect(status).toBe(503)
  })

  it('無効化されても他テナントは影響を受けない', async () => {
    const [a, b] = [orgId(), orgId()]
    const ta = await tokenFor(a)
    const tb = await tokenFor(b)
    await upsertOrg(a, { isDisabled: true })
    expect((await listItems(ta)).status).toBe(403)
    expect((await listItems(tb)).status).toBe(200)
  })
})

describe('内部 API の鍵ゲート(テナントトークンでは越えられない)', () => {
  it('テナントの JWT では org 同期 upsert を実行できない(401)', async () => {
    const org = orgId()
    const token = await tokenFor(org)
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      method: 'POST',
      headers: authed(token), // x-internal-key なし
      body: JSON.stringify({
        id: org,
        name: 'Hijack',
        plan: 'contracted',
        isDisabled: false,
        createdAt: new Date().toISOString(),
      }),
    })
    expect(res.status).toBe(401)
  })

  it('内部鍵があれば同期一覧を読める(admin の日次照合が使う経路)', async () => {
    const org = orgId()
    await tokenFor(org)
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`, { headers: INTERNAL })
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ id: string }>
    expect(rows.some((r) => r.id === org)).toBe(true)
  })

  it('誤った内部鍵は 401(長さ違いでも一致でもない)', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/organizations`, {
      headers: { ...JSON_HEADERS, 'x-internal-key': 'wrong-key' },
    })
    expect(res.status).toBe(401)
  })
})
