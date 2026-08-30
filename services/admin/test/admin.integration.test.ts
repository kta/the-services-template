import { env, SELF } from 'cloudflare:test'
import { signAccessToken, verifyAccessToken } from '@app/shared'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JWT_TEST_PRIVATE_KEY, JWT_TEST_PUBLIC_KEY } from '../../../packages/shared/test/jwt-keys'
import { refresh as refreshSvc } from '../src/worker/auth/service'
import { loginRateLimits, organizations, refreshTokens, users } from '../src/worker/db/schema'
import worker from '../src/worker/index'

const BASE = 'https://admin.test'
const JSON_HEADERS = { 'content-type': 'application/json' }
const TEST_PRIVATE_KEY =
  (env as typeof env & { AUTH_DEV_PRIVATE_KEY?: string }).AUTH_DEV_PRIVATE_KEY ||
  JWT_TEST_PRIVATE_KEY
const TEST_PUBLIC_KEY = env.JWT_PUBLIC_KEY || JWT_TEST_PUBLIC_KEY

afterEach(() => vi.restoreAllMocks())

// --- helpers ---
async function adminToken(orgId = 'admin-org'): Promise<string> {
  // dev グラント(AUTH_DEV_GRANT=true)。運営 org 行も upsert される。
  const res = await SELF.fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ organizationId: orgId, role: 'admin' }),
  })
  return ((await res.json()) as { token: string }).token
}
function authed(token: string, body?: unknown) {
  return {
    method: 'POST' as const,
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }
}
async function createOrg(token: string, name = 'Org', plan?: string) {
  const res = await SELF.fetch(
    `${BASE}/api/organizations`,
    authed(token, { name, ...(plan ? { plan } : {}) }),
  )
  return (await res.json()) as { id: string; name: string; plan: string }
}
async function invite(token: string, orgId: string, email: string, role?: string) {
  const res = await SELF.fetch(
    `${BASE}/api/organizations/${orgId}/invitations`,
    authed(token, { email, ...(role ? { role } : {}) }),
  )
  return {
    status: res.status,
    body: (await res.json()) as { emailed: boolean; acceptUrl?: string; error?: string },
  }
}
function tokenFromUrl(url: string): string {
  const parsed = new URL(url)
  return (
    new URLSearchParams(parsed.hash.slice(1)).get('token') ?? parsed.searchParams.get('token') ?? ''
  )
}
/** set-cookie から refresh トークン("rt=<v>" の v)を取り出す。 */
function refreshFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(/(?:^|,\s*)rt=([^;]*)/)
  return m?.[1] ?? ''
}
async function publicLogin(email: string, stretched: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, stretched }),
  })
  return {
    status: res.status,
    res,
    refreshToken: refreshFrom(res),
    body: (await res
      .clone()
      .json()
      .catch(() => ({}))) as Record<string, unknown>,
  }
}
async function publicRefresh(refreshToken: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { cookie: `rt=${refreshToken}` },
  })
  return {
    status: res.status,
    res,
    refreshToken: refreshFrom(res),
    body: (await res
      .clone()
      .json()
      .catch(() => ({}))) as Record<string, unknown>,
  }
}
async function acceptInvite(inviteToken: string, email: string, stretched: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/accept-invite`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token: inviteToken, email, stretched }),
  })
  return {
    status: res.status,
    res,
    body: (await res
      .clone()
      .json()
      .catch(() => ({}))) as Record<string, unknown>,
  }
}
/** create org → invite → accept-invite(public)まで。 */
async function provision(email: string, stretched: string): Promise<{ orgId: string }> {
  const tok = await adminToken()
  const org = await createOrg(tok, 'Org')
  const inv = await invite(tok, org.id, email)
  const accepted = await acceptInvite(tokenFromUrl(inv.body.acceptUrl ?? ''), email, stretched)
  expect(accepted.status).toBe(200)
  return { orgId: org.id }
}

describe('admin API auth gate (default-deny + operator)', () => {
  it('401 without a token', async () => {
    const res = await SELF.fetch(`${BASE}/api/organizations`)
    expect(res.status).toBe(401)
  })
  it('403 for a staff token', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/token`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ organizationId: 'o1', role: 'staff' }),
    })
    const staff = ((await res.json()) as { token: string }).token
    const listed = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${staff}` },
    })
    expect(listed.status).toBe(403)
  })
  it('テナント org の admin は 403 operator_only(クロステナント権限昇格の遮断)', async () => {
    // 運営者がテナント org を作り、その org の admin を招待して成立させる
    const op = await adminToken()
    const tenant = await createOrg(op, 'Tenant Co')
    const inv = await invite(op, tenant.id, 'tadmin@tenant.test', 'admin')
    const accepted = await acceptInvite(
      tokenFromUrl(inv.body.acceptUrl ?? ''),
      'tadmin@tenant.test',
      'pw-stretched',
    )
    expect(accepted.status).toBe(200)
    const tenantAdminToken = accepted.body.token as string
    // テナント admin は組織管理 API を使えない
    const listed = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${tenantAdminToken}` },
    })
    expect(listed.status).toBe(403)
    expect(((await listed.json()) as { error: string }).error).toBe('operator_only')
  })
  it('health needs no auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('無効化済みの運営 org は既発行 access token でも管理 API を使えない', async () => {
    const orgId = `disabled-operator-${crypto.randomUUID()}`
    const token = await adminToken(orgId)
    const disabled = await SELF.fetch(`${BASE}/api/organizations/${orgId}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ isDisabled: true }),
    })
    expect(disabled.status).toBe(200)

    const listed = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(listed.status).toBe(403)
    expect(((await listed.json()) as { error: string }).error).toBe('operator_only')
  })

  it('管理 JWT の sub と role を users の最新状態へ照合する', async () => {
    const orgId = `live-operator-${crypto.randomUUID()}`
    const userId = `live-user-${crypto.randomUUID()}`
    const email = `${userId}@admin.test`
    const now = new Date().toISOString()
    await drizzle(env.DB).insert(organizations).values({
      id: orgId,
      name: 'Live Operator',
      plan: 'contracted',
      isDisabled: '0',
      isOperator: '1',
      version: 1,
      createdAt: now,
    })
    await drizzle(env.DB).insert(users).values({
      id: userId,
      organizationId: orgId,
      email,
      passwordHash: 'hmac$test',
      role: 'admin',
      createdAt: now,
    })
    const sessionId = crypto.randomUUID()
    const token = await signAccessToken(
      { sub: userId, org: orgId, email, role: 'admin', sid: sessionId },
      TEST_PRIVATE_KEY,
    )
    await drizzle(env.DB)
      .insert(refreshTokens)
      .values({
        id: sessionId,
        userId,
        organizationId: orgId,
        tokenHash: `permission-test-${crypto.randomUUID()}`,
        expiresAt: '2999-01-01T00:00:00.000Z',
        rotatedTo: null,
        revokedAt: null,
        createdAt: now,
      })

    expect(
      (
        await SELF.fetch(`${BASE}/api/organizations`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)

    await drizzle(env.DB).update(users).set({ role: 'staff' }).where(eq(users.id, userId))
    const downgraded = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(downgraded.status).toBe(403)
    expect(((await downgraded.json()) as { error: string }).error).toBe('operator_only')
  })
})

describe('domain live-session introspection', () => {
  it('returns active role, then reflects logout immediately', async () => {
    const operator = await adminToken()
    const email = `live-domain-${crypto.randomUUID()}@admin.test`
    const invitation = await invite(operator, 'admin-org', email, 'admin')
    const accepted = await acceptInvite(
      tokenFromUrl(invitation.body.acceptUrl ?? ''),
      email,
      'live-domain-password',
    )
    expect(accepted.status).toBe(200)
    const accessToken = accepted.body.token as string
    const claims = await verifyAccessToken(accessToken, TEST_PUBLIC_KEY)
    expect(claims?.sid).toBeTruthy()
    const input = { sid: claims?.sid, sub: claims?.sub, org: claims?.org }

    const check = await SELF.fetch(`${BASE}/api/internal/auth/session`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'x-internal-key': 'dev-domain-to-admin-key-000000000000',
        'x-internal-caller': 'domain',
      },
      body: JSON.stringify(input),
    })
    expect(check.status).toBe(200)
    expect(await check.json()).toEqual({ active: true, role: 'admin' })

    const refreshToken = refreshFrom(accepted.res)
    const logout = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `rt=${refreshToken}` },
    })
    expect(logout.status).toBe(200)

    const after = await SELF.fetch(`${BASE}/api/internal/auth/session`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'x-internal-key': 'dev-domain-to-admin-key-000000000000',
        'x-internal-caller': 'domain',
      },
      body: JSON.stringify(input),
    })
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ active: false, role: null })
  })

  it('requires the domain caller marker in addition to the dedicated key', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/auth/session`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-internal-key': 'dev-domain-to-admin-key-000000000000' },
      body: JSON.stringify({ sid: 's', sub: 'u', org: 'o' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('organizations (operator-protected)', () => {
  it('non-auth JSON endpoints reject oversized bodies before parsing', async () => {
    const token = await adminToken(`large-body-${crypto.randomUUID()}`)
    const res = await SELF.fetch(
      `${BASE}/api/organizations`,
      authed(token, { name: 'bounded', padding: 'x'.repeat(70_000) }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('creates an org, persists it, and syncs to example_service', async () => {
    const fetchSpy = vi
      .spyOn(env.EXAMPLE_SERVICE, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    const token = await adminToken()
    const org = await createOrg(token, 'Acme')
    expect(org.name).toBe('Acme')
    expect(org.plan).toBe('free')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const arg = fetchSpy.mock.calls[0]?.[0]
    expect(String(typeof arg === 'string' ? arg : (arg as Request).url)).toContain(
      '/api/internal/organizations',
    )

    const list = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const rows = (await list.json()) as Array<{ name: string }>
    expect(rows.some((r) => r.name === 'Acme')).toBe(true)
  })

  it('rejects an empty name with 400', async () => {
    const token = await adminToken()
    const res = await SELF.fetch(`${BASE}/api/organizations`, authed(token, { name: '' }))
    expect(res.status).toBe(400)
  })

  it('still returns 201 when the sync fails (best-effort)', async () => {
    vi.spyOn(env.EXAMPLE_SERVICE, 'fetch').mockResolvedValue(
      new Response('err', { status: 500 }) as never,
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const org = await createOrg(await adminToken(), 'BestEffort')
    expect(org.name).toBe('BestEffort')
  })

  it('DELETE disables the org (audit row kept) and re-syncs', async () => {
    const spy = vi
      .spyOn(env.EXAMPLE_SERVICE, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    const token = await adminToken()
    const org = await createOrg(token, 'ToDelete')
    const res = await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: org.id, isDisabled: true, synced: true })
    // create + delete → 2 sync upserts
    expect(spy).toHaveBeenCalledTimes(2)
    // org は無効化されて一覧に残る(監査のため物理削除しない)
    const list = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const rows = (await list.json()) as Array<{ id: string; isDisabled: boolean }>
    expect(rows.find((r) => r.id === org.id)?.isDisabled).toBe(true)
  })

  it('PATCH updates plan and re-syncs (single UPDATE..RETURNING)', async () => {
    const token = await adminToken()
    const org = await createOrg(token, 'Planned')
    const res = await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: 'contracted' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { plan: string }).plan).toBe('contracted')
  })

  it('PATCH unknown org is 404', async () => {
    const token = await adminToken()
    const res = await SELF.fetch(`${BASE}/api/organizations/nope`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: 'contracted' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('invitations', () => {
  it('does not issue a new invitation for a disabled organization', async () => {
    const token = await adminToken()
    const org = await createOrg(token, 'DisabledInviteCo')
    const disabled = await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(disabled.status).toBe(200)

    const result = await invite(token, org.id, 'disabled-invite@org.test')
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('org_disabled')
  })

  it('returns the acceptUrl when notify fails (link fallback), based on the request origin', async () => {
    const token = await adminToken()
    const org = await createOrg(token, 'InviteCo')
    const { status, body } = await invite(token, org.id, 'staff@org.test')
    expect(status).toBe(201)
    expect(body.emailed).toBe(false) // NOTIFIER stub → 404
    // INVITE_BASE_URL 未設定 → リクエスト origin から導出(localhost 固定ではない)
    expect(body.acceptUrl).toContain(`${BASE}/invite#token=`)
  })

  it('別 org に既存の email への招待は 409 email_taken(乗っ取り防止)', async () => {
    await provision('taken@org.test', 'pw')
    const tok = await adminToken()
    const other = await createOrg(tok, 'OtherOrg')
    const { status, body } = await invite(tok, other.id, 'taken@org.test')
    expect(status).toBe(409)
    expect(body.error).toBe('email_taken')
  })

  it('再招待は旧 pending token を失効させ、最新 token だけを受諾できる', async () => {
    const token = await adminToken()
    const org = await createOrg(token, 'ReinviteCo')
    const first = await invite(token, org.id, 'reinvite@org.test')
    const second = await invite(token, org.id, 'reinvite@org.test')

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(
      (
        await acceptInvite(
          tokenFromUrl(first.body.acceptUrl ?? ''),
          'reinvite@org.test',
          'old-password',
        )
      ).status,
    ).toBe(410)
    expect(
      (
        await acceptInvite(
          tokenFromUrl(second.body.acceptUrl ?? ''),
          'reinvite@org.test',
          'new-password',
        )
      ).status,
    ).toBe(200)
  })

  it('pending user の再招待では role の変更を受諾後の JWT に反映する', async () => {
    const token = await adminToken()
    const org = await createOrg(token, 'ReinviteRoleCo')
    const first = await invite(token, org.id, 'reinvite-role@org.test', 'admin')
    expect(first.status).toBe(201)
    const second = await invite(token, org.id, 'reinvite-role@org.test', 'staff')
    expect(second.status).toBe(201)

    const accepted = await acceptInvite(
      tokenFromUrl(second.body.acceptUrl ?? ''),
      'reinvite-role@org.test',
      'role-password',
    )
    expect(accepted.status).toBe(200)
    expect((accepted.body.user as { role: string }).role).toBe('staff')
  })

  it('既に password がある user は招待受諾で password を上書きできない', async () => {
    const { orgId } = await provision('already-set@org.test', 'original-password')
    const token = await adminToken()
    const reinvite = await invite(token, orgId, 'already-set@org.test')
    expect(reinvite.status).toBe(409)
    expect(reinvite.body.error).toBe('user_exists')
  })
})

describe('auth: login / accept-invite (public)', () => {
  it('認証 JSON の body 上限を超える要求は処理前に 413', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'large@org.test', stretched: 'x'.repeat(20_000) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  it('accept-invite then login succeeds and returns a session', async () => {
    await provision('login@org.test', 'stretched-ok')
    const { status, body, refreshToken } = await publicLogin('login@org.test', 'stretched-ok')
    expect(status).toBe(200)
    expect(typeof body.token).toBe('string')
    expect(body.refreshToken).toBeUndefined() // body には載せない(cookie のみ)
    expect(refreshToken).toBeTruthy()
    expect((body.user as { email: string }).email).toBe('login@org.test')
  })

  it('login with a wrong stretched value is 401', async () => {
    await provision('wrong@org.test', 'stretched-ok')
    const { status } = await publicLogin('wrong@org.test', 'stretched-BAD')
    expect(status).toBe(401)
  })

  it('login for a disabled org is 403 — ただし正しいパスワードのときだけ(列挙オラクル防止)', async () => {
    const tok = await adminToken()
    const org = await createOrg(tok, 'Disabled')
    const inv = await invite(tok, org.id, 'dis@org.test')
    await acceptInvite(tokenFromUrl(inv.body.acceptUrl ?? ''), 'dis@org.test', 's')
    await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${tok}` },
      body: JSON.stringify({ isDisabled: true }),
    })
    // 正しい資格情報 → 403 org_disabled
    const okPw = await publicLogin('dis@org.test', 's')
    expect(okPw.status).toBe(403)
    expect(okPw.body.error).toBe('org_disabled')
    // 誤った資格情報 → 401(org_disabled を漏らさない)
    const badPw = await publicLogin('dis@org.test', 'WRONG')
    expect(badPw.status).toBe(401)
  })

  it('expired/consumed invite is 410', async () => {
    const tok = await adminToken()
    const org = await createOrg(tok, 'Once')
    const inv = await invite(tok, org.id, 'once@org.test')
    const t = tokenFromUrl(inv.body.acceptUrl ?? '')
    expect((await acceptInvite(t, 'once@org.test', 's')).status).toBe(200)
    // second use → consumed → 410
    expect((await acceptInvite(t, 'once@org.test', 's')).status).toBe(410)
  })

  it('accept-invite with an unknown token is 404', async () => {
    const { status } = await acceptInvite('x'.repeat(40), 'x@x.test', 'x')
    expect(status).toBe(404)
  })
})

describe('auth: rate limiting', () => {
  it('locks out after 5 failures', async () => {
    await provision('lock@org.test', 'good')
    for (let i = 0; i < 5; i++) {
      const { status } = await publicLogin('lock@org.test', 'bad')
      expect(status).toBe(401)
    }
    const sixth = await publicLogin('lock@org.test', 'good')
    expect(sixth.status).toBe(429)
    expect(sixth.res.headers.get('Retry-After')).toBeTruthy()
  })

  it('無効 org への正しい資格情報(403)もカウントしロックアウトする', async () => {
    // 403 パスだけ bump しないと、無効 org の有効資格情報を持つ相手に
    // レート制限のかからない probe 経路が残る(レビュー指摘の回帰テスト)。
    const tok = await adminToken()
    const org = await createOrg(tok, 'DisabledLock')
    const inv = await invite(tok, org.id, 'dislock@org.test')
    await acceptInvite(tokenFromUrl(inv.body.acceptUrl ?? ''), 'dislock@org.test', 's')
    await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${tok}` },
      body: JSON.stringify({ isDisabled: true }),
    })
    for (let i = 0; i < 5; i++) {
      const { status } = await publicLogin('dislock@org.test', 's')
      expect(status).toBe(403)
    }
    const sixth = await publicLogin('dislock@org.test', 's')
    expect(sixth.status).toBe(429)
  })
})

describe('auth: refresh rotation + reuse (cookie flow)', () => {
  it('rotates and detects reuse', async () => {
    await provision('rot@org.test', 'good')
    const first = await publicLogin('rot@org.test', 'good')
    const rt1 = first.refreshToken

    const r1 = await publicRefresh(rt1)
    expect(r1.status).toBe(200)
    const rt2 = r1.refreshToken
    expect(rt2).not.toBe(rt1)

    // ローテーション直後(猶予内)の旧トークン再提示 = マルチタブ競合とみなし、
    // 401 のみ(全セッション revoke はしない)。cookie も削除しない。
    const reuse = await publicRefresh(rt1)
    expect(reuse.status).toBe(401)
    expect(reuse.body.error).toBe('rotation_race')
    expect(reuse.res.headers.get('set-cookie')).toBeNull()

    // 巻き添え revoke されていない: 新トークンは引き続き有効
    const after = await publicRefresh(rt2)
    expect(after.status).toBe(200)
  })

  it('猶予(ROTATION_GRACE_SECONDS)を過ぎた旧トークン再提示は盗難扱いで全 revoke', async () => {
    await provision('latereuse@org.test', 'good')
    const first = await publicLogin('latereuse@org.test', 'good')
    const rt1 = first.refreshToken
    const r1 = await publicRefresh(rt1)
    expect(r1.status).toBe(200)

    // 時刻だけ猶予より先に進めた deps で service を直接呼ぶ(SELF は実時刻のため)
    const late = await refreshSvc(
      {
        db: drizzle(env.DB),
        pepper: 'unused',
        jwtPrivateKey: 'unused-private-key',
        now: 4_000_000_000,
      },
      { refreshToken: rt1 ?? '' },
    )
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error).toBe('token_reuse')

    // 後継トークンも巻き添え revoke されている
    const after = await publicRefresh(r1.refreshToken)
    expect(after.status).toBe(401)
  })

  it('refresh with no cookie is 401 / unknown token is 401', async () => {
    const noCookie = await SELF.fetch(`${BASE}/api/auth/refresh`, { method: 'POST' })
    expect(noCookie.status).toBe(401)
    const unknown = await publicRefresh('nope')
    expect(unknown.status).toBe(401)
  })

  it('refresh for a disabled org is 403', async () => {
    const tok = await adminToken()
    const org = await createOrg(tok, 'RefDisabled')
    const inv = await invite(tok, org.id, 'refdis@org.test')
    await acceptInvite(tokenFromUrl(inv.body.acceptUrl ?? ''), 'refdis@org.test', 'g')
    const login = await publicLogin('refdis@org.test', 'g')
    await SELF.fetch(`${BASE}/api/organizations/${org.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${tok}` },
      body: JSON.stringify({ isDisabled: true }),
    })
    const res = await publicRefresh(login.refreshToken)
    expect(res.status).toBe(403)
  })
})

describe('public auth cookie flow', () => {
  it('login sets an HttpOnly refresh cookie and omits it from the body', async () => {
    await provision('cookie@org.test', 'good')
    const { res, body } = await publicLogin('cookie@org.test', 'good')
    expect(body.token).toBeTruthy()
    expect(body.refreshToken).toBeUndefined()
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('rt=')
    expect(setCookie.toLowerCase()).toContain('httponly')
  })

  it('public accept-invite sets the cookie and signs the user in', async () => {
    const tok = await adminToken()
    const org = await createOrg(tok, 'PublicInvite')
    const inv = await invite(tok, org.id, 'pub@org.test')
    const accepted = await acceptInvite(
      tokenFromUrl(inv.body.acceptUrl ?? ''),
      'pub@org.test',
      'good',
    )
    expect(accepted.status).toBe(200)
    expect(accepted.body.token).toBeTruthy()
    expect(accepted.body.refreshToken).toBeUndefined()
    expect((accepted.body.user as { email: string }).email).toBe('pub@org.test')
    const setCookie = accepted.res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('rt=')
    expect(setCookie.toLowerCase()).toContain('httponly')
  })

  it('login → refresh → logout using the cookie', async () => {
    await provision('flow@org.test', 'g')
    const login = await publicLogin('flow@org.test', 'g')
    const refreshed = await publicRefresh(login.refreshToken)
    expect(refreshed.status).toBe(200)
    expect((refreshed.body as { token: string }).token).toBeTruthy()
    const out = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `rt=${refreshed.refreshToken}` },
    })
    expect(out.status).toBe(200)
  })

  it('logout immediately invalidates the access JWT that belonged to that session', async () => {
    const operator = await adminToken()
    const email = `logout-${crypto.randomUUID()}@admin.test`
    const inv = await invite(operator, 'admin-org', email, 'admin')
    const accepted = await acceptInvite(tokenFromUrl(inv.body.acceptUrl ?? ''), email, 'logout-pw')
    expect(accepted.status).toBe(200)
    const accessToken = accepted.body.token as string
    const refreshToken = refreshFrom(accepted.res)
    expect(accessToken).toBeTruthy()
    expect(refreshToken).toBeTruthy()

    const before = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(before.status).toBe(200)

    const out = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `rt=${refreshToken}` },
    })
    expect(out.status).toBe(200)

    const after = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(after.status).toBe(401)
  })

  it('login for an unknown email is 401', async () => {
    const { status } = await publicLogin('ghost@none.test', 'x')
    expect(status).toBe(401)
  })

  it('client IP は信頼できる単一ヘッダーだけを長さ制限付きで採用する', async () => {
    for (const ip of ['203.0.113.10', 'x'.repeat(65)]) {
      const res = await SELF.fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'cf-connecting-ip': ip },
        body: JSON.stringify({
          email: `ip-boundary-${crypto.randomUUID()}@none.test`,
          stretched: 'x',
        }),
      })
      // Both values remain an unauthenticated request; the long one must be
      // normalized to the bounded `unknown` bucket rather than used as a key.
      expect(res.status).toBe(401)
    }
  })
})

describe('scheduled reconcile', () => {
  it('catalog deployable domain が 0 件なら domain reconcile を呼ばない', async () => {
    const domainFetch = vi.spyOn(env.EXAMPLE_SERVICE, 'fetch')
    const zeroDomainEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === 'ADMIN_DOMAIN_IDENTITIES') return '[]'
        return Reflect.get(target, property, receiver)
      },
    })

    await worker.scheduled?.(
      {} as never,
      zeroDomainEnv as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1],
      {} as never,
    )

    expect(domainFetch).not.toHaveBeenCalled()
  })

  it('期限切れ login rate-limit 行を bounded cleanup し、live 行は残す', async () => {
    const db = drizzle(env.DB)
    await db.insert(loginRateLimits).values([
      { key: `expired-${crypto.randomUUID()}`, failures: 1, expiresAt: '2000-01-01T00:00:00.000Z' },
      { key: `live-${crypto.randomUUID()}`, failures: 1, expiresAt: '2999-01-01T00:00:00.000Z' },
    ])

    vi.spyOn(env.EXAMPLE_SERVICE, 'fetch').mockRejectedValue(new Error('no such worker') as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await worker.scheduled?.(
      {} as never,
      env as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1],
      {} as never,
    )

    const rows = await db.select().from(loginRateLimits)
    expect(rows.some((row) => row.expiresAt.startsWith('2000-'))).toBe(false)
    expect(rows.some((row) => row.expiresAt.startsWith('2999-'))).toBe(true)
  })

  it('detects orgs missing on the domain side, re-syncs, and notifies ops.sync_drift', async () => {
    // example_service の同期行一覧は空 → admin の org が全てドリフト扱い
    vi.spyOn(env.EXAMPLE_SERVICE, 'fetch').mockImplementation(((
      input: string | Request,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? (typeof input === 'string' ? 'GET' : (input as Request).method)
      const body = method.toUpperCase() === 'GET' ? '[]' : '{}'
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as never)
    const notifySpy = vi
      .spyOn(env.NOTIFIER, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const token = await adminToken()
    await createOrg(token, 'DriftOrg')
    await worker.scheduled?.(
      {} as never,
      env as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1],
      {} as never,
    )
    const driftCall = notifySpy.mock.calls.find((c) =>
      String((c[1] as RequestInit)?.body ?? '').includes('ops.sync_drift'),
    )
    expect(driftCall).toBeDefined()
    // 冪等キーは日次スロット(再実行で連打しない)
    expect(String((driftCall?.[1] as RequestInit)?.body ?? '')).toContain(
      'ops.sync_drift:example_service:',
    )
  })

  it('does not throw when the domain Worker is unreachable (scaffold not deployed)', async () => {
    vi.spyOn(env.EXAMPLE_SERVICE, 'fetch').mockRejectedValue(new Error('no such worker') as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      worker.scheduled?.(
        {} as never,
        env as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1],
        {} as never,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('onError boundary', () => {
  it('returns 500 when the DB throws unexpectedly', async () => {
    const token = await adminToken()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(500)
  })
})
