import { stretchPassword } from '@app/shared'
import { isTauriRuntime, platformFetch } from '../platform/transport'

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
let authOperation: Promise<unknown> = Promise.resolve()
// A logout must invalidate every in-flight refresh/login response. The epoch
// is deliberately in memory: it is a race guard, while the browser tombstone
// below is the reload/offline guard.
let authEpoch = 0
let signedOut = false

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

/** Serialize credential-changing operations so login cannot finish after logout. */
function enqueueAuthOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = authOperation.catch(() => undefined).then(operation)
  authOperation = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

async function doRefresh(): Promise<boolean> {
  const operationEpoch = authEpoch
  for (let attempt = 0; ; attempt++) {
    if (authEpoch !== operationEpoch || isLogoutBlocked()) return false
    let res: Response
    try {
      res = await platformFetch('/api/auth/refresh', { method: 'POST' })
    } catch {
      // ネットワーク断はセッション破棄の根拠にしない — cookie は生きており、
      // 次の試行で復帰できる。ここで setToken(null) するとフォーム入力中の
      // 一時的なオフラインだけでログイン画面へ弾いてしまう。
      return false
    }
    if (res.ok) {
      const { token } = (await res.json()) as { token: string }
      if (authEpoch !== operationEpoch || isLogoutBlocked()) return false
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
    if (authEpoch !== operationEpoch || isLogoutBlocked()) return false
    setToken(null)
    return false
  }
}

function refresh(): Promise<boolean> {
  if (isLogoutBlocked()) return Promise.resolve(false)
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = enqueueAuthOperation(async () => {
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
  })
  return refreshInFlight
}

async function clearNativeSession(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('clear_session')
}

// dev グラントで得たトークンの一時退避キー(admin 実 DB 不在のローカル/preview 用)。
// 本番では /api/auth/token が 404 で発行不可のため、この値は決して入らない。
const DEV_TOKEN_KEY = 'app.admin.dev.token'
// Web の offline logout は HttpOnly refresh cookie を JavaScript から削除できない。
// localStorage の tombstone はタブ終了後・別タブにも残り、marker がある間は
// bootstrap が cookie refresh を試さないようにしてネットワーク復帰時の暗黙の
// 再ログインを防ぐ。native は Rust の keyring store を clear_session で削除する
// ため、この marker を使わない。
const LOGOUT_INTENT_KEY = 'app.admin.logout.intent'

function isLogoutBlocked(): boolean {
  return signedOut || (!isTauriRuntime() && hasLogoutIntent())
}

function markSignedOut(): void {
  signedOut = true
  authEpoch += 1
  // Invalidate the bearer synchronously. logout() can be called without await,
  // and no request may carry the old access token while the server-side
  // refresh-cookie revocation is still in flight.
  setToken(null)
}

function commitExplicitLogin(token: string, operationEpoch: number): void {
  // A login response that crossed a logout boundary must never resurrect the
  // session. A later, explicit login starts a new operation epoch and can
  // commit normally.
  if (authEpoch !== operationEpoch) throw new LoginError(409)
  signedOut = false
  setToken(token)
  clearLogoutIntent()
  authEpoch += 1
}

function hasLogoutIntent(): boolean {
  try {
    return localStorage.getItem(LOGOUT_INTENT_KEY) === '1'
  } catch {
    // A browser that cannot read localStorage cannot prove that a previous
    // offline logout did not leave the HttpOnly refresh cookie usable. Treat
    // storage failure as a logout boundary; locking the session until storage
    // recovers is safer than silently refreshing a session after sign-out.
    return true
  }
}

function setLogoutIntent(): boolean {
  try {
    localStorage.setItem(LOGOUT_INTENT_KEY, '1')
    return true
  } catch {
    // Without a durable browser marker, an offline logout cannot prevent a
    // later bootstrap from reusing the HttpOnly refresh cookie.
    return false
  }
}

function clearLogoutIntent(): void {
  try {
    localStorage.removeItem(LOGOUT_INTENT_KEY)
  } catch {
    // localStorage 不可は無視
  }
}

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
  if (isLogoutBlocked()) return false
  if (accessToken) return true
  if (await refresh()) return true
  if (isTauriRuntime()) {
    // Native refresh state is kept by the keyring-backed Rust store. Do not
    // restore a renderer sessionStorage token (including one left by an older
    // build), and remove it if it exists.
    try {
      sessionStorage.removeItem(DEV_TOKEN_KEY)
    } catch {
      // sessionStorage 不可は無視
    }
    return false
  }
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
  return enqueueAuthOperation(async () => {
    const operationEpoch = authEpoch
    const stretched = await stretchPassword(password, email)
    const res = await platformFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, stretched }),
    })
    if (!res.ok) throw new LoginError(res.status)
    const { token } = (await res.json()) as { token: string }
    commitExplicitLogin(token, operationEpoch)
  })
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
  return enqueueAuthOperation(async () => {
    const operationEpoch = authEpoch
    const stretched = await stretchPassword(password, email)
    // email も送る: サーバが招待の宛先と突合する(typo のまま受諾すると別 salt の
    // ハッシュが保存され、正しい email でのログインが永久に失敗するため)。
    const res = await platformFetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, email, stretched }),
    })
    if (!res.ok) throw new LoginError(res.status)
    const { token } = (await res.json()) as { token: string }
    commitExplicitLogin(token, operationEpoch)
  })
}

export async function logout(): Promise<void> {
  const native = isTauriRuntime()
  // Invalidate before queueing the network/Rust operation so an already
  // running refresh cannot set a token after the user pressed logout.
  markSignedOut()
  const logoutIntentPersisted = native || setLogoutIntent()
  return enqueueAuthOperation(async () => {
    let serverLogoutSucceeded = false
    try {
      const response = await platformFetch('/api/auth/logout', { method: 'POST' })
      serverLogoutSucceeded = response.ok
    } catch {
      // best-effort: offline browser logout still clears the renderer token.
    } finally {
      try {
        sessionStorage.removeItem(DEV_TOKEN_KEY)
      } catch {
        // 無視
      }
      setToken(null)
    }
    if (native) {
      try {
        await clearNativeSession()
      } catch (error) {
        throw new LogoutError(
          error instanceof Error ? error.message : 'native session clear failed',
        )
      }
    }
    if (!native && !logoutIntentPersisted && !serverLogoutSucceeded) {
      // Keep the in-memory latch set. There is neither a durable tombstone nor
      // server confirmation, so allowing bootstrap here could resurrect the
      // refresh-cookie session after a reload.
      throw new LogoutError('browser logout could not persist its logout boundary')
    }
    // The browser tombstone (or the cleared native store) remains the durable
    // logout boundary. Drop the in-memory latch after cleanup so a later
    // explicit bootstrap in this renderer is evaluated against that boundary
    // instead of being poisoned by this completed operation.
    signedOut = false
  })
}

/** dev グラント(AUTH_DEV_GRANT)。admin 実 DB 不在のローカル開発用(role=admin)。 */
export async function devLogin(organizationId: string): Promise<boolean> {
  return enqueueAuthOperation(async () => {
    const operationEpoch = authEpoch
    const res = await platformFetch('/api/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, role: 'admin' }),
    })
    if (!res.ok) return false
    const { token } = (await res.json()) as { token: string }
    if (authEpoch !== operationEpoch) return false
    if (!isTauriRuntime()) {
      try {
        sessionStorage.setItem(DEV_TOKEN_KEY, token)
      } catch {
        // 無視
      }
    }
    signedOut = false
    setToken(token)
    clearLogoutIntent()
    authEpoch += 1
    return true
  })
}

export class LoginError extends Error {
  constructor(public status: number) {
    super(`login failed: ${status}`)
    this.name = 'LoginError'
  }
}

export class LogoutError extends Error {
  constructor(message: string) {
    super(`logout incomplete: ${message}`)
    this.name = 'LogoutError'
  }
}

/** bearer を付ける fetch。401 は 1 回だけ refresh → 再試行。hc の `fetch` に渡す。 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (isLogoutBlocked()) {
    throw new LogoutError('session is signed out')
  }
  const res = await sendWithToken(input, init)
  if (res.status !== 401) return res
  if (isLogoutBlocked()) return res
  const ok = await refresh()
  if (!ok || isLogoutBlocked()) return res
  return sendWithToken(input, init)
}

function sendWithToken(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  if (isLogoutBlocked()) return Promise.reject(new LogoutError('session is signed out'))
  const headers = new Headers(init.headers)
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
  return platformFetch(input, { ...init, headers })
}
