import { ANALYTICS_EVENTS, trackEvent } from '@app/shared'
import { Button, Notice, TextInput } from '@app/ui'
import { type FormEvent, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { devLogin, LoginError, login } from '../auth/session'
import { toast } from '../store/toast'

/**
 * admin ログイン: 中央カード 1 枚。エラーは Notice(日本語文言のみ)。
 * パスワードは stretchPassword 済みで送る(平文をネットワークに出さない)。
 */
export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // RequireAuth が元 URL を state.from で渡してくる。無ければトップへ。
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email, password)
      trackEvent(ANALYTICS_EVENTS.LOGIN_SUCCESS)
      navigate(from, { replace: true })
    } catch (err) {
      // 403(org 無効)・5xx・ネットワーク断を「パスワードが違う」と誤案内すると、
      // 正しいパスワードのユーザーが再入力を繰り返してロックアウトに至る。
      const message = messageForLoginError(err)
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-paper px-5 py-14">
      <div className="w-full max-w-md rounded-ctl border border-line bg-surface px-8 pt-9 pb-7">
        <div className="font-display text-2xl font-semibold tracking-tight text-pine">
          Admin Console
        </div>
        <p className="mt-1.5 font-sans text-sm text-ink-muted">組織・テナントの管理</p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={onSubmit}>
          <label htmlFor="admin-email" className="flex flex-col gap-1.5">
            <span className="font-sans text-sm text-ink-muted">メールアドレス</span>
            <TextInput
              id="admin-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="font-mono tabular-nums"
            />
          </label>
          <label htmlFor="admin-password" className="flex flex-col gap-1.5">
            <span className="font-sans text-sm text-ink-muted">パスワード</span>
            <TextInput
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <Notice tone="danger">{error}</Notice>}

          <Button type="submit" disabled={busy || !email || !password} className="mt-1 min-h-12">
            {busy ? 'ログイン中…' : 'ログイン'}
          </Button>
        </form>

        <p className="mt-5 text-center font-sans text-sm text-ink-muted">
          管理者アカウントのみログインできます。
        </p>

        {import.meta.env.DEV && <DevGrant onDone={() => navigate(from, { replace: true })} />}
      </div>
    </div>
  )
}

function messageForLoginError(err: unknown): string {
  if (err instanceof LoginError) {
    if (err.status === 429) return '試行回数が上限に達しました。しばらく待って再度お試しください。'
    if (err.status === 403)
      return 'この組織は現在無効化されています。管理者にお問い合わせください。'
    if (err.status >= 500) return 'サーバーエラーが発生しました。時間をおいて再度お試しください。'
    return 'メールアドレスまたはパスワードが一致しません。入力内容を確認して、もう一度お試しください。'
  }
  return 'ネットワークエラーが発生しました。接続を確認して再度お試しください。'
}

/** ローカル開発(admin 実 DB 不在)用の dev グラント。本番ビルドには含まれない。 */
function DevGrant({ onDone }: { onDone: () => void }) {
  const [org, setOrg] = useState('org-admin-seed')
  return (
    <div className="mt-6 border-t border-line pt-4">
      <p className="font-sans text-xs text-ink-muted">開発用ログイン(管理者・組織 ID を指定)</p>
      <div className="mt-2 flex gap-2">
        <input
          aria-label="組織 ID"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          className="min-h-11 flex-1 rounded-ctl border border-line bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <Button
          variant="ghost"
          onClick={async () => {
            if (await devLogin(org)) onDone()
            // 失敗を無言にしない(AUTH_DEV_GRANT 無効の Worker では常に失敗する)
            else toast.error('dev ログインに失敗しました(AUTH_DEV_GRANT が無効の可能性)。')
          }}
        >
          dev ログイン
        </Button>
      </div>
    </div>
  )
}
