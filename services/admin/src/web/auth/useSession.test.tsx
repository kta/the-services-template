import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { login, logout } from './session'
import { useAuthenticated } from './useSession'

const shared = vi.hoisted(() => ({ stretchPassword: vi.fn() }))

vi.mock('@app/shared', () => shared)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function SessionProbe({ onRender }: { onRender?: (authenticated: boolean) => void }) {
  const authenticated = useAuthenticated()
  onRender?.(authenticated)
  return <output aria-label="session state">{authenticated ? 'authenticated' : 'anonymous'}</output>
}

describe('useAuthenticated', () => {
  afterEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await logout()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('updates a mounted consumer from anonymous to authenticated after login', async () => {
    shared.stretchPassword.mockResolvedValue('stretched-password')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ token: 'access-token' })))
    render(<SessionProbe />)

    expect(screen.getByRole('status', { name: 'session state' })).toHaveTextContent('anonymous')
    await login('admin@example.com', 'password')

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'session state' })).toHaveTextContent(
        'authenticated',
      ),
    )
  })

  it('updates a mounted consumer from authenticated to anonymous after logout', async () => {
    shared.stretchPassword.mockResolvedValue('stretched-password')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ token: 'access-token' })))
    await login('admin@example.com', 'password')
    render(<SessionProbe />)

    expect(screen.getByRole('status', { name: 'session state' })).toHaveTextContent('authenticated')
    await logout()

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'session state' })).toHaveTextContent('anonymous'),
    )
  })

  it('does not render again after its consumer unmounts and a later login emits', async () => {
    const renders: boolean[] = []
    shared.stretchPassword.mockResolvedValue('stretched-password')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ token: 'access-token' })))
    const view = render(<SessionProbe onRender={(authenticated) => renders.push(authenticated)} />)

    view.unmount()
    await login('admin@example.com', 'password')

    expect(renders).toEqual([false])
  })
})
