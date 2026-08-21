import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch, getOrganization, getToken, login, logout } from '../src/auth'

// node 環境に sessionStorage は無いので Map で代替する(挙動は Storage 互換の範囲)。
function stubSessionStorage() {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  vi.stubGlobal('sessionStorage', stub)
}

beforeEach(stubSessionStorage)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dev token grant client', () => {
  it('login 成功で token/org を保存し、logout で消す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: 't1' }), { status: 200 })),
    )
    await login('org-1')
    expect(getToken()).toBe('t1')
    expect(getOrganization()).toBe('org-1')
    logout()
    expect(getToken()).toBeNull()
    expect(getOrganization()).toBeNull()
  })

  it('login 失敗(非 2xx)は throw し、何も保存しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    await expect(login('org-1')).rejects.toThrow('login failed: 404')
    expect(getToken()).toBeNull()
  })

  it('authFetch は token があるときだけ bearer を付ける', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await authFetch('/api/items')
    let headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBeNull()

    sessionStorage.setItem('app.auth.token', 't2')
    await authFetch('/api/items')
    headers = fetchSpy.mock.calls[1]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer t2')
  })
})
