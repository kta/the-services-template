import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { toast } from '../store/toast'
import { Toaster } from './Toaster'

describe('Toaster', () => {
  afterEach(() => {
    cleanup()
    toast.clear()
  })

  it('announces each toast tone and lets the user dismiss an individual toast', async () => {
    const user = userEvent.setup()
    toast.success('Saved')
    toast.error('Failed')
    toast.info('Working')
    render(<Toaster />)

    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
    expect(screen.getByText('Working')).toBeVisible()
    expect(screen.getAllByRole('status')).toHaveLength(2)
    const savedToast = screen
      .getAllByRole('status')
      .find((notification) => notification.textContent?.includes('Saved'))
    if (!savedToast) throw new Error('saved notification is missing')
    await user.click(within(savedToast).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})
