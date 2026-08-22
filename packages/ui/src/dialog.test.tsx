import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, Dialog } from './index'

const dialogPrototype = HTMLDialogElement.prototype
const showModalDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(dialogPrototype, 'close')

function restoreDialogMethod(
  name: 'showModal' | 'close',
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(dialogPrototype, name, descriptor)
  else Reflect.deleteProperty(dialogPrototype, name)
}

function installNativeDialogShim() {
  let focusBeforeOpening: HTMLElement | null = null

  Object.defineProperty(dialogPrototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      focusBeforeOpening =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      this.setAttribute('open', '')
      this.setAttribute('tabindex', '-1')
      this.focus()
    },
  })
  Object.defineProperty(dialogPrototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
      focusBeforeOpening?.focus()
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  restoreDialogMethod('showModal', showModalDescriptor)
  restoreDialogMethod('close', closeDescriptor)
})

describe('Dialog', () => {
  it('keeps its content out of the accessible tree while closed', () => {
    installNativeDialogShim()

    render(
      <Dialog open={false} labelledBy="closed-dialog-title" onClose={vi.fn()}>
        <h2 id="closed-dialog-title">Delete project</h2>
      </Dialog>,
    )

    expect(screen.queryByRole('dialog', { name: 'Delete project' })).not.toBeInTheDocument()
  })

  it('exposes an accessible title and visible description while forwarding child actions', async () => {
    installNativeDialogShim()
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onConfirm = vi.fn()

    render(
      <Dialog open labelledBy="delete-dialog-title" onClose={onClose}>
        <h2 id="delete-dialog-title">Delete project</h2>
        <p>This cannot be undone.</p>
        <Button onClick={onConfirm}>Delete project</Button>
        <Button onClick={onClose}>Close dialog</Button>
      </Dialog>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Delete project' })
    expect(screen.getByText('This cannot be undone.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(dialog).toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('places focus in the native dialog and restores it when controlled open state closes', () => {
    installNativeDialogShim()
    const onClose = vi.fn()
    const { rerender } = render(
      <>
        <button type="button">Open dialog</button>
        <Dialog open={false} labelledBy="focus-dialog-title" onClose={onClose}>
          <h2 id="focus-dialog-title">Confirm archive</h2>
        </Dialog>
      </>,
    )

    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    rerender(
      <>
        <button type="button">Open dialog</button>
        <Dialog open labelledBy="focus-dialog-title" onClose={onClose}>
          <h2 id="focus-dialog-title">Confirm archive</h2>
        </Dialog>
      </>,
    )

    expect(screen.getByRole('dialog', { name: 'Confirm archive' })).toHaveFocus()

    rerender(
      <>
        <button type="button">Open dialog</button>
        <Dialog open={false} labelledBy="focus-dialog-title" onClose={onClose}>
          <h2 id="focus-dialog-title">Confirm archive</h2>
        </Dialog>
      </>,
    )

    expect(screen.queryByRole('dialog', { name: 'Confirm archive' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('allows native Escape dismissal but blocks it when escape is disabled', () => {
    installNativeDialogShim()
    const onClose = vi.fn()
    const { rerender } = render(
      <Dialog open labelledBy="escape-dialog-title" onClose={onClose}>
        <h2 id="escape-dialog-title">Confirm archive</h2>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Confirm archive' }) as HTMLDialogElement
    const cancel = new Event('cancel', { cancelable: true })

    fireEvent(dialog, cancel)
    expect(cancel.defaultPrevented).toBe(false)
    if (!cancel.defaultPrevented) dialog.close()
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <Dialog open={false} labelledBy="escape-dialog-title" onClose={onClose}>
        <h2 id="escape-dialog-title">Confirm archive</h2>
      </Dialog>,
    )
    rerender(
      <Dialog open labelledBy="escape-dialog-title" onClose={onClose} disableEscape>
        <h2 id="escape-dialog-title">Confirm archive</h2>
      </Dialog>,
    )
    const protectedDialog = screen.getByRole('dialog', { name: 'Confirm archive' })
    const protectedCancel = new Event('cancel', { cancelable: true })

    fireEvent(protectedDialog, protectedCancel)
    expect(protectedCancel.defaultPrevented).toBe(true)
    expect(protectedDialog).toHaveAttribute('open')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss when the dialog surface is clicked', async () => {
    installNativeDialogShim()
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog open labelledBy="backdrop-dialog-title" onClose={onClose}>
        <h2 id="backdrop-dialog-title">Confirm archive</h2>
      </Dialog>,
    )

    await user.click(screen.getByRole('dialog', { name: 'Confirm archive' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
