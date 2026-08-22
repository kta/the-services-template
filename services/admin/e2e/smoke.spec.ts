import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

/**
 * admin SPA の e2e。`vite preview` の実 workerd(同一オリジン /api・ローカル D1)に
 * 対して dev グラント(role=admin)でサインインし、運用フローを通す。
 *
 * サインインは dev グラントで admin JWT を発行し、bootstrap のフォールバックが読む
 * sessionStorage(app.admin.dev.token)へ退避して起動する(本番では
 * /api/auth/token が 404 でこの経路は成立しない)。
 */

async function mintAdminToken(request: APIRequestContext, organizationId: string): Promise<string> {
  const res = await request.post('/api/auth/token', {
    data: { organizationId, role: 'admin' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { token: string }).token
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    sessionStorage.setItem('app.admin.dev.token', t as string)
  }, token)
}

function unique(value: string): string {
  return `${value}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

test('未認証はログインへ誘導される', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL(/\/login$/)
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible()
})

test('組織作成 → notifier unavailable fallback → プラン切替 → 無効化', async ({
  page,
  request,
}) => {
  const operatorOrgId = unique('operator-e2e')
  const token = await mintAdminToken(request, operatorOrgId)
  await signIn(page, token)

  // dev token grant が作る operator org だけがある。前回の D1 状態が残れば件数が増える。
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '組織', exact: true })).toBeVisible()
  await expect(page.getByText('1 組織を管理しています')).toBeVisible()
  await expect(page.locator('li', { hasText: operatorOrgId })).toBeVisible()

  // 組織を作成
  const name = unique('E2E Org')
  await page.getByLabel('組織名').fill(name)
  await page.getByRole('button', { name: '作成する' }).click()
  const row = page.locator('li', { hasText: name })
  await expect(row).toBeVisible()

  // notifier 未到達でも招待作成自体は 201。手動共有用の acceptUrl をダイアログで返す。
  await row.getByRole('button', { name: '招待' }).click()
  const inviteDialog = page.getByRole('dialog', { name: `担当者を招待 — ${name}` })
  const invitee = `${unique('staff')}@example.test`
  const inviteResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/organizations/') &&
      response.url().endsWith('/invitations') &&
      response.request().method() === 'POST',
  )
  await inviteDialog.getByLabel('メールアドレス').fill(invitee)
  await inviteDialog.getByRole('button', { name: '招待を送信' }).click()
  const response = await inviteResponse
  expect(response.status()).toBe(201)
  const invitation = (await response.json()) as { emailed: boolean; acceptUrl?: string }
  expect(invitation.emailed).toBe(false)
  expect(invitation.acceptUrl).toMatch(/^http:\/\/localhost:4174\/invite\?token=/)
  await expect(inviteDialog.getByRole('alert')).toContainText(
    'メール送信に失敗しました。以下のリンクを手動で共有してください',
  )
  await expect(inviteDialog.getByText(invitation.acceptUrl ?? '', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(inviteDialog).toBeVisible()
  await inviteDialog.getByRole('button', { name: '閉じる', exact: true }).click()
  await expect(inviteDialog).toBeHidden()

  // プラン切替(無料 → 契約)
  await row.getByRole('button', { name: '契約に変更' }).click()
  await expect(row.getByText('契約', { exact: true })).toBeVisible()

  // 無効化
  await row.getByRole('button', { name: '無効化' }).click()
  await expect(row.getByText('無効', { exact: true })).toBeVisible()
})
