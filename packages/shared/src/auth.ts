// Minimal frontend auth: stores a JWT and attaches it to requests. The token
// is issued by the same-origin /api/auth/token endpoint (dev grant in this
// template — replace with a real credential/IdP flow before production).
const TOKEN_KEY = 'app.auth.token'
const ORG_KEY = 'app.auth.org'

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function getOrganization(): string | null {
  return sessionStorage.getItem(ORG_KEY)
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(ORG_KEY)
}

// Dev login: exchanges an organization id for a JWT (same origin — the SPA is
// served by the same Worker as the API).
export async function login(organizationId: string): Promise<void> {
  const res = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const data = (await res.json()) as { token: string }
  sessionStorage.setItem(TOKEN_KEY, data.token)
  sessionStorage.setItem(ORG_KEY, organizationId)
}

// fetch wrapper that adds the bearer token. Pass as hc's `fetch` option.
// NOTE (template limitation): no token refresh — callers should treat a 401 as
// "session expired" and send the user back to sign-in (see example_service App).
export function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
