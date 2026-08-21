import { stretchPassword } from '@app/shared'

/**
 * admin SPA の認証セッション。
 *
 * - access token はメモリ保持(15 分・リロードで消える)。localStorage に置かない。
 * - refresh は HttpOnly cookie(`/api/auth/*` がセット)。JS から読めない。
 * - 起動時 `bootstrap()` は cookie で `/api/auth/refresh` を叩き成功で復帰。dev
 *   グラント(role=admin)が退避されていればフォールバック(ローカル/preview のみ)。
 * - `authFetch` は 401 で 1 回だけ refresh → 再試行(single-flight)。
 */

let accessToken: string | null = null
let refreshInFlight: Promise<boolean> | null = null

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isAuthenticated(): boolean {
  return accessToken !== null
}

function setToken(token: string | null): void {
  accessToken = token
  emit()
}

async function doRefresh(): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch('/api/auth/refresh', { method: 'POST' })
    } catch {
      // ネットワーク断はセッション破棄の根拠にしない — cookie は生きており、
      // 次の試行で復帰できる。ここで setToken(null) するとフォーム入力中の
      // 一時的なオフラインだけでログイン画面へ弾いてしまう。
      return false
    }
    if (res.ok) {
      const { token } = (await res.json()) as { token: string }
      setToken(token)
      return true
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    // rotation_race = 多タブ同時 refresh の負け側(サーバは cookie を保持したまま
    // 401 を返す)。勝者の Set-Cookie が既にブラウザに効いているので、少し待って
    // 新しい cookie で 1 回だけやり直す。
    if (attempt === 0 && body?.error === 'rotation_race') {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    setToken(null)
    return false
  }
}

function refresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      // Web Locks で他タブと直列化する。複数タブが同じ cookie で同時にローテーション
      // すると負け側が「使用済みトークンの提示」になるため、そもそも同時に走らせない。
      // 未対応ブラウザはタブ内 single-flight のみ(サーバ側の猶予が後詰め)。
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request('app.admin.refresh', doRefresh)
      }
      return await doRefresh()
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// dev グラントで得たトークンの一時退避キー(admin 実 DB 不在のローカル/preview 用)。
// 本番では /api/auth/token が 404 で発行不可のため、この値は決して入らない。
const DEV_TOKEN_KEY = 'app.admin.dev.token'

/** JWT の exp(ms)。検証はしない(採用可否の事前判定のみ — 検証はサーバの仕事)。 */
function jwtExpMs(token: string): number | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) return null
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

export async function bootstrap(): Promise<boolean> {
  if (accessToken) return true
  if (await refresh()) return true
  try {
    const devToken = sessionStorage.getItem(DEV_TOKEN_KEY)
    if (devToken) {
      // 期限切れの dev トークンを採用すると「認証済み→即 401→ログインへ」の
      // バウンスを毎回繰り返す。期限切れは捨てる。
      const exp = jwtExpMs(devToken)
      if (exp !== null && exp <= Date.now()) {
        sessionStorage.removeItem(DEV_TOKEN_KEY)
        return false
      }
      setToken(devToken)
      return true
    }
  } catch {
    // sessionStorage 不可は無視
  }
  return false
}

export async function login(email: string, password: string): Promise<void> {
  const stretched = await stretchPassword(password, email)
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, stretched }),
  })
  if (!res.ok) throw new LoginError(res.status)
  const { token } = (await res.json()) as { token: string }
  setToken(token)
}

/**
 * 招待受諾: パスワードを設定してそのままログイン状態にする。
 * email は stretch の salt 一致のためユーザーに入力させる(URL に載せない)。
 */
export async function acceptInvite(
  inviteToken: string,
  email: string,
  password: string,
): Promise<void> {
  const stretched = await stretchPassword(password, email)
  // email も送る: サーバが招待の宛先と突合する(typo のまま受諾すると別 salt の
  // ハッシュが保存され、正しい email でのログインが永久に失敗するため)。
  const res = await fetch('/api/auth/accept-invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, email, stretched }),
  })
  if (!res.ok) throw new LoginError(res.status)
  const { token } = (await res.json()) as { token: string }
  setToken(token)
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } catch {
    // best-effort
  }
  try {
    sessionStorage.removeItem(DEV_TOKEN_KEY)
  } catch {
    // 無視
  }
  setToken(null)
}

/** dev グラント(AUTH_DEV_GRANT)。admin 実 DB 不在のローカル開発用(role=admin)。 */
export async function devLogin(organizationId: string): Promise<boolean> {
  const res = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId, role: 'admin' }),
  })
  if (!res.ok) return false
  const { token } = (await res.json()) as { token: string }
  try {
    sessionStorage.setItem(DEV_TOKEN_KEY, token)
  } catch {
    // 無視
  }
  setToken(token)
  return true
}

export class LoginError extends Error {
  constructor(public status: number) {
    super(`login failed: ${status}`)
    this.name = 'LoginError'
  }
}

/** bearer を付ける fetch。401 は 1 回だけ refresh → 再試行。hc の `fetch` に渡す。 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const res = await sendWithToken(input, init)
  if (res.status !== 401) return res
  const ok = await refresh()
  if (!ok) return res
  return sendWithToken(input, init)
}

function sendWithToken(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
  return fetch(input, { ...init, headers })
}
