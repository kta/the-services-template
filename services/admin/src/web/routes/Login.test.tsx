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
})
