import { platformFetch } from '../platform/transport'

const DEV_TOKEN_KEY = 'app.auth.token'
const DEV_ORG_KEY = 'app.auth.org'

function browserValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export async function devLogin(organizationId: string): Promise<void> {
  const response = await platformFetch('/api/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  })
  if (!response.ok) throw new Error(`login failed: ${response.status}`)
  const { token } = (await response.json()) as { token: unknown }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('login response did not contain a token')
  }

  sessionStorage.setItem(DEV_TOKEN_KEY, token)
  sessionStorage.setItem(DEV_ORG_KEY, organizationId)
}

function getToken(): string | null {
  return browserValue(DEV_TOKEN_KEY)
}

function getOrganization(): string | null {
  return browserValue(DEV_ORG_KEY)
}

function logout(): void {
  try {
    sessionStorage.removeItem(DEV_TOKEN_KEY)
    sessionStorage.removeItem(DEV_ORG_KEY)
  } catch {
    // sessionStorage unavailable: there is no browser session to clear.
  }
}

function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  return platformFetch(input, { ...init, headers })
}

export const auth = {
  getToken,
  getOrganization,
  login: devLogin,
  logout,
  authFetch,
}
