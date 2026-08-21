import { Button, Notice, TextInput } from '@app/ui'
import { type FormEvent, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { acceptInvite, LoginError } from '../auth/session'

const MIN_PASSWORD = 12

/**
 * 招待受諾(Login と同型)。URL の `?token=` を受け、email + パスワード(≥12)を
 * 設定してそのままログイン状態に。email は stretch の salt 一致のため入力させる
 * (URL には載せない)。
 */
export function Invite() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = confirm.length > 0 && confirm !== password

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD || password !== confirm) return
    setBusy(true)
    try {
      await acceptInvite(token, email, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(messageForAcceptError(err))
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
        <p className="mt-1.5 font-sans text-sm text-ink-muted">アカウントの初期設定</p>

        {!token ? (
          <div className="mt-6">
            <Notice tone="danger">招待リンクが無効です。管理者にお問い合わせください。</Notice>
          </div>
        ) : (
          <form className="mt-6 flex flex-col gap-4" onSubmit={onSubmit}>
            <label htmlFor="inv-email" className="flex flex-col gap-1.5">
              <span className="font-sans text-sm text-ink-muted">招待メールの宛先アドレス</span>
              <TextInput
                id="inv-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="font-mono"
              />
            </label>
            <label htmlFor="inv-pw" className="flex flex-col gap-1.5">
              <span className="font-sans text-sm text-ink-muted">
                パスワード（{MIN_PASSWORD} 文字以上）
              </span>
              <TextInput
                id="inv-pw"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {tooShort && (
                <span role="alert" className="font-sans text-sm text-danger">
                  {MIN_PASSWORD} 文字以上にしてください。
                </span>
              )}
            </label>
            <label htmlFor="inv-pw2" className="flex flex-col gap-1.5">
              <span className="font-sans text-sm text-ink-muted">パスワード（確認）</span>
              <TextInput
                id="inv-pw2"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && (
                <span role="alert" className="font-sans text-sm text-danger">
                  パスワードが一致しません。
                </span>
              )}
            </label>

            {error && <Notice tone="danger">{error}</Notice>}

            <Button
              type="submit"
              disabled={busy || !email || password.length < MIN_PASSWORD || password !== confirm}
              className="mt-1 min-h-12"
            >
              {busy ? '設定中…' : 'パスワードを設定してはじめる'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

function messageForAcceptError(err: unknown): string {
  if (err instanceof LoginError) {
    if (err.status === 400)
      // email は stretch の salt — 招待の宛先と違うまま受諾させるとログイン不能の
      // ハッシュが保存されるため、サーバが突合して 400 を返す。
      return '入力されたメールアドレスが招待の宛先と一致しません。招待メールが届いたアドレスを入力してください。'
    if (err.status === 410)
      return 'この招待は有効期限が切れています。管理者に再発行を依頼してください。'
  }
  return '招待を受諾できませんでした。リンクが正しいかご確認ください。'
}
