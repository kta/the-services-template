import { getByText } from '@testing-library/dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { toast } from '../store/toast'
import { Toaster } from './Toaster'

describe('Toaster', () => {
  afterEach(() => toast.clear())

  it('renders user-visible tones and lets the user dismiss a toast', () => {
    toast.success('Saved')
    toast.error('Failed')
    toast.info('Working')
    render(<Toaster />)

    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
    expect(getByText(document.body, 'Working')).toBeVisible()
    expect(screen.getAllByRole('status')).toHaveLength(2)
    const closeButton = screen.getAllByRole('button', { name: '閉じる' })[0]
    if (!closeButton) throw new Error('toast close button is missing')
    fireEvent.click(closeButton)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})
