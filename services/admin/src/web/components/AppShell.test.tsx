import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ logout: vi.fn() }))

vi.mock('../auth/session', () => ({ logout: state.logout }))

import { AppShell } from './AppShell'

describe('AppShell', () => {
  afterEach(() => state.logout.mockReset())

  it('shows the active organization navigation and signs out to login', async () => {
    const user = userEvent.setup()
    state.logout.mockResolvedValue(undefined)
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<p>Organizations</p>} />
          </Route>
          <Route path="/login" element={<p>Login screen</p>} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getAllByRole('link', { name: '組織' })).toHaveLength(2)
    expect(screen.getByText('管理者アカウント')).toBeVisible()
    expect(screen.getByText('Organizations')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'ログアウト' }))

    await waitFor(() => expect(state.logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Login screen')).toBeVisible()
  })
})
