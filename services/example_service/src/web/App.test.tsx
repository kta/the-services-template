import { auth } from '@app/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const item = {
  id: 'item-1',
  organizationId: 'org_acme',
  title: 'Shipped',
  body: 'First release',
  createdAt: '2026-08-22T00:00:00.000Z',
}

function mockFetch(replies: Array<Response | Error | Promise<Response>>) {
  const fetchMock = vi.fn().mockImplementation(() => {
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected network request')
    return reply instanceof Error ? Promise.reject(reply) : reply
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  if (!resolve) throw new Error('deferred resolver is missing')
  return { promise, resolve }
}

function signedInAs(organizationId = 'org_acme') {
  sessionStorage.setItem('app.auth.token', 'token-123')
  sessionStorage.setItem('app.auth.org', organizationId)
}

describe('example service app', () => {
  afterEach(() => {
    auth.logout()
    vi.unstubAllGlobals()
  })

  it('signs out explicitly and clears the persisted workspace session', async () => {
    signedInAs()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([item]))))
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('Shipped')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(screen.getByRole('button', { name: 'Open workspace' })).toBeVisible()
    expect(auth.getOrganization()).toBeNull()
    expect(auth.getToken()).toBeNull()
  })

  it('starts signed out and rejects a whitespace-only workspace id without requesting a token', async () => {
    const fetchMock = mockFetch([])
    const user = userEvent.setup()

    render(<App />)
    expect(screen.getByRole('button', { name: 'Open workspace' })).toBeVisible()

    await user.type(screen.getByLabelText('Workspace id'), '   ')
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a workspace id to continue.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('trims the workspace id, shows opening state, and enters an empty ledger after a token grant', async () => {
    const grant = deferred<Response>()
    const fetchMock = mockFetch([grant.promise, new Response(JSON.stringify([]), { status: 200 })])
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const user = userEvent.setup()

    render(<App />)
    await user.type(screen.getByLabelText('Workspace id'), ' org_acme ')
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))

    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled()
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/auth/token',
      expect.objectContaining({ body: JSON.stringify({ organizationId: 'org_acme' }) }),
    ])

    grant.resolve(new Response(JSON.stringify({ token: 'token-123' }), { status: 200 }))

    expect(
      await screen.findByText('The ledger is empty — add its first entry above.'),
    ).toBeVisible()
    expect(auth.getOrganization()).toBe('org_acme')
    expect(gtag).toHaveBeenCalledWith('event', 'login_success', {})
  })

  it('allows retry after a rejected token grant and emits no login success event for the failure', async () => {
    mockFetch([
      new Response(JSON.stringify({ error: 'denied' }), { status: 403 }),
      new Response(JSON.stringify({ token: 'token-123' }), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
    ])
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const user = userEvent.setup()

    render(<App />)
    await user.type(screen.getByLabelText('Workspace id'), 'org_acme')
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not open the workspace. Check the id and try again.',
    )
    expect(gtag).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Open workspace' }))

    expect(
      await screen.findByText('The ledger is empty — add its first entry above.'),
    ).toBeVisible()
    expect(gtag).toHaveBeenCalledTimes(1)
  })

  it('shows loading before resolving an empty ledger', async () => {
    signedInAs()
    const list = deferred<Response>()
    mockFetch([list.promise])

    render(<App />)
    expect(screen.getByText('Loading…')).toBeVisible()

    list.resolve(new Response(JSON.stringify([]), { status: 200 }))

    expect(
      await screen.findByText('The ledger is empty — add its first entry above.'),
    ).toBeVisible()
  })

  it('renders populated entries with optional notes and their timestamp metadata', async () => {
    signedInAs()
    mockFetch([
      new Response(
        JSON.stringify([
          { ...item, body: '' },
          {
            ...item,
            id: 'item-2',
            title: 'With notes',
            body: 'Optional detail',
            createdAt: '2026-08-23T00:00:00.000Z',
          },
        ]),
        { status: 200 },
      ),
    ])

    render(<App />)

    expect(await screen.findByText('Shipped')).toBeVisible()
    expect(screen.getByText('With notes')).toBeVisible()
    expect(screen.getByText('Optional detail')).toBeVisible()
    expect(document.querySelector('time[datetime="2026-08-22T00:00:00.000Z"]')).toBeTruthy()
  })

  it.each([
    ['a non-OK response', new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })],
    ['a rejected request', new Error('offline')],
  ])('shows a load error after %s', async (_name, failure) => {
    signedInAs()
    mockFetch([failure])

    render(<App />)

    expect(await screen.findByText('Could not load items. Reload to try again.')).toBeVisible()
  })

  it('returns to sign-in and clears the session when loading is unauthorized', async () => {
    signedInAs()
    mockFetch([new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })])
    const logoutSpy = vi.spyOn(auth, 'logout')

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Open workspace' })).toBeVisible()
    expect(auth.getOrganization()).toBeNull()
    expect(logoutSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects empty and overlong entry titles before sending a create request', async () => {
    signedInAs()
    const fetchMock = mockFetch([new Response(JSON.stringify([]), { status: 200 })])
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('The ledger is empty — add its first entry above.')
    await user.click(screen.getByRole('button', { name: 'Add entry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('A title is required')

    await user.type(screen.getByLabelText('Title'), 'x'.repeat(201))
    await user.click(screen.getByRole('button', { name: 'Add entry' }))

    expect(screen.getByRole('alert')).toHaveTextContent('A title is required')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps an optional-body entry busy once, resets it after saving, reloads, and records analytics', async () => {
    signedInAs()
    const save = deferred<Response>()
    const fetchMock = mockFetch([
      new Response(JSON.stringify([]), { status: 200 }),
      save.promise,
      new Response(JSON.stringify([{ ...item, body: '' }]), { status: 200 }),
    ])
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('The ledger is empty — add its first entry above.')
    await user.type(screen.getByLabelText('Title'), 'Shipped')
    await user.click(screen.getByRole('button', { name: 'Add entry' }))

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Saving…' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    save.resolve(new Response(JSON.stringify(item), { status: 201 }))

    expect(await screen.findByText('Shipped')).toBeVisible()
    expect(screen.getByLabelText('Title')).toHaveValue('')
    expect(screen.getByLabelText('Notes')).toHaveValue('')
    expect(gtag).toHaveBeenCalledWith('event', 'item_created', {})
  })

  it.each([
    [
      'a non-OK response',
      new Response(JSON.stringify({ error: 'invalid_item' }), { status: 422 }),
      'Saving failed. Your entry is still in the form — try again.',
    ],
    [
      'a rejected request',
      new Error('offline'),
      'Network error. Your entry is still in the form — try again.',
    ],
  ])('preserves entry fields after create receives %s', async (_name, failure, message) => {
    signedInAs()
    mockFetch([new Response(JSON.stringify([]), { status: 200 }), failure])
    const gtag = vi.fn()
    vi.stubGlobal('gtag', gtag)
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('The ledger is empty — add its first entry above.')
    await user.type(screen.getByLabelText('Title'), 'Shipped')
    await user.type(screen.getByLabelText('Notes'), 'First release')
    await user.click(screen.getByRole('button', { name: 'Add entry' }))

    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.getByLabelText('Title')).toHaveValue('Shipped')
    expect(screen.getByLabelText('Notes')).toHaveValue('First release')
    expect(gtag).not.toHaveBeenCalled()
  })

  it('returns to sign-in instead of preserving an entry after an unauthorized create', async () => {
    signedInAs()
    mockFetch([
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    ])
    const user = userEvent.setup()

    render(<App />)
    await screen.findByText('The ledger is empty — add its first entry above.')
    await user.type(screen.getByLabelText('Title'), 'Shipped')
    await user.click(screen.getByRole('button', { name: 'Add entry' }))

    expect(await screen.findByRole('button', { name: 'Open workspace' })).toBeVisible()
    expect(auth.getToken()).toBeNull()
  })
})
