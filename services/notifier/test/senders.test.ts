import type { NotificationJob } from '@app/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatJob, LogSender, pickSender, ResendSender } from '../src/senders'

const job: NotificationJob = {
  id: 'user.invited:x',
  type: 'user.invited',
  to: 'staff@example.com',
  payload: { acceptUrl: 'https://app.test/invite?token=t' },
}

afterEach(() => vi.restoreAllMocks())

describe('pickSender', () => {
  it('RESEND_API_KEY 有りは ResendSender、MAIL_DEV_LOG=true は LogSender', () => {
    expect(pickSender({ RESEND_API_KEY: 'k' })).toBeInstanceOf(ResendSender)
    expect(pickSender({ MAIL_DEV_LOG: 'true' })).toBeInstanceOf(LogSender)
  })

  it('どちらも未設定なら fail close(throw)— 送信成功を偽装しない', () => {
    // RESEND_API_KEY を設定し忘れた本番が黙って LogSender に落ちると、招待は
    // 「送信済み」と報告されながら誰にも届かない(回帰テスト)。
    expect(() => pickSender({})).toThrow('no_sender_configured')
    expect(() => pickSender({ RESEND_API_KEY: '', MAIL_DEV_LOG: '' })).toThrow(
      'no_sender_configured',
    )
  })
})

describe('formatJob', () => {
  it('user.invited は acceptUrl を本文にそのまま含む(JSON のままにしない)', () => {
    const { subject, text } = formatJob(job)
    expect(subject).not.toBe('[user.invited]')
    // URL が引用符に包まれていない行として現れる(メールクライアントがリンク化できる)
    expect(text.split('\n')).toContain('https://app.test/invite?token=t')
    expect(text).not.toContain('{"acceptUrl"')
  })

  it('全種別で件名と本文が空にならない(取りこぼし検知)', () => {
    const types = [
      'item.created',
      'user.invited',
      'ops.backup_failed',
      'ops.backup_stale',
      'ops.health_check_failed',
      'ops.sync_drift',
      'ops.capacity_warning',
    ] as const
    for (const type of types) {
      const { subject, text } = formatJob({ id: `${type}:x`, type, to: 'a@b.test', payload: {} })
      expect(subject.length).toBeGreaterThan(0)
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('item.created は title を、無ければ itemId を本文に使う', () => {
    const base = { id: 'item.created:1', type: 'item.created' as const, to: 'a@b.test' }
    expect(formatJob({ ...base, payload: { title: 'T1' } }).text).toContain('T1')
    expect(formatJob({ ...base, payload: { itemId: 'i-9' } }).text).toContain('i-9')
  })

  it('ops 系は要旨 + 詳細 JSON', () => {
    const { subject, text } = formatJob({
      id: 'backup_failed:2026-07-12:am',
      type: 'ops.backup_failed',
      to: 'ops@example.com',
      payload: { failed: [{ target: 'admin', reason: 'export_timeout' }] },
    })
    expect(subject).toContain('バックアップ')
    expect(text).toContain('export_timeout')
  })
})

describe('LogSender', () => {
  it('例外を投げない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(new LogSender().send(job)).resolves.toBeUndefined()
  })
})

describe('ResendSender', () => {
  it('2xx なら idempotency-key 付きで送信', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    await new ResendSender('k').send(job)
    const init = spy.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(job.id)
  })

  it('from 未指定なら既定アドレスを使う', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    await new ResendSender('k').send(job)
    const init = spy.mock.calls[0]?.[1]
    expect(init).toBeDefined()
    if (!init) throw new Error('missing request init')
    const body = JSON.parse(init.body as string) as {
      from: string
    }
    expect(body.from).toBe('notifications@example.com')
  })

  it('from 指定(MAIL_FROM)を from に反映する', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    await new ResendSender('k', 'alerts@ops.example.com').send(job)
    const init = spy.mock.calls[0]?.[1]
    expect(init).toBeDefined()
    if (!init) throw new Error('missing request init')
    const body = JSON.parse(init.body as string) as {
      from: string
    }
    expect(body.from).toBe('alerts@ops.example.com')
  })

  it('from が空文字なら既定アドレスにフォールバック', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    await new ResendSender('k', '').send(job)
    const init = spy.mock.calls[0]?.[1]
    expect(init).toBeDefined()
    if (!init) throw new Error('missing request init')
    const body = JSON.parse(init.body as string) as {
      from: string
    }
    expect(body.from).toBe('notifications@example.com')
  })

  it('非2xx は throw(呼び出し側で 502)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }) as never)
    await expect(new ResendSender('k').send(job)).rejects.toThrow('resend failed')
  })
})

describe('pickSender は MAIL_FROM を ResendSender へ渡す', () => {
  it('RESEND_API_KEY 有り + MAIL_FROM で from が反映される', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as never)
    const sender = pickSender({ RESEND_API_KEY: 'k', MAIL_FROM: 'alerts@ops.example.com' })
    await sender.send(job)
    const init = spy.mock.calls[0]?.[1]
    expect(init).toBeDefined()
    if (!init) throw new Error('missing request init')
    const body = JSON.parse(init.body as string) as {
      from: string
    }
    expect(body.from).toBe('alerts@ops.example.com')
  })
})
