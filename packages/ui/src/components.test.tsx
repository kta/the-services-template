import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button, Card, Chip, Field, Notice, Select, Textarea, TextInput } from './index'

describe('Button', () => {
  it('renders a non-submitting button by default while preserving supplied attributes and refs', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button aria-describedby="delete-help" disabled name="delete" ref={ref} value="item-42">
        Delete item
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Delete item' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('name', 'delete')
    expect(button).toHaveAttribute('value', 'item-42')
    expect(button).toHaveAttribute('aria-describedby', 'delete-help')
    expect(ref.current).toBe(button)
  })

  it.each([
    ['primary', 'bg-pine'],
    ['ghost', 'text-pine'],
    ['danger', 'text-danger'],
  ] as const)('renders the %s visual variant', (variant, expectedClass) => {
    render(<Button variant={variant}>{variant} action</Button>)

    expect(screen.getByRole('button', { name: `${variant} action` })).toHaveClass(expectedClass)
  })
})

describe('form controls', () => {
  it('exposes labels and supplied attributes on text, multiline, and select controls', () => {
    render(
      <>
        <Field label="Project title" htmlFor="title">
          <TextInput id="title" placeholder="Spring launch" required />
        </Field>
        <Field label="Notes" htmlFor="notes">
          <Textarea id="notes" maxLength={240} />
        </Field>
        <Field label="Plan" htmlFor="plan">
          <Select id="plan" defaultValue="team">
            <option value="free">Free</option>
            <option value="team">Team</option>
          </Select>
        </Field>
      </>,
    )

    expect(screen.getByRole('textbox', { name: 'Project title' })).toBeRequired()
    expect(screen.getByRole('textbox', { name: 'Project title' })).toHaveAttribute(
      'placeholder',
      'Spring launch',
    )
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveAttribute('maxlength', '240')
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveValue('team')
  })

  it('announces a field error and identifies the affected control', () => {
    render(
      <Field label="Email" htmlFor="email" error="Email is required">
        <TextInput id="email" />
      </Field>,
    )

    const input = screen.getByRole('textbox', { name: 'Email' })
    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('Email is required')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', error.id)
  })
})

describe('status primitives', () => {
  it('keeps card and chip content visible and applies each chip tone', () => {
    render(
      <>
        <Card>Project summary</Card>
        <Chip tone="success">Saved</Chip>
        <Chip tone="warning">Review needed</Chip>
        <Chip tone="danger">Failed</Chip>
        <Chip>Waiting</Chip>
      </>,
    )

    expect(screen.getByText('Project summary')).toBeVisible()
    expect(screen.getByText('Saved')).toHaveClass('text-pine')
    expect(screen.getByText('Review needed')).toHaveClass('text-amber-deep')
    expect(screen.getByText('Failed')).toHaveClass('text-danger')
    expect(screen.getByText('Waiting')).toHaveClass('text-ink-muted')
  })

  it.each([
    ['danger', 'Unable to save', 'alert'],
    ['info', 'Saved elsewhere', 'status'],
    ['success', 'Changes saved', 'status'],
  ] as const)('uses the %s live-region semantics', (tone, message, role) => {
    render(<Notice tone={tone}>{message}</Notice>)

    expect(screen.getByRole(role)).toHaveTextContent(message)
  })
})

describe('Button interactions', () => {
  it('forwards child actions only when enabled', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<Button onClick={onDelete}>Delete item</Button>)

    await user.click(screen.getByRole('button', { name: 'Delete item' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
