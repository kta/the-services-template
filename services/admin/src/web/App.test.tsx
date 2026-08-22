import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { logout } from './auth/session'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return new URL(input.url).pathname
}

function installFetch(token = 'access-token') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      switch (pathOf(input)) {
        case '/api/auth/refresh':
          return json({ token })
        case '/api/organizations':
          return json([])
        case '/api/auth/logout':
          return new Response(null, { status: 204 })
        default:
          return new Response(null, { status: 404 })
      }
    }),
  )
}

function visit(path: string) {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

describe('admin application routes', () => {
  afterEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await logout()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('keeps the loading screen visible until the initial session refresh settles', async () => {
    const refresh = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(refresh.promise))
    visit('/')

    expect(screen.getByText('読み込み中')).toBeVisible()

    refresh.resolve(new Response(null, { status: 401 }))
    expect(await screen.findByRole('button', { name: 'ログイン' })).toBeVisible()
  })

  it('redirects an unauthenticated protected path to login after refresh rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    visit('/')

    expect(await screen.findByRole('button', { name: 'ログイン' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
  })

  it('renders the organization route after restoring an authenticated session', async () => {
    installFetch()
    visit('/')

    expect(await screen.findByRole('heading', { name: '組織' })).toBeVisible()
    expect(window.location.pathname).toBe('/')
  })

  it('leaves the invitation path public without a session refresh', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    visit('/invite?token=invite-token')

    expect(screen.getByLabelText('招待メールの宛先アドレス')).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes an unknown path through the protected root and then login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    visit('/unknown')

    expect(await screen.findByRole('button', { name: 'ログイン' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
  })

  it('navigates to login after logout from an authenticated route', async () => {
    const user = userEvent.setup()
    installFetch()
    visit('/')
    await screen.findByRole('heading', { name: '組織' })

    await user.click(screen.getByRole('button', { name: 'ログアウト' }))

    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(screen.getByRole('button', { name: 'ログイン' })).toBeVisible()
  })
})
