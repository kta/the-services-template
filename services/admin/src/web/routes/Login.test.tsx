import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  class LoginError extends Error {
    constructor(public status: number) {
      super(`login failed: ${status}`)
    }
  }
  return { login: vi.fn(), devLogin: vi.fn(), LoginError }
})

vi.mock('@app/shared', () => ({
  ANALYTICS_EVENTS: { LOGIN_SUCCESS: 'login_success' },
  trackEvent: vi.fn(),
}))
vi.mock('../auth/session', () => ({
  login: state.login,
  devLogin: state.devLogin,
  LoginError: state.LoginError,
}))

import { Login } from './Login'

function renderLogin(stateValue: object | null = null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: stateValue }]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/organizations" element={<p>Organizations</p>} />
        <Route path="/" element={<p>Home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function deferred<T>() {
  let resolvePending: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePending = resolve
  })
  return {
    promise,
    resolve(value: T) {
      if (!resolvePending) throw new Error('deferred promise has no resolver')
      resolvePending(value)
    },
  }
}

describe('Login', () => {
  afterEach(() => {
    state.login.mockReset()
    state.devLogin.mockReset()
  })

  it('submits credentials and returns to the protected route', async () => {
    const user = userEvent.setup()
    state.login.mockResolvedValue(undefined)
    renderLogin({ from: '/organizations' })

    expect(screen.getByRole('button', { name: 'ログイン' })).toBeDisabled()
    await user.type(screen.getByLabelText('メールアドレス'), 'admin@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    await waitFor(() => expect(state.login).toHaveBeenCalledWith('admin@example.com', 'password'))
    expect(await screen.findByText('Organizations')).toBeVisible()
  })

  it('leaves empty fields disabled and lets browser validation reject an invalid email', async () => {
    const user = userEvent.setup()
    renderLogin()

    const submit = screen.getByRole('button', { name: 'ログイン' })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText('メールアドレス'), 'not-an-email')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    expect(submit).toBeEnabled()
    expect(screen.getByLabelText('メールアドレス')).toBeInvalid()
    await user.click(submit)

    expect(state.login).not.toHaveBeenCalled()
  })

  it('disables repeat submission and exposes loading while login is pending', async () => {
    const user = userEvent.setup()
    const pending = deferred<void>()
    state.login.mockReturnValue(pending.promise)
    renderLogin()

    await user.type(screen.getByLabelText('メールアドレス'), 'admin@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(screen.getByRole('button', { name: 'ログイン中…' })).toBeDisabled()
    pending.resolve()
    expect(await screen.findByRole('button', { name: 'ログイン' })).toBeEnabled()
  })

  it.each([
    [429, '試行回数が上限に達しました。しばらく待って再度お試しください。'],
    [403, 'この組織は現在無効化されています。管理者にお問い合わせください。'],
    [500, 'サーバーエラーが発生しました。時間をおいて再度お試しください。'],
    [
      401,
      'メールアドレスまたはパスワードが一致しません。入力内容を確認して、もう一度お試しください。',
    ],
  ])('explains login failure status %i', async (status, message) => {
    const user = userEvent.setup()
    state.login.mockRejectedValue(new state.LoginError(status))
    renderLogin()

    await user.type(screen.getByLabelText('メールアドレス'), 'admin@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('reports a network login failure', async () => {
    const user = userEvent.setup()
    state.login.mockRejectedValue(new Error('offline'))
    renderLogin()

    await user.type(screen.getByLabelText('メールアドレス'), 'admin@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('ネットワークエラー')
  })

  it('allows a retry after a failed login and navigates on the later success', async () => {
    const user = userEvent.setup()
    state.login.mockRejectedValueOnce(new state.LoginError(401)).mockResolvedValueOnce(undefined)
    renderLogin({ from: '/organizations' })

    await user.type(screen.getByLabelText('メールアドレス'), 'admin@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('メールアドレスまたはパスワード')

    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByText('Organizations')).toBeVisible()
  })
})
