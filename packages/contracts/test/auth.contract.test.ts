import { describe, expect, it } from 'vitest'
import {
  AuthTokenPayload,
  AuthUser,
  CreateItem,
  InviteRequest,
  IssueTokenRequest,
  LoginRequest,
  NotificationJob,
  Organization,
} from '../src/index'

describe('Zod 4 migration semantics', () => {
  it.each([
    ['AuthUser.id', AuthUser, { email: 'a@example.com', role: 'staff' }],
    ['CreateItem.title', CreateItem, { body: '' }],
    ['NotificationJob.to', NotificationJob, { id: 'job-1', type: 'user.invited' }],
  ])('%s は省略できない', (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false)
  })

  it('default と optionality を適用した出力キーを固定する', () => {
    expect(CreateItem.parse({ title: 'Item' })).toEqual({ title: 'Item', body: '' })
    expect(
      NotificationJob.parse({ id: 'job-1', type: 'user.invited', to: 'a@example.com' }),
    ).toEqual({
      id: 'job-1',
      type: 'user.invited',
      to: 'a@example.com',
      payload: {},
    })
  })
})

describe('AuthTokenPayload(旧クレームとの互換)', () => {
  it('新形クレームをパースできる', () => {
    const parsed = AuthTokenPayload.safeParse({
      sub: 'u1',
      org: 'o1',
      email: 'a@example.com',
      role: 'staff',
      exp: 1234567890,
    })
    expect(parsed.success).toBe(true)
  })
  it('passthrough: 未知クレームを落とさない(前方互換)', () => {
    const parsed = AuthTokenPayload.parse({
      sub: 'u1',
      org: 'o1',
      email: 'a@example.com',
      role: 'admin',
      exp: 1,
      extra: 'kept',
    })
    expect((parsed as Record<string, unknown>).extra).toBe('kept')
  })
  it('role 不正は弾く', () => {
    expect(
      AuthTokenPayload.safeParse({
        sub: 'u1',
        org: 'o1',
        email: 'a@example.com',
        role: 'root',
        exp: 1,
      }).success,
    ).toBe(false)
  })
})

describe('LoginRequest / InviteRequest(strict)', () => {
  it('余分なフィールドは弾く(strict)', () => {
    expect(
      LoginRequest.safeParse({ email: 'a@example.com', stretched: 'x', extra: 1 }).success,
    ).toBe(false)
  })
  it('InviteRequest は role を staff に default する', () => {
    const parsed = InviteRequest.parse({ email: 'a@example.com' })
    expect(parsed.role).toBe('staff')
  })
  it('InviteRequest は余分なフィールドを弾く(strict)', () => {
    expect(InviteRequest.safeParse({ email: 'a@example.com', orgName: 'Org' }).success).toBe(false)
  })
})

describe('IssueTokenRequest(dev グラント)', () => {
  it('role/email を default する(旧テンプレ呼び出しの上位互換)', () => {
    const parsed = IssueTokenRequest.parse({ organizationId: 'o1' })
    expect(parsed.role).toBe('staff')
    expect(parsed.email).toBe('dev@example.com')
  })
})

describe('Organization(同期 upsert 契約)', () => {
  it('plan/isDisabled を default し、旧形データもパースできる', () => {
    const parsed = Organization.parse({
      id: 'o1',
      name: 'Org',
      createdAt: new Date().toISOString(),
    })
    expect(parsed.plan).toBe('free')
    expect(parsed.isDisabled).toBe(false)
  })
})

describe('NotificationJob(同期送信 API の body)', () => {
  it('ops 系の通知型を受け付ける', () => {
    const parsed = NotificationJob.safeParse({
      id: 'job-1',
      type: 'ops.capacity_warning',
      to: 'ops@example.com',
    })
    expect(parsed.success).toBe(true)
  })
  it('未知の type は弾く', () => {
    expect(NotificationJob.safeParse({ id: 'j', type: 'unknown.type', to: 'x' }).success).toBe(
      false,
    )
  })
})
