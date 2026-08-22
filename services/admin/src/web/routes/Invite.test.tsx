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
  return { acceptInvite: vi.fn(), LoginError }
})

vi.mock('../auth/session', () => ({
  acceptInvite: state.acceptInvite,
  LoginError: state.LoginError,
}))

import { Invite } from './Invite'

function renderInvite(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/invite${search}`]}>
      <Routes>
        <Route path="/invite" element={<Invite />} />
        <Route path="/" element={<p>Home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Invite', () => {
  afterEach(() => state.acceptInvite.mockReset())

  it('rejects a missing token before exposing the account setup form', () => {
    renderInvite()
    expect(screen.getByRole('alert')).toHaveTextContent('招待リンクが無効です')
    expect(
      screen.queryByRole('button', { name: 'パスワードを設定してはじめる' }),
    ).not.toBeInTheDocument()
  })

  it('shows password validation then accepts a matching password', async () => {
    const user = userEvent.setup()
    state.acceptInvite.mockResolvedValue(undefined)
    renderInvite('?token=invite-token')

    await user.type(screen.getByLabelText('招待メールの宛先アドレス'), 'staff@example.com')
    await user.type(screen.getByLabelText('パスワード（12 文字以上）'), 'short')
    expect(screen.getByRole('alert')).toHaveTextContent('12 文字以上')
    await user.type(screen.getByLabelText('パスワード（確認）'), 'different')
    expect(screen.getAllByRole('alert')).toHaveLength(2)

    const password = screen.getByLabelText(/パスワード（.*文字以上）/)
    const confirm = screen.getByLabelText(/パスワード（確認）/)
    await user.clear(password)
    await user.clear(confirm)
    await user.type(password, 'long-password')
    await user.type(confirm, 'long-password')
    await user.click(screen.getByRole('button', { name: 'パスワードを設定してはじめる' }))

    await waitFor(() =>
      expect(state.acceptInvite).toHaveBeenCalledWith(
        'invite-token',
        'staff@example.com',
        'long-password',
      ),
    )
    expect(await screen.findByText('Home')).toBeVisible()
  })

  it('keeps the setup action busy until a valid invitation is accepted', async () => {
    const user = userEvent.setup()
    let resolveInvite: () => void = () => undefined
    state.acceptInvite.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvite = resolve
      }),
    )
    renderInvite('?token=invite-token')

    await user.type(screen.getByLabelText('招待メールの宛先アドレス'), 'staff@example.com')
    await user.type(screen.getByLabelText('パスワード（12 文字以上）'), 'long-password')
    await user.type(screen.getByLabelText('パスワード（確認）'), 'long-password')
    await user.click(screen.getByRole('button', { name: 'パスワードを設定してはじめる' }))

    expect(screen.getByRole('button', { name: '設定中…' })).toBeDisabled()
    resolveInvite()
    expect(await screen.findByText('Home')).toBeVisible()
  })

  it.each([
    [400, '入力されたメールアドレスが招待の宛先と一致しません。'],
    [410, 'この招待は有効期限が切れています。'],
    [500, '招待を受諾できませんでした。'],
  ])('explains invitation failure status %i', async (status, message) => {
    const user = userEvent.setup()
    state.acceptInvite.mockRejectedValue(new state.LoginError(status))
    renderInvite('?token=invite-token')

    await user.type(screen.getByLabelText('招待メールの宛先アドレス'), 'staff@example.com')
    await user.type(screen.getByLabelText('パスワード（12 文字以上）'), 'long-password')
    await user.type(screen.getByLabelText('パスワード（確認）'), 'long-password')
    await user.click(screen.getByRole('button', { name: 'パスワードを設定してはじめる' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })
})
