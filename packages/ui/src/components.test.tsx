import { getByText } from '@testing-library/dom'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Button,
  buttonClass,
  Card,
  Chip,
  cn,
  Dialog,
  Field,
  Notice,
  Select,
  Textarea,
  TextInput,
} from './index'

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

describe('shared UI primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    restoreDialogMethod('showModal', showModalDescriptor)
    restoreDialogMethod('close', closeDescriptor)
  })

  it('renders accessible form controls and wires a field error to its input', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(
      <>
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
        <TextInput aria-label="Title" />
        <Textarea aria-label="Notes" />
        <Select aria-label="Plan">
          <option>Free</option>
        </Select>
        <Field label="Email" htmlFor="email" error="Email is required">
          <TextInput id="email" />
        </Field>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('hover:bg-danger/5')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveClass('border-line')
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveClass('border-line')
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveValue('Free')
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Email is required')
    expect(getByText(document.body, 'Email is required')).toBeVisible()
  })

  it('renders every semantic status tone', () => {
    render(
      <>
        <Card className="custom-card">Card content</Card>
        <Chip tone="success">Saved</Chip>
        <Chip tone="warning">Review</Chip>
        <Chip tone="danger">Failed</Chip>
        <Chip>Waiting</Chip>
        <Notice tone="danger">Danger</Notice>
        <Notice tone="info">Info</Notice>
        <Notice tone="success">Success</Notice>
      </>,
    )

    expect(screen.getByText('Card content')).toHaveClass('custom-card')
    expect(screen.getByText('Saved')).toHaveClass('text-pine')
    expect(screen.getByText('Review')).toHaveClass('text-amber-deep')
    expect(screen.getByText('Failed')).toHaveClass('text-danger')
    expect(screen.getByText('Waiting')).toHaveClass('text-ink-muted')
    expect(screen.getByRole('alert')).toHaveTextContent('Danger')
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('uses the supplied variant when composing button classes', () => {
    expect(buttonClass()).toContain('bg-pine')
    expect(buttonClass('ghost', 'extra')).toContain('extra')
    expect(buttonClass('danger')).toContain('hover:bg-danger/5')
    expect(cn('first', false, null, undefined, 'second')).toBe('first second')
  })

  it('opens and closes a native dialog while forwarding close events', () => {
    const onClose = vi.fn()
    const showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    const close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
    Object.defineProperty(dialogPrototype, 'showModal', {
      configurable: true,
      value: showModal,
    })
    Object.defineProperty(dialogPrototype, 'close', {
      configurable: true,
      value: close,
    })

    const { rerender } = render(
      <Dialog open labelledBy="dialog-title" onClose={onClose}>
        <h2 id="dialog-title">Confirm</h2>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(showModal).toHaveBeenCalledTimes(1)
    fireEvent(dialog, new Event('close'))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <Dialog open={false} labelledBy="dialog-title" onClose={onClose} disableEscape>
        <h2 id="dialog-title">Confirm</h2>
      </Dialog>,
    )
    expect(close).toHaveBeenCalledTimes(1)
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
  })
})
