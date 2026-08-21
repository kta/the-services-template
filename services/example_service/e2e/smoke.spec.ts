import { expect, test } from '@playwright/test'

// e2e against the production build in workerd (`vite preview`): the same
// Worker serves the SPA and the API, so the whole flow works — dev-grant
// sign-in, create an entry, see it in the ledger.
test('sign in, add an entry, see it in the ledger', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Example Service' })).toBeVisible()

  await page.getByLabel('Workspace id').fill(`org_e2e_${Date.now()}`)
  await page.getByRole('button', { name: 'Open workspace' }).click()

  const title = `First entry ${Date.now()}`
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Add entry' }).click()
  await expect(page.getByText(title)).toBeVisible()
})
