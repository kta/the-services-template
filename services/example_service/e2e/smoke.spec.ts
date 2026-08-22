import { type APIRequestContext, expect, test } from '@playwright/test'

async function issueToken(request: APIRequestContext, organizationId: string): Promise<string> {
  const response = await request.post('/api/auth/token', { data: { organizationId } })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { token: string }).token
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function unique(value: string): string {
  return `${value}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// e2e against the production build in workerd (`vite preview`): the same
// Worker serves the SPA and the API, so the whole flow works — dev-grant
// sign-in, create an entry, see it in the ledger.
// @e2e-covers AC-ITEM-01
test('sign in, add an entry, see it in the ledger', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Example Service' })).toBeVisible()

  await page.getByLabel('Workspace id').fill(unique('org-e2e'))
  await page.getByRole('button', { name: 'Open workspace' }).click()
  await expect(page.getByText('The ledger is empty — add its first entry above.')).toBeVisible()

  const title = unique('First entry')
  const create = page.waitForResponse(
    (response) => response.url().endsWith('/api/items') && response.request().method() === 'POST',
  )
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Add entry' }).click()
  expect((await create).status()).toBe(201)
  await expect(page.getByText(title)).toBeVisible()
  await page.reload()
  await expect(page.getByText(title)).toBeVisible()
})

// @e2e-covers AC-ITEM-02
test('item API rejects unauthenticated reads and writes', async ({ request }) => {
  const read = await request.get('/api/items')
  expect(read.status()).toBe(401)

  const write = await request.post('/api/items', { data: { title: 'Unauthenticated', body: '' } })
  expect(write.status()).toBe(401)
})

// @e2e-covers AC-ITEM-03
test('item API rejects empty and overlong titles', async ({ request }) => {
  const token = await issueToken(request, unique('org-invalid-item'))
  for (const title of ['', 'x'.repeat(201)]) {
    const response = await request.post('/api/items', {
      headers: authHeaders(token),
      data: { title, body: '' },
    })
    expect(response.status()).toBe(400)
  }
})

// @e2e-covers AC-ITEM-04
test('an organization cannot list an item created by another organization', async ({ request }) => {
  const orgA = unique('org-a')
  const orgB = unique('org-b')
  const title = unique('A-only')
  const tokenA = await issueToken(request, orgA)
  const tokenB = await issueToken(request, orgB)

  const created = await request.post('/api/items', {
    headers: authHeaders(tokenA),
    data: { title, body: '' },
  })
  expect(created.status()).toBe(201)

  const listForB = await request.get('/api/items', { headers: authHeaders(tokenB) })
  expect(listForB.status()).toBe(200)
  const items = (await listForB.json()) as Array<{ title: string }>
  expect(items).not.toContainEqual(expect.objectContaining({ title }))
})

// @e2e-covers AC-ITEM-05
test('creation persists and appears in the ledger when the notifier fixture returns non-2xx', async ({
  page,
  request,
}) => {
  const fixture = 'http://127.0.0.1:8788'
  const preflight = await request.post(`${fixture}/api/internal/send`, {
    data: {
      id: 'preflight-notification',
      type: 'item.created',
      to: 'preflight@example.test',
      payload: { itemId: 'preflight-item', title: 'preflight' },
    },
  })
  expect(preflight.status()).toBe(418)
  expect(preflight.headers()['x-e2e-notifier-fixture']).toBe('failure')

  const reset = await request.post(`${fixture}/__e2e/reset`)
  expect(reset.status()).toBe(200)
  expect(await reset.json()).toEqual({ calls: 0 })

  await page.goto('/')
  await page.getByLabel('Workspace id').fill(unique('org-notifier-fallback'))
  await page.getByRole('button', { name: 'Open workspace' }).click()
  await expect(page.getByText('The ledger is empty — add its first entry above.')).toBeVisible()
  const title = unique('best-effort-notification')

  const create = page.waitForResponse(
    (response) => response.url().endsWith('/api/items') && response.request().method() === 'POST',
  )
  await page.getByLabel('Title').fill(title)
  await page.getByRole('button', { name: 'Add entry' }).click()
  const createdResponse = await create
  expect(createdResponse.status()).toBe(201)
  const created = (await createdResponse.json()) as { id: string; title: string }
  expect(created.title).toBe(title)
  await expect(page.getByText(title)).toBeVisible()

  await expect
    .poll(async () => {
      const status = await request.get(`${fixture}/__e2e/status`)
      expect(status.status()).toBe(200)
      return ((await status.json()) as { calls: number }).calls
    })
    .toBeGreaterThanOrEqual(1)

  const status = await request.get(`${fixture}/__e2e/status`)
  expect(status.status()).toBe(200)
  const observed = (await status.json()) as {
    calls: number
    lastRequest: {
      headers: Record<string, string>
      job: {
        id: string
        payload: { itemId: string; title: string }
        to: string
        type: string
      }
      method: string
      pathname: string
    }
  }
  expect(observed.calls).toBeGreaterThanOrEqual(1)
  expect(observed.lastRequest).toMatchObject({
    method: 'POST',
    pathname: '/api/internal/send',
    job: {
      type: 'item.created',
      to: 'team@example.com',
      payload: { itemId: created.id, title },
    },
  })
  expect(observed.lastRequest.headers['content-type']).toContain('application/json')
  expect(observed.lastRequest.headers['x-internal-key']).toBeTruthy()
  expect(observed.lastRequest.job.id).toBe(`item.created:${created.id}`)
})
