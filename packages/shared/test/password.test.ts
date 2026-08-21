import { describe, expect, it } from 'vitest'
import { hashStretched, stretchPassword, verifyStretched } from '../src/password'

// iterations はテスト高速化のため小さくする(本番は 600k)
const ITER = 1000
const PEPPER = 'test-pepper-value'

describe('パスワード認証(クライアント stretch + サーバ pepper HMAC)', () => {
  it('正しいパスワードで検証が通る', async () => {
    const stretched = await stretchPassword(
      'correct horse battery staple',
      'user@example.com',
      ITER,
    )
    const stored = await hashStretched(stretched, PEPPER)
    expect(await verifyStretched(stretched, PEPPER, stored)).toBe(true)
  })

  it('誤ったパスワードは弾かれる', async () => {
    const stored = await hashStretched(
      await stretchPassword('right-password', 'user@example.com', ITER),
      PEPPER,
    )
    const wrong = await stretchPassword('wrong-password', 'user@example.com', ITER)
    expect(await verifyStretched(wrong, PEPPER, stored)).toBe(false)
  })

  it('email(salt)が違えば stretched も変わる', async () => {
    const a = await stretchPassword('same-password', 'a@example.com', ITER)
    const b = await stretchPassword('same-password', 'b@example.com', ITER)
    expect(a).not.toBe(b)
  })

  it('pepper が違えば検証は通らない(DB 漏えい単独では破れない)', async () => {
    const stretched = await stretchPassword('pw', 'user@example.com', ITER)
    const stored = await hashStretched(stretched, PEPPER)
    expect(await verifyStretched(stretched, 'different-pepper', stored)).toBe(false)
  })

  it('email は大文字小文字を正規化する', async () => {
    const lower = await stretchPassword('pw', 'User@Example.com', ITER)
    const exact = await stretchPassword('pw', 'user@example.com', ITER)
    expect(lower).toBe(exact)
  })

  it('壊れた保存形式は false を返す(throw しない)', async () => {
    const stretched = await stretchPassword('pw', 'user@example.com', ITER)
    expect(await verifyStretched(stretched, PEPPER, 'garbage')).toBe(false)
    expect(await verifyStretched(stretched, PEPPER, 'md5$abc')).toBe(false)
    // prefix は正しいが base64 として不正(atob が throw する系)でも false
    expect(await verifyStretched(stretched, PEPPER, 'hmac$!!!not-base64!!!')).toBe(false)
  })
})
