import { getByText } from '@testing-library/dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  organization: null as string | null,
  getItems: vi.fn(),
  createItem: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('@app/shared', () => ({
  ANALYTICS_EVENTS: { LOGIN_SUCCESS: 'login_success', ITEM_CREATED: 'item_created' },
  auth: {
    getOrganization: () => state.organization,
    login: state.login,
    logout: state.logout,
  },
  trackEvent: vi.fn(),
}))

vi.mock('./client', () => ({
  client: {
    api: {
      items: {
        $get: state.getItems,
        $post: state.createItem,
      },
    },
  },
}))

import { App } from './App'

const emptyItems = () => new Response(JSON.stringify([]), { status: 200 })

describe('example service app', () => {
  afterEach(() => {
    state.organization = null
    state.getItems.mockReset()
    state.createItem.mockReset()
    state.login.mockReset()
    state.logout.mockReset()
  })

  it('validates the workspace id before opening a workspace', async () => {
    const user = userEvent.setup()
    state.login.mockResolvedValue(undefined)
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a workspace id to continue.')
    expect(state.login).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Workspace id'), 'org_acme')
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))
    await waitFor(() => expect(state.login).toHaveBeenCalledWith('org_acme'))
  })

  it('loads entries, validates a new title, and refreshes after saving', async () => {
    const user = userEvent.setup()
    state.organization = 'org_acme'
    state.getItems.mockResolvedValueOnce(emptyItems()).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'item-1',
            organizationId: 'org_acme',
            title: 'Shipped',
            body: 'First release',
            createdAt: '2026-08-22T00:00:00.000Z',
          },
        ]),
        { status: 200 },
      ),
    )
    state.createItem.mockResolvedValue(new Response('{}', { status: 201 }))

    render(<App />)
    expect(
      await screen.findByText('The ledger is empty — add its first entry above.'),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Add entry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('A title is required')

    await user.type(screen.getByLabelText('Title'), 'Shipped')
    await user.type(screen.getByLabelText('Notes'), 'First release')
    const form = screen.getByRole('button', { name: 'Add entry' }).closest('form')
    if (!form) throw new Error('item form is missing')
    fireEvent.submit(form)

    await waitFor(() => expect(state.createItem).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Shipped')).toBeVisible()
    expect(screen.getByText('First release')).toBeVisible()
    expect(getByText(document.body, 'Shipped')).toBeVisible()
  })
})
