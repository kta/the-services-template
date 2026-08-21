import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

/**
 * admin SPA の e2e。`vite preview` の実 workerd(同一オリジン /api・ローカル D1)に
 * 対して dev グラント(role=admin)でサインインし、運用フローを通す。
 *
 * サインインは dev グラントで admin JWT を発行し、bootstrap のフォールバックが読む
 * sessionStorage(app.admin.dev.token)へ退避して起動する(本番では
 * /api/auth/token が 404 でこの経路は成立しない)。
 */

async function mintAdminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/token', {
    data: { organizationId: 'admin-org', role: 'admin' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { token: string }).token
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    sessionStorage.setItem('app.admin.dev.token', t as string)
  }, token)
}

test('未認証はログインへ誘導される', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL(/\/login$/)
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible()
})

test('組織作成 → 招待 → プラン切替 → 無効化', async ({ page, request }) => {
  const token = await mintAdminToken(request)
  await signIn(page, token)

  // 組織一覧
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '組織' })).toBeVisible()

  // 組織を作成
  const name = `E2E Org ${Date.now()}`
  await page.getByLabel('組織名').fill(name)
  await page.getByRole('button', { name: '作成する' }).click()
  const row = page.locator('li', { hasText: name })
  await expect(row).toBeVisible()

  // 招待(notifier 未起動のためメール失敗 → acceptUrl 表示)
  await row.getByRole('button', { name: '招待' }).click()
  await page.getByLabel('メールアドレス').fill('staff@example.com')
  await page.getByRole('button', { name: '招待を送信' }).click()
  // 送信成功/失敗いずれでも閉じられる
  await page.getByRole('button', { name: '閉じる' }).click()

  // プラン切替(無料 → 契約)
  await row.getByRole('button', { name: '契約に変更' }).click()
  await expect(row.getByText('契約', { exact: true })).toBeVisible()

  // 無効化
  await row.getByRole('button', { name: '無効化' }).click()
  await expect(row.getByText('無効', { exact: true })).toBeVisible()
})
