import { describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  AuthSessionCheckRequest,
  AuthSessionStatus,
  AuthTokenPayload,
  AuthUser,
  CreateItem,
  DOMAIN_ACCESS_TOKEN_AUDIENCE,
  domainAccessTokenAudience,
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

describe('AuthTokenPayload', () => {
  it('ドメイン名からサービス固有の audience を作る', () => {
    expect(domainAccessTokenAudience('booking')).toBe('domain:booking')
    expect(() => domainAccessTokenAudience('bad-service')).toThrow()
  })

  it('新形クレームをパースできる', () => {
    const parsed = AuthTokenPayload.safeParse({
      sub: 'u1',
      org: 'o1',
      email: 'a@example.com',
      role: 'staff',
      exp: 1234567890,
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
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
      iss: ACCESS_TOKEN_ISSUER,
      aud: ACCESS_TOKEN_AUDIENCE,
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
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
      }).success,
    ).toBe(false)
  })

  it('issuer/audience の欠落や不一致は弾く', () => {
    const base = {
      sub: 'u1',
      org: 'o1',
      email: 'a@example.com',
      role: 'staff' as const,
      exp: 1,
    }
    expect(AuthTokenPayload.safeParse(base).success).toBe(false)
    expect(
      AuthTokenPayload.safeParse({
        ...base,
        iss: 'other-issuer',
        aud: ACCESS_TOKEN_AUDIENCE,
      }).success,
    ).toBe(false)
    expect(
      AuthTokenPayload.safeParse({
        ...base,
        iss: ACCESS_TOKEN_ISSUER,
        aud: 'other-audience',
      }).success,
    ).toBe(false)
    expect(
      AuthTokenPayload.safeParse({
        ...base,
        iss: ACCESS_TOKEN_ISSUER,
        aud: DOMAIN_ACCESS_TOKEN_AUDIENCE,
      }).success,
    ).toBe(true)
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
  it('認証入力のサイズ上限を適用する', () => {
    expect(
      LoginRequest.safeParse({ email: 'a@example.com', stretched: 'x'.repeat(513) }).success,
    ).toBe(false)
    expect(
      LoginRequest.safeParse({ email: `${'a'.repeat(310)}@example.com`, stretched: 'x' }).success,
    ).toBe(false)
    expect(IssueTokenRequest.safeParse({ organizationId: 'x'.repeat(129) }).success).toBe(false)
  })
})

describe('AuthSessionCheckRequest / AuthSessionStatus', () => {
  it('requires the session, user, and organization binding claims', () => {
    expect(AuthSessionCheckRequest.safeParse({ sid: 's1', sub: 'u1' }).success).toBe(false)
    expect(AuthSessionCheckRequest.parse({ sid: 's1', sub: 'u1', org: 'o1' })).toEqual({
      sid: 's1',
      sub: 'u1',
      org: 'o1',
    })
  })

  it('allows an inactive session to omit a role but never an active one', () => {
    expect(AuthSessionStatus.parse({ active: false, role: null })).toEqual({
      active: false,
      role: null,
    })
    expect(AuthSessionStatus.safeParse({ active: true, role: null }).success).toBe(true)
    expect(AuthSessionStatus.safeParse({ active: 'true', role: 'admin' }).success).toBe(false)
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
  it('同期バージョンを必須にし、plan/isDisabled を default する', () => {
    const parsed = Organization.parse({
      id: 'o1',
      name: 'Org',
      version: 3,
      createdAt: new Date().toISOString(),
    })
    expect(parsed.version).toBe(3)
    expect(parsed.plan).toBe('free')
    expect(parsed.isDisabled).toBe(false)
  })

  it('同期バージョンが無い payload は受け付けない', () => {
    expect(
      Organization.safeParse({
        id: 'o1',
        name: 'Org',
        createdAt: new Date().toISOString(),
      }).success,
    ).toBe(false)
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
    expect(
      NotificationJob.safeParse({
        id: 'monitor-1',
        type: 'ops.monitor_failed',
        to: 'ops@example.com',
        payload: { component: 'capacity', failed: [{ target: 'admin', reason: 'request_failed' }] },
      }).success,
    ).toBe(true)
  })
  it('宛先・識別子・payload のサイズを制限する', () => {
    expect(
      NotificationJob.safeParse({ id: 'x'.repeat(257), type: 'user.invited', to: 'a@b.test' })
        .success,
    ).toBe(false)
    expect(
      NotificationJob.safeParse({ id: 'j', type: 'user.invited', to: 'not-an-email' }).success,
    ).toBe(false)
    expect(
      NotificationJob.safeParse({
        id: 'j',
        type: 'user.invited',
        to: 'a@b.test',
        payload: { value: 'x'.repeat(17_000) },
      }).success,
    ).toBe(false)
    expect(
      NotificationJob.safeParse({ id: 'job\nforged', type: 'user.invited', to: 'a@b.test' })
        .success,
    ).toBe(false)
  })
  it('payload のフィールド数上限と循環参照を拒否する', () => {
    const tooManyFields = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`field-${index}`, index]),
    )
    expect(
      NotificationJob.safeParse({
        id: 'j',
        type: 'user.invited',
        to: 'a@b.test',
        payload: tooManyFields,
      }).success,
    ).toBe(false)

    const cyclicPayload: Record<string, unknown> = {}
    cyclicPayload.self = cyclicPayload
    expect(
      NotificationJob.safeParse({
        id: 'j',
        type: 'user.invited',
        to: 'a@b.test',
        payload: cyclicPayload,
      }).success,
    ).toBe(false)
  })
  it('未知の type は弾く', () => {
    expect(NotificationJob.safeParse({ id: 'j', type: 'unknown.type', to: 'x' }).success).toBe(
      false,
    )
  })
})
