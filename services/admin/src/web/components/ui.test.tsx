import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyState, PageHeader, Section, Spinner } from './ui'

describe('admin layout primitives', () => {
  it('renders optional headings and actions when they are supplied', () => {
    render(
      <>
        <PageHeader
          title="Organizations"
          sub="Manage tenants"
          actions={<button type="button">New</button>}
        />
        <Section
          title="Create"
          sub="Details"
          actions={<button type="button">Save</button>}
          className="extra"
        >
          Body
        </Section>
        <EmptyState>Nothing here</EmptyState>
        <Spinner label="Loading organizations" />
      </>,
    )

    expect(screen.getByRole('heading', { name: 'Organizations' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Create' })).toBeVisible()
    expect(screen.getByText('Details')).toBeVisible()
    expect(screen.getByText('Body')).toBeVisible()
    expect(screen.getByText('Nothing here')).toBeVisible()
    expect(screen.getByText('Loading organizations')).toBeVisible()
  })

  it('keeps a section usable without optional heading content', () => {
    render(<Section>Body only</Section>)
    expect(screen.getByText('Body only')).toBeVisible()
  })
})
