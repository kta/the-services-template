import type { Organization, Plan } from '@app/contracts'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '../store/toast'

type CreateRequest = { json: { name: string; plan: Plan } }
type PatchRequest = { param: { id: string }; json: { plan?: Plan; isDisabled?: boolean } }
type DeleteRequest = { param: { id: string } }
type InviteRequest = { param: { id: string }; json: { email: string; role: 'staff' } }

const api = vi.hoisted(() => ({
  getOrganizations: vi.fn<() => Promise<Response>>(),
  createOrganization: vi.fn<(request: CreateRequest) => Promise<Response>>(),
  patchOrganization: vi.fn<(request: PatchRequest) => Promise<Response>>(),
  deleteOrganization: vi.fn<(request: DeleteRequest) => Promise<Response>>(),
  createInvitation: vi.fn<(request: InviteRequest) => Promise<Response>>(),
}))

vi.mock('../client', async () => {
  const actual = await vi.importActual<typeof import('../client')>('../client')
  return {
    ...actual,
    client: {
      api: {
        organizations: {
          $get: api.getOrganizations,
          $post: api.createOrganization,
          ':id': {
            $patch: api.patchOrganization,
            $delete: api.deleteOrganization,
            invitations: { $post: api.createInvitation },
          },
        },
      },
    },
  }
})

import { Orgs } from './Orgs'

const dialogPrototype = HTMLDialogElement.prototype
const showModalDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'close')

function installDialogShim(): void {
  Object.defineProperty(dialogPrototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(dialogPrototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
}

function restoreDialogShim(): void {
  if (showModalDescriptor) Object.defineProperty(dialogPrototype, 'showModal', showModalDescriptor)
  else Reflect.deleteProperty(dialogPrototype, 'showModal')
  if (closeDescriptor) Object.defineProperty(dialogPrototype, 'close', closeDescriptor)
  else Reflect.deleteProperty(dialogPrototype, 'close')
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Acme Inc.',
    plan: 'free',
    isDisabled: false,
    createdAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}

function deferredResponse(): {
  promise: Promise<Response>
  resolve: (value: Response) => void
} {
  let resolve: (value: Response) => void = () => undefined
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderOrgs() {
  return render(<Orgs />)
}

describe('Orgs', () => {
  beforeEach(() => {
    installDialogShim()
    api.getOrganizations.mockReset()
    api.createOrganization.mockReset()
    api.patchOrganization.mockReset()
    api.deleteOrganization.mockReset()
    api.createInvitation.mockReset()
    toast.clear()
  })

  afterEach(() => {
    restoreDialogShim()
    toast.clear()
  })

  it('shows a loading announcement until the organization request completes', async () => {
    const pending = deferredResponse()
    api.getOrganizations.mockReturnValue(pending.promise)

    renderOrgs()

    expect(screen.getByText('読み込み中')).toBeVisible()
    pending.resolve(response([]))
    expect(await screen.findByText(/まだ組織がありません/)).toBeVisible()
  })

  it('explains how to create an organization when the list is empty', async () => {
    api.getOrganizations.mockResolvedValue(response([]))

    renderOrgs()

    expect(await screen.findByText(/まだ組織がありません/)).toBeVisible()
  })

  it('renders each organization and its available operations', async () => {
    api.getOrganizations.mockResolvedValue(response([organization()]))

    renderOrgs()

    expect(await screen.findByText('Acme Inc.')).toBeVisible()
    expect(screen.getByText('1 組織を管理しています')).toBeVisible()
    expect(screen.getByRole('button', { name: '招待' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '契約に変更' })).toBeEnabled()
  })

  it('surfaces an unauthenticated request and lets the user reload the list', async () => {
    const user = userEvent.setup()
    api.getOrganizations
      .mockResolvedValueOnce(response({ error: 'unauthorized' }, 401))
      .mockResolvedValueOnce(response([organization()]))

    renderOrgs()

    expect(await screen.findByRole('alert')).toHaveTextContent('組織を読み込めませんでした')
    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(await screen.findByText('Acme Inc.')).toBeVisible()
  })

  it('surfaces a network error instead of leaving the list in its loading state', async () => {
    api.getOrganizations.mockRejectedValue(new Error('offline'))

    renderOrgs()

    expect(await screen.findByRole('alert')).toHaveTextContent('組織を読み込めませんでした')
    expect(screen.queryByText('読み込み中')).not.toBeInTheDocument()
  })

  it('does not submit a whitespace-only organization name', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([]))

    renderOrgs()
    await screen.findByText(/まだ組織がありません/)
    await user.type(screen.getByLabelText('組織名'), '   ')

    expect(screen.getByRole('button', { name: '作成する' })).toBeDisabled()
    expect(api.createOrganization).not.toHaveBeenCalled()
  })

  it('creates an organization with the selected plan and refreshes the visible list', async () => {
    const user = userEvent.setup()
    api.getOrganizations
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([organization({ name: 'Northwind', plan: 'contracted' })]))
    api.createOrganization.mockResolvedValue(response(organization({ name: 'Northwind' }), 201))

    renderOrgs()
    await screen.findByText(/まだ組織がありません/)
    await user.type(screen.getByLabelText('組織名'), '  Northwind  ')
    await user.selectOptions(screen.getByLabelText('プラン'), 'contracted')
    await user.click(screen.getByRole('button', { name: '作成する' }))

    expect(await screen.findByText('Northwind')).toBeVisible()
    expect(api.createOrganization).toHaveBeenCalledWith({
      json: { name: 'Northwind', plan: 'contracted' },
    })
  })

  it('keeps entered organization values visible when creation fails', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([]))
    api.createOrganization.mockResolvedValue(response({ error: 'email_taken' }, 409))

    renderOrgs()
    await screen.findByText(/まだ組織がありません/)
    await user.type(screen.getByLabelText('組織名'), 'Northwind')
    await user.selectOptions(screen.getByLabelText('プラン'), 'contracted')
    await user.click(screen.getByRole('button', { name: '作成する' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('組織の作成に失敗しました')
    expect(screen.getByLabelText('組織名')).toHaveValue('Northwind')
    expect(screen.getByLabelText('プラン')).toHaveValue('contracted')
  })

  it('changes a plan and refreshes the row with the updated plan', async () => {
    const user = userEvent.setup()
    api.getOrganizations
      .mockResolvedValueOnce(response([organization()]))
      .mockResolvedValueOnce(response([organization({ plan: 'contracted' })]))
    api.patchOrganization.mockResolvedValue(response(organization({ plan: 'contracted' })))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '契約に変更' }))

    expect(await screen.findByRole('button', { name: '無料に変更' })).toBeEnabled()
    expect(api.patchOrganization).toHaveBeenCalledWith({
      param: { id: 'org-1' },
      json: { plan: 'contracted' },
    })
  })

  it('requires an email before an invitation can be submitted', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '招待' }))

    expect(screen.getByRole('dialog', { name: '担当者を招待 — Acme Inc.' })).toBeVisible()
    expect(screen.getByRole('button', { name: '招待を送信' })).toBeDisabled()
  })

  it('confirms a successfully emailed invitation', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))
    api.createInvitation.mockResolvedValue(response({ emailed: true }, 201))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '招待' }))
    await user.type(screen.getByLabelText('メールアドレス'), 'staff@example.com')
    await user.click(screen.getByRole('button', { name: '招待を送信' }))

    expect(await screen.findByText('招待メールを送信しました。')).toBeVisible()
    expect(api.createInvitation).toHaveBeenCalledWith({
      param: { id: 'org-1' },
      json: { email: 'staff@example.com', role: 'staff' },
    })
  })

  it('displays the one-time sharing link when email delivery falls back', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))
    api.createInvitation.mockResolvedValue(
      response({ emailed: false, acceptUrl: 'https://admin.test/invite?token=one-time' }, 201),
    )

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '招待' }))
    await user.type(screen.getByLabelText('メールアドレス'), 'staff@example.com')
    await user.click(screen.getByRole('button', { name: '招待を送信' }))

    expect(await screen.findByText('https://admin.test/invite?token=one-time')).toBeVisible()
  })

  it('reports an invitation failure without discarding the entered email', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))
    api.createInvitation.mockResolvedValue(response({ error: 'email_taken' }, 409))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '招待' }))
    await user.type(screen.getByLabelText('メールアドレス'), 'staff@example.com')
    await user.click(screen.getByRole('button', { name: '招待を送信' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('招待の送信に失敗しました')
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('staff@example.com')
  })

  it('lets the user cancel organization disabling before it changes the organization', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '削除' }))
    expect(screen.getByRole('dialog', { name: '組織を削除 — Acme Inc.' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))

    expect(screen.queryByRole('dialog', { name: '組織を削除 — Acme Inc.' })).not.toBeInTheDocument()
    expect(api.deleteOrganization).not.toHaveBeenCalled()
  })

  it('shows an error when organization disabling cannot be completed', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))
    api.deleteOrganization.mockResolvedValue(response({ error: 'not_found' }, 404))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '削除' }))
    await user.click(screen.getByRole('button', { name: '削除を確定' }))

    expect(await screen.findByText('削除に失敗しました。')).toBeVisible()
  })

  it('shows the disabled state after confirmed organization disabling', async () => {
    const user = userEvent.setup()
    api.getOrganizations
      .mockResolvedValueOnce(response([organization()]))
      .mockResolvedValueOnce(response([organization({ isDisabled: true })]))
    api.deleteOrganization.mockResolvedValue(response({ id: 'org-1', isDisabled: true }))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '削除' }))
    await user.click(screen.getByRole('button', { name: '削除を確定' }))
    expect(await screen.findByText(/削除しました/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '閉じる' }))

    expect(await screen.findByText('無効')).toBeVisible()
    expect(screen.getByRole('button', { name: '有効化' })).toBeEnabled()
  })

  it('reports a failed direct disable operation', async () => {
    const user = userEvent.setup()
    api.getOrganizations.mockResolvedValue(response([organization()]))
    api.patchOrganization.mockResolvedValue(response({ error: 'forbidden' }, 403))

    renderOrgs()
    await screen.findByText('Acme Inc.')
    await user.click(screen.getByRole('button', { name: '無効化' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('無効化に失敗しました')
  })
})
