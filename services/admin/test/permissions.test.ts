/**
 * 管理 API の**権限マトリクス**(誰が何を叩けるか)を表駆動で固定する。
 *
 * admin は「プラットフォーム運営者のコンソール」であり、テナント側の admin に
 * 触らせてはいけない。ゲートは 3 段:
 *   tenantAuth(JWT) → requireRole('admin') → requireOperator(運営 org か)
 * default-deny(`/api/*` に一括適用)なので、**新しいルートを足しても自動で保護される**。
 * その性質が壊れていないことも、未知パスへのアクセスで確認する。
 *
 * 時刻依存(期限切れトークン)の観点もここに含める — 期限切れは「権限なし(403)」
 * ではなく「未認証(401)」に写像されるべき。
 */

import { createExecutionContext, env, SELF } from 'cloudflare:test'
import { signAccessToken } from '@app/shared'
import { describe, expect, it } from 'vitest'

const BASE = 'https://admin.test'
const JSON_HEADERS = { 'content-type': 'application/json' }
const JWT_SECRET = 'dev-jwt-secret-change-me'

type Actor = 'none' | 'staff' | 'tenant-admin' | 'operator-admin' | 'expired' | 'wrong-secret'

/** dev グラントでトークンを取る(その org は運営 org として upsert される)。 */
async function devToken(role: 'admin' | 'staff', orgId: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ organizationId: orgId, role }),
  })
  return ((await res.json()) as { token: string }).token
}

/**
 * 運営 admin が「テナント org」を作り、その org の admin を成立させてトークンを得る。
 * D1 はテスト間で共有されるため、email は毎回ユニークにする(同一 email の再招待は
 * 別 org では 409 email_taken = 乗っ取り防止の正しい挙動)。
 */
async function tenantAdminToken(): Promise<string> {
  const email = `tenant-admin-${crypto.randomUUID()}@tenant.test`
  const op = await devToken('admin', 'operator-org')
  const created = await SELF.fetch(`${BASE}/api/organizations`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${op}` },
    body: JSON.stringify({ name: 'Tenant Co' }),
  })
  const org = (await created.json()) as { id: string }
  const invited = await SELF.fetch(`${BASE}/api/organizations/${org.id}/invitations`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${op}` },
    body: JSON.stringify({ email, role: 'admin' }),
  })
  const { acceptUrl } = (await invited.json()) as { acceptUrl?: string }
  if (!acceptUrl) throw new Error('invite did not return an acceptUrl')
  const token = new URL(acceptUrl).searchParams.get('token') ?? ''
  const accepted = await SELF.fetch(`${BASE}/api/auth/accept-invite`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token, email, stretched: 'pw' }),
  })
  return ((await accepted.json()) as { token: string }).token
}

async function headersFor(actor: Actor): Promise<Record<string, string>> {
  switch (actor) {
    case 'none':
      return {}
    case 'staff':
      return { authorization: `Bearer ${await devToken('staff', 'operator-org')}` }
    case 'tenant-admin':
      return { authorization: `Bearer ${await tenantAdminToken()}` }
    case 'operator-admin':
      return { authorization: `Bearer ${await devToken('admin', 'operator-org')}` }
    case 'expired': {
      const expired = await signAccessToken(
        { sub: 'u1', org: 'operator-org', email: 'a@b.test', role: 'admin' },
        JWT_SECRET,
        -1, // 1 秒前に失効
      )
      return { authorization: `Bearer ${expired}` }
    }
    case 'wrong-secret': {
      const other = await signAccessToken(
        { sub: 'u1', org: 'operator-org', email: 'a@b.test', role: 'admin' },
        'a-different-secret',
      )
      return { authorization: `Bearer ${other}` }
    }
  }
}

/** 管理 API(全て運営 admin 限定)。operator-admin では「ゲートを通った」ことだけ見る。 */
const MANAGEMENT_ROUTES = [
  { name: 'GET /api/organizations', method: 'GET', path: '/api/organizations' },
  {
    name: 'POST /api/organizations',
    method: 'POST',
    path: '/api/organizations',
    body: { name: 'X' },
  },
  {
    name: 'PATCH /api/organizations/:id',
    method: 'PATCH',
    path: '/api/organizations/unknown-org',
    body: { plan: 'contracted' },
  },
  { name: 'DELETE /api/organizations/:id', method: 'DELETE', path: '/api/organizations/unknown' },
  {
    name: 'POST /api/organizations/:id/invitations',
    method: 'POST',
    path: '/api/organizations/unknown/invitations',
    body: { email: 'x@y.test' },
  },
  // default-deny の証明: 存在しない /api/* もゲートを通らないと 404 にすら到達しない
  { name: 'GET /api/not-a-route(未知パス)', method: 'GET', path: '/api/not-a-route' },
] as const

async function call(
  route: (typeof MANAGEMENT_ROUTES)[number],
  actor: Actor,
): Promise<{ status: number; error?: string }> {
  const auth = await headersFor(actor)
  const res = await SELF.fetch(`${BASE}${route.path}`, {
    method: route.method,
    headers: 'body' in route ? { ...JSON_HEADERS, ...auth } : auth,
    ...('body' in route ? { body: JSON.stringify(route.body) } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return { status: res.status, error: body.error }
}

describe('管理 API の権限マトリクス', () => {
  for (const route of MANAGEMENT_ROUTES) {
    describe(route.name, () => {
      it('未認証は 401', async () => {
        expect((await call(route, 'none')).status).toBe(401)
      })

      it('期限切れトークンは 401(403 ではない)', async () => {
        const { status } = await call(route, 'expired')
        expect(status).toBe(401)
      })

      it('別 secret で署名されたトークンは 401', async () => {
        expect((await call(route, 'wrong-secret')).status).toBe(401)
      })

      it('staff ロールは 403 forbidden', async () => {
        const { status, error } = await call(route, 'staff')
        expect(status).toBe(403)
        expect(error).toBe('forbidden')
      })

      it('テナント org の admin は 403 operator_only(クロステナント権限昇格の遮断)', async () => {
        const { status, error } = await call(route, 'tenant-admin')
        expect(status).toBe(403)
        expect(error).toBe('operator_only')
      })

      it('運営 org の admin はゲートを通る(401/403 にならない)', async () => {
        const { status } = await call(route, 'operator-admin')
        expect([200, 201, 400, 404]).toContain(status)
      })
    })
  }
})

describe('公開ルート(認証不要)', () => {
  it('GET /api/health は誰でも 200', async () => {
    expect((await SELF.fetch(`${BASE}/api/health`)).status).toBe(200)
  })

  it('POST /api/auth/login は未認証で到達できる(資格情報が誤りなら 401)', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'ghost@none.test', stretched: 'x' }),
    })
    // ゲートで弾かれた 401 ではなく、認証ロジックとしての 401(到達できている)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_credentials')
  })

  it('POST /api/auth/refresh は cookie 無しで no_session(ゲートの unauthorized ではない)', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/refresh`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('no_session')
  })
})

describe('内部ルートの鍵ゲート(JWT では通れない)', () => {
  it('x-internal-key 無しの /api/internal/* は 401', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/anything`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('運営 admin の JWT を付けても内部ルートは通らない(鍵が要る)', async () => {
    const token = await devToken('admin', 'operator-org')
    const res = await SELF.fetch(`${BASE}/api/internal/anything`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('dev トークングラントの fail close', () => {
  it('AUTH_DEV_GRANT が "true" でなければ 404(本番では経路ごと存在しない)', async () => {
    const { default: worker } = await import('../src/worker/index')
    const res = await worker.fetch(
      new Request(`${BASE}/api/auth/token`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ organizationId: 'o1' }),
      }),
      { ...env, AUTH_DEV_GRANT: 'false' } as never,
      createExecutionContext(),
    )
    expect(res.status).toBe(404)
  })
})
