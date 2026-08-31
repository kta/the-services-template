import { env, SELF } from 'cloudflare:test'
import { NonRetryableError } from 'cloudflare:workflows'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Bindings,
  backupTarget,
  checkCapacity,
  checkFreshness,
  checkHealth,
  checkR2Policy,
  finalizeBackup,
  handleScheduled,
  performBackup,
  runBackupWorkflow,
  type StepLike,
} from '../src/index'
import { sha256Hex } from '../src/lib/backup'

const BASE = 'https://ops.test'

// 有効なダンプ(≥10,000 bytes・CREATE TABLE・sentinel テーブル(users)への INSERT)。
const validDump = `CREATE TABLE users (id text);\n${'INSERT INTO users VALUES (1);\n'.repeat(500)}`
const validDumpBytes = new TextEncoder().encode(validDump).byteLength
const validDumpSha256 = sha256Hex([new TextEncoder().encode(validDump)])

/**
 * D1 export を模したモック fetch(即 complete)。processing → complete の
 * ポーリング(と間隔待ち)は d1-export.test.ts が担当するので、ここでは実待機を
 * 発生させない。
 */
function mockExportFetch(dump: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/d1/database/')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            status: 'complete',
            result: { signed_url: 'https://api.cloudflare.com/signed/x.sql' },
          },
        }),
      )
    }
    // signed_url ダウンロード
    return new Response(dump, {
      headers: { 'content-length': String(new TextEncoder().encode(dump).byteLength) },
    })
  }) as unknown as typeof fetch
}

/** D1「Get database」REST を模したモック fetch(result.file_size を返す)。 */
function mockSizeFetch(bytesByDbCall: number | number[]): typeof fetch {
  const sizes = Array.isArray(bytesByDbCall) ? [...bytesByDbCall] : null
  let call = 0
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.includes('/d1/database/')) throw new Error(`unexpected url: ${url}`)
    const size = sizes ? (sizes[call++] ?? sizes[sizes.length - 1]) : (bytesByDbCall as number)
    return new Response(JSON.stringify({ success: true, result: { file_size: size } }))
  }) as unknown as typeof fetch
}

const MB = 1024 * 1024

afterEach(() => vi.restoreAllMocks())

describe('ops health endpoint', () => {
  it('GET /api/health は 200', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
  })
})

describe('performBackup', () => {
  const now = new Date('2026-07-12T02:00:00Z')

  it('検証合格 → R2 に世代 + latest.json を書き、backup_failed は送らない', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const summaries = await performBackup(
      env as unknown as Bindings,
      now,
      mockExportFetch(validDump),
    )

    expect(summaries.every((s) => s.ok)).toBe(true)
    // admin の世代が置かれている
    const listed = await env.BACKUPS.list({ prefix: 'admin/' })
    expect(listed.objects.length).toBeGreaterThanOrEqual(1)
    // latest.json が更新されている
    const latest = await env.BACKUPS.get('latest.json')
    expect(latest).not.toBeNull()
    expect((latest as R2ObjectBody).customMetadata).toMatchObject({
      kind: 'latest-manifest',
      accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
      bucketName: (env as unknown as Bindings).BACKUP_BUCKET_NAME,
    })
    const body = JSON.parse(await (latest as R2ObjectBody).text()) as {
      at: string
      targets: Record<string, { accountId?: string; databaseId?: string; sha256?: string }>
    }
    expect(body.at).toBe(now.toISOString())
    expect(body.targets.admin?.accountId).toBe((env as unknown as Bindings).CF_ACCOUNT_ID)
    expect(body.targets.admin?.databaseId).toBe((env as unknown as Bindings).ADMIN_DB_ID)
    expect(body.targets.admin?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // 失敗通知なし
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('検証不合格 → R2 に put されず ops.backup_failed を送る', async () => {
    const before = await env.BACKUPS.list({ prefix: 'admin/' })
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const smallDump = 'CREATE TABLE users (id);INSERT INTO users VALUES(1)'
    const summaries = await performBackup(
      env as unknown as Bindings,
      new Date('2026-07-13T02:00:00Z'),
      mockExportFetch(smallDump),
    )

    expect(summaries.every((s) => !s.ok)).toBe(true)
    // 世代は増えていない
    const after = await env.BACKUPS.list({ prefix: 'admin/' })
    expect(after.objects.length).toBe(before.objects.length)
    // backup_failed 通知(12h スロット冪等キー)
    expect(notifySpy).toHaveBeenCalled()
    const call = notifySpy.mock.calls[0]
    const sent = JSON.parse((call?.[1]?.body as string) ?? '{}') as { type: string; id: string }
    expect(sent.type).toBe('ops.backup_failed')
    expect(sent.id).toContain('backup_failed:2026-07-13')
  })

  it('31 世代目で最古を prune し 30 世代に保つ', async () => {
    // 既存の admin 世代を一旦掃除
    const existing = await env.BACKUPS.list({ prefix: 'admin/' })
    for (const o of existing.objects) await env.BACKUPS.delete(o.key)
    // 30 世代を用意
    for (let i = 1; i <= 30; i++) {
      await env.BACKUPS.put(`admin/2026-06-${String(i).padStart(2, '0')}T02-00-00.sql`, validDump)
    }
    // もう 1 世代バックアップ(合計 31 → prune で 30)
    const summary = await backupTarget(
      env as unknown as Bindings,
      {
        name: 'admin',
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        sentinelTable: 'users',
      },
      new Date('2026-07-20T02:00:00Z'),
      mockExportFetch(validDump),
    )
    expect(summary.ok).toBe(true)
    const after = await env.BACKUPS.list({ prefix: 'admin/' })
    expect(after.objects.length).toBe(30)
  })

  it('同一スロットの再実行は既存の検証済み世代を上書きしない', async () => {
    const now = new Date('2026-07-21T02:00:00Z')
    const key = 'admin/2026-07-21T02-00-00.sql'
    await env.BACKUPS.put(key, validDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: now.toISOString(),
      },
    })

    const summary = await backupTarget(
      env as unknown as Bindings,
      {
        name: 'admin',
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        sentinelTable: 'users',
      },
      now,
      mockExportFetch(validDump),
    )

    expect(summary).toMatchObject({
      target: 'admin',
      ok: true,
      key,
      bytes: validDumpBytes,
      sha256: validDumpSha256,
    })
    const existing = await env.BACKUPS.get(key)
    expect(await (existing as R2ObjectBody).text()).toBe(validDump)
  })

  it('再実行でも、前回 prune 失敗で残った世代を保持数まで整理する', async () => {
    const existing = await env.BACKUPS.list({ prefix: 'admin/' })
    if (existing.objects.length > 0) {
      await env.BACKUPS.delete(existing.objects.map((object) => object.key))
    }
    const now = new Date('2026-07-31T02:00:00Z')
    const key = 'admin/2026-07-31T02-00-00.sql'
    for (let day = 1; day <= 30; day += 1) {
      await env.BACKUPS.put(`admin/2026-06-${String(day).padStart(2, '0')}T02-00-00.sql`, validDump)
    }
    await env.BACKUPS.put(key, validDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: now.toISOString(),
      },
    })

    const summary = await backupTarget(
      env as unknown as Bindings,
      {
        name: 'admin',
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        sentinelTable: 'users',
      },
      now,
      mockExportFetch(validDump),
    )

    expect(summary.ok).toBe(true)
    const after = await env.BACKUPS.list({ prefix: 'admin/' })
    expect(after.objects).toHaveLength(30)
    expect(after.objects.some((object) => object.key === key)).toBe(true)
  })

  it('Error ではない export 失敗も安全な export_error に正規化する', async () => {
    const fetchThatThrowsString = (async () => {
      throw 'network unavailable'
    }) as unknown as typeof fetch
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const summary = await backupTarget(
      env as unknown as Bindings,
      { name: 'admin', databaseId: 'x', sentinelTable: 'users' },
      new Date('2026-07-20T06:00:00Z'),
      fetchThatThrowsString,
    )

    expect(summary).toEqual({ target: 'admin', ok: false, reason: 'export_error' })
    expect(logSpy).toHaveBeenCalledWith('backup target failed', 'admin', 'export_error')
  })
})

describe('checkFreshness', () => {
  it('latest が古ければ ops.backup_stale を送る', async () => {
    await env.BACKUPS.put('latest.json', JSON.stringify({ at: '2026-07-10T00:00:00Z' }))
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const stale = await checkFreshness(env as unknown as Bindings, new Date('2026-07-12T00:00:00Z'))
    expect(stale).toBe(true)
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      payload: { latest: string | null; staleTargets: string[] }
    }
    expect(sent.type).toBe('ops.backup_stale')
    expect(sent.payload.latest).toBe('2026-07-10T00:00:00Z')
    expect(sent.payload.staleTargets).toContain('admin')
  })

  it('partial success keeps each target timestamp so a fresh admin backup cannot hide a stale domain backup', async () => {
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: '2026-07-11T02:00:00Z',
        targets: {
          admin: {
            at: '2026-07-11T02:00:00Z',
            key: 'admin/old.sql',
            bytes: 10_000,
            sha256: 'a'.repeat(64),
            accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
            databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
          },
          domain: { at: '2026-07-11T02:00:00Z', key: 'domain/old.sql' },
        },
      }),
    )
    const now = new Date('2026-07-12T02:00:00Z')
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    await env.BACKUPS.put('admin/2026-07-12T02-00-00.sql', validDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: now.toISOString(),
      },
    })

    await finalizeBackup(env as unknown as Bindings, now, [
      {
        target: 'admin',
        ok: true,
        key: 'admin/2026-07-12T02-00-00.sql',
        bytes: validDumpBytes,
        sha256: validDumpSha256,
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
      },
      { target: 'domain', ok: false, reason: 'export_error' },
    ])

    const latest = await env.BACKUPS.get('latest.json')
    const body = JSON.parse(await (latest as R2ObjectBody).text()) as {
      targets: Record<string, { at: string; key?: string; bytes?: number; sha256?: string }>
    }
    expect(body.targets.admin).toEqual({
      at: now.toISOString(),
      key: 'admin/2026-07-12T02-00-00.sql',
      bytes: validDumpBytes,
      sha256: validDumpSha256,
      accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
      databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
    })
    expect(body.targets.domain).toEqual({ at: '2026-07-11T02:00:00Z', key: 'domain/old.sql' })

    const stale = await checkFreshness(env as unknown as Bindings, now)
    expect(stale).toBe(true)
    const staleCall = notifySpy.mock.calls
      .map((call) => JSON.parse((call[1]?.body as string) ?? '{}'))
      .find((job) => job.type === 'ops.backup_stale') as {
      payload: { latest: string; staleTargets: string[] }
    }
    expect(staleCall.payload.latest).toBe(now.toISOString())
    expect(staleCall.payload.staleTargets).toEqual(['domain'])
  })

  it('R2 integrity read failure is reported as monitor_failed, not as a silent stale result', async () => {
    const current = new Date('2026-07-12T02:00:00Z')
    const bindings = env as unknown as Bindings
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: current.toISOString(),
        targets: {
          admin: {
            at: current.toISOString(),
            key: 'admin/2026-07-12T02-00-00.sql',
            bytes: validDumpBytes,
            sha256: validDumpSha256,
            accountId: bindings.CF_ACCOUNT_ID,
            databaseId: bindings.ADMIN_DB_ID,
          },
        },
      }),
    )
    const headSpy = vi
      .spyOn(env.BACKUPS, 'head')
      .mockRejectedValue(new Error('r2 temporarily unavailable') as never)
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')

    const result = await checkFreshness(bindings, current)

    expect(result).toBe(true)
    expect(headSpy).toHaveBeenCalledWith('admin/2026-07-12T02-00-00.sql')
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      payload: { component: string; failed: Array<{ target: string; reason: string }> }
    }
    expect(sent.type).toBe('ops.monitor_failed')
    expect(sent.payload.component).toBe('freshness')
    expect(sent.payload.failed[0]).toEqual({ target: 'admin', reason: 'r2_read_failed' })
  })

  it('遅延した古い Workflow は latest の新しいターゲット世代を巻き戻さない', async () => {
    const newer = new Date('2026-07-13T02:00:00Z')
    const older = new Date('2026-07-12T02:00:00Z')
    const currentKey = 'admin/2026-07-13T02-00-00.sql'
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: newer.toISOString(),
        targets: {
          admin: {
            at: newer.toISOString(),
            key: currentKey,
            bytes: validDumpBytes,
            sha256: validDumpSha256,
            accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
            databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
          },
        },
      }),
    )

    await finalizeBackup(env as unknown as Bindings, older, [
      {
        target: 'admin',
        ok: true,
        key: 'admin/2026-07-12T02-00-00.sql',
        bytes: validDumpBytes,
        sha256: validDumpSha256,
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
      },
    ])

    const latest = await env.BACKUPS.get('latest.json')
    const body = JSON.parse(await (latest as R2ObjectBody).text()) as {
      at: string
      targets: Record<string, { at: string; key?: string }>
    }
    expect(body.at).toBe(newer.toISOString())
    expect(body.targets.admin).toMatchObject({ at: newer.toISOString(), key: currentKey })
  })

  it('production missing alert recipient fails closed without sending an invalid notifier job', async () => {
    await env.BACKUPS.put('latest.json', JSON.stringify({ at: '2026-07-10T00:00:00Z' }))
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const production = {
      ...(env as unknown as Bindings),
      APP_ENV: 'production',
      OPS_ALERT_EMAIL: '',
    } as unknown as Bindings

    expect(await checkFreshness(production, new Date('2026-07-12T00:00:00Z'))).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('production refuses to publish a manifest without the matching public signer key', async () => {
    const now = new Date('2026-07-12T02:00:00Z')
    const production = {
      ...(env as unknown as Bindings),
      APP_ENV: 'production',
      BACKUP_SIGNING_PRIVATE_KEY: 'private-key-present-but-invalid-for-this-test',
      BACKUP_SIGNING_PUBLIC_KEY: '',
    } as unknown as Bindings
    await expect(
      finalizeBackup(production, now, [
        {
          target: 'admin',
          ok: true,
          key: 'admin/2026-07-12T02-00-00.sql',
          bytes: validDumpBytes,
          sha256: validDumpSha256,
          accountId: production.CF_ACCOUNT_ID,
          databaseId: production.ADMIN_DB_ID,
        },
      ]),
    ).rejects.toThrow('backup_signing_key_invalid')
  })

  it('unknown APP_ENV values verify latest manifest signatures instead of trusting unsigned state', async () => {
    const now = new Date('2026-07-12T06:00:00Z')
    const key = 'admin/2026-07-12T00-00-00.sql'
    await env.BACKUPS.put(key, validDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: now.toISOString(),
      },
    })
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: now.toISOString(),
        targets: {
          admin: {
            at: now.toISOString(),
            key,
            bytes: validDumpBytes,
            sha256: validDumpSha256,
            accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
            databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
          },
        },
      }),
    )
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const staging = {
      ...(env as unknown as Bindings),
      APP_ENV: 'staging',
      OPS_ALERT_EMAIL: 'ops@example.com',
      BACKUP_SIGNING_PUBLIC_KEY: '',
    } as unknown as Bindings

    expect(await checkFreshness(staging, now)).toBe(true)
    expect(notifySpy).toHaveBeenCalled()
  })

  it('target-bound latest が新しければ通知しない', async () => {
    const now = new Date('2026-07-12T06:00:00Z')
    const key = 'admin/2026-07-12T00-00-00.sql'
    await env.BACKUPS.put(key, validDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    })
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: '2026-07-12T00:00:00Z',
        targets: {
          admin: {
            at: '2026-07-12T00:00:00.000Z',
            key,
            bytes: validDumpBytes,
            sha256: validDumpSha256,
            accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
            databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
          },
        },
      }),
    )
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const stale = await checkFreshness(env as unknown as Bindings, now)
    expect(stale).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('freshness は世代本文の SHA-256 と SQL 構造も検証する', async () => {
    const now = new Date('2026-07-12T06:00:00Z')
    const key = 'admin/2026-07-12T00-00-01.sql'
    const sameSizeCorruptDump = 'x'.repeat(validDumpBytes)
    await env.BACKUPS.put(key, sameSizeCorruptDump, {
      customMetadata: {
        target: 'admin',
        accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
        databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    })
    await env.BACKUPS.put(
      'latest.json',
      JSON.stringify({
        at: '2026-07-12T00:00:00.000Z',
        targets: {
          admin: {
            at: '2026-07-12T00:00:00.000Z',
            key,
            bytes: validDumpBytes,
            sha256: validDumpSha256,
            accountId: (env as unknown as Bindings).CF_ACCOUNT_ID,
            databaseId: (env as unknown as Bindings).ADMIN_DB_ID,
          },
        },
      }),
    )
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')

    expect(await checkFreshness(env as unknown as Bindings, now)).toBe(true)
    expect(notifySpy).toHaveBeenCalled()
  })
})

describe('checkHealth', () => {
  // NOTIFIER binding は死活プローブ先(/api/health)と通知送信(/api/internal/send)を
  // 兼ねるため、送信呼び出しだけを URL で抽出する。
  type SpyCalls = Array<[unknown, { body?: unknown } | undefined]>
  function sendCalls(calls: SpyCalls) {
    return calls.filter(([url]) => String(url).includes('/api/internal/send'))
  }

  it('非 200 のサービスを ops.health_check_failed で通知', async () => {
    vi.spyOn(env.ADMIN, 'fetch').mockResolvedValue(new Response('down', { status: 500 }) as never)
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const down = await checkHealth(env as unknown as Bindings, new Date('2026-07-12T06:30:00Z'))
    expect(down).toContain('admin')
    const sends = sendCalls(notifySpy.mock.calls as unknown as SpyCalls)
    expect(sends).toHaveLength(1)
    const sent = JSON.parse((sends[0]?.[1]?.body as string) ?? '{}') as { type: string }
    expect(sent.type).toBe('ops.health_check_failed')
  })

  it.each([201, 204])('2xx だが 200 ではない status=%s も停止扱いにする', async (status) => {
    vi.spyOn(env.ADMIN, 'fetch').mockResolvedValue(new Response(null, { status }) as never)
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const down = await checkHealth(env as unknown as Bindings, new Date('2026-07-12T06:30:00Z'))
    expect(down).toContain('admin')
    expect(sendCalls(notifySpy.mock.calls as unknown as SpyCalls)).toHaveLength(1)
  })

  it('全て 200 なら送信通知はしない', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const down = await checkHealth(env as unknown as Bindings, new Date('2026-07-12T06:30:00Z'))
    expect(down).toEqual([])
    expect(sendCalls(notifySpy.mock.calls as unknown as SpyCalls)).toHaveLength(0)
  })
})

describe('checkCapacity', () => {
  const now = new Date('2026-07-12T06:30:00Z')

  type SpyCalls = Array<[unknown, { body?: unknown } | undefined]>
  function sendCalls(calls: SpyCalls) {
    return calls.filter(([url]) => String(url).includes('/api/internal/send'))
  }

  it('閾値超の D1 を ops.capacity_warning で通知(冪等キーは日付スロット)', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const over = await checkCapacity(env as unknown as Bindings, now, mockSizeFetch(450 * MB))
    expect(over).toContain('admin')
    const sends = sendCalls(notifySpy.mock.calls as unknown as SpyCalls)
    expect(sends).toHaveLength(1)
    const sent = JSON.parse((sends[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      id: string
      payload: { thresholdMb: number; over: Array<{ target: string; mb: number }> }
    }
    expect(sent.type).toBe('ops.capacity_warning')
    expect(sent.id).toBe('capacity:2026-07-12')
    expect(sent.payload.thresholdMb).toBe(400)
    expect(sent.payload.over.map((o) => o.target)).toContain('admin')
  })

  it('閾値以下なら通知しない', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const over = await checkCapacity(env as unknown as Bindings, now, mockSizeFetch(100 * MB))
    expect(over).toEqual([])
    expect(sendCalls(notifySpy.mock.calls as unknown as SpyCalls)).toHaveLength(0)
  })

  it('REST 取得失敗の DB は明示通知し、例外にせず監視ループを継続する', async () => {
    // 対象が複数ある構成では 1 DB のエラーで他の監視が止まらないことを保証する。
    const failing = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/d1/database/')) throw new Error('unexpected')
      return new Response('err', { status: 500 })
    }) as unknown as typeof fetch
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const over = await checkCapacity(env as unknown as Bindings, now, failing)
    expect(over).toEqual([])
    const sends = sendCalls(notifySpy.mock.calls as unknown as SpyCalls)
    expect(sends).toHaveLength(1)
    const sent = JSON.parse((sends[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      payload: { component: string; failed: Array<{ target: string; reason: string }> }
    }
    expect(sent.type).toBe('ops.monitor_failed')
    expect(sent.payload.component).toBe('capacity')
    expect(sent.payload.failed[0]?.target).toBe('admin')
  })
})

describe('runBackupWorkflow (step 配線)', () => {
  // 実エンジンのリトライは再現できないため、配線(失敗の throw / NonRetryable 判定 /
  // reason の保持 / finalize の実行)をフェイク step で守る。
  function fakeStep() {
    const names: string[] = []
    const errors: unknown[] = []
    const step: StepLike = {
      do: async (name, _config, callback) => {
        names.push(name)
        try {
          return await callback()
        } catch (err) {
          errors.push(err)
          throw err
        }
      },
    }
    return { step, names, errors }
  }

  it('成功時: ターゲット毎 step → finalize、latest.json に世代キーを記録', async () => {
    const { step, names } = fakeStep()
    const summaries = await runBackupWorkflow(
      env as unknown as Bindings,
      step,
      mockExportFetch(validDump),
    )
    expect(summaries.every((s) => s.ok)).toBe(true)
    expect(names).toContain('resolve now')
    expect(names).toContain('backup admin')
    expect(names[names.length - 1]).toBe('finalize')
    // latest.json 経由でリストア手順が実キーを特定できる(r2 object list が無いため)
    const latest = await env.BACKUPS.get('latest.json')
    const body = JSON.parse(await (latest as R2ObjectBody).text()) as {
      summaries: Array<{ key?: string }>
    }
    expect(body.summaries[0]?.key).toMatch(/^admin\/.+\.sql$/)
  })

  it('検証失敗(too_small)は NonRetryableError で打ち切り、実 reason が通知に残る', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const { step, errors } = fakeStep()
    const smallDump = 'CREATE TABLE users (id);INSERT INTO users VALUES(1)'
    await expect(
      runBackupWorkflow(env as unknown as Bindings, step, mockExportFetch(smallDump)),
    ).rejects.toThrow('all_backup_targets_failed')
    // 決定的な検証失敗はリトライさせない
    expect(errors.some((e) => e instanceof NonRetryableError)).toBe(true)
    // reason が export_error に潰れず保持される(データ消失の兆候を一過性エラーに見せない)
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      payload: { failed: Array<{ reason: string }> }
    }
    expect(sent.type).toBe('ops.backup_failed')
    expect(sent.payload.failed[0]?.reason).toBe('too_small')
  })
})

describe('handleScheduled (Cron 振り分け)', () => {
  it('鮮度 Cron は checkFreshness + checkHealth + checkCapacity を走らせる(Workflow は起動しない)', async () => {
    await env.BACKUPS.put('latest.json', JSON.stringify({ at: '2026-07-12T06:00:00Z' }))
    // checkCapacity が既定 fetch で外部 API を叩かないようスタブ(閾値以下)。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { file_size: 1024 } })) as never,
    )
    const wfSpy = vi.spyOn(env.BACKUP_WF, 'create')
    await handleScheduled(
      { cron: '30 18,6 * * *' },
      env as unknown as Bindings,
      new Date('2026-07-12T06:30:00Z'),
    )
    expect(wfSpy).not.toHaveBeenCalled()
  })

  it('バックアップ枠 Cron は Workflow を起動する', async () => {
    const wfSpy = vi.spyOn(env.BACKUP_WF, 'create').mockResolvedValue({ id: 'wf1' } as never)
    await handleScheduled(
      { cron: '0 17,5 * * *' },
      env as unknown as Bindings,
      new Date('2026-07-12T02:00:00Z'),
    )
    expect(wfSpy).toHaveBeenCalledTimes(1)
  })

  it('Workflow の起動失敗は ops.backup_failed で通知する(丸 1 日無音にしない)', async () => {
    vi.spyOn(env.BACKUP_WF, 'create').mockRejectedValue(new Error('workflows down') as never)
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    await handleScheduled(
      { cron: '0 17,5 * * *' },
      env as unknown as Bindings,
      new Date('2026-07-12T17:00:00Z'),
    )
    expect(notifySpy).toHaveBeenCalled()
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      id: string
      payload: { failed: Array<{ target: string; reason: string }> }
    }
    expect(sent.type).toBe('ops.backup_failed')
    expect(sent.id).toBe('backup_failed:2026-07-12:pm')
    expect(sent.payload.failed[0]).toMatchObject({ target: 'workflow', reason: 'create_failed' })
  })

  it('未知の Cron は backup Workflow を起動せず設定エラーとして通知する', async () => {
    const wfSpy = vi.spyOn(env.BACKUP_WF, 'create')
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    await handleScheduled(
      { cron: '0 0 * * *' },
      env as unknown as Bindings,
      new Date('2026-07-12T00:00:00Z'),
    )
    expect(wfSpy).not.toHaveBeenCalled()
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      payload: { failed: Array<{ reason: string }> }
    }
    expect(sent.payload.failed[0]?.reason).toBe('cron_configuration_failed')
  })
})

describe('R2 public-access monitor', () => {
  it('production monitor verifies both managed and custom R2 domains', async () => {
    const calls: string[] = []
    const production = {
      ...(env as unknown as Bindings),
      APP_ENV: 'production',
      BACKUP_BUCKET_NAME: 'private-backups',
      R2_POLICY_CHECK_API_TOKEN: 'r2-policy-read-token',
    }
    const result = await checkR2Policy(production, new Date('2026-07-12T06:30:00Z'), (async (
      input,
    ) => {
      calls.push(String(input))
      return new Response(
        calls.length === 1
          ? JSON.stringify({ success: true, result: { enabled: false } })
          : JSON.stringify({ success: true, result: { domains: [] } }),
      )
    }) as typeof fetch)
    expect(result).toBe(false)
    expect(calls).toEqual([
      expect.stringContaining('/r2/buckets/private-backups/domains/managed'),
      expect.stringContaining('/r2/buckets/private-backups/domains/custom'),
    ])
  })

  it('production monitor notifies when R2 policy lookup fails', async () => {
    const notifySpy = vi.spyOn(env.NOTIFIER, 'fetch')
    const result = await checkR2Policy(
      {
        ...(env as unknown as Bindings),
        APP_ENV: 'production',
        BACKUP_BUCKET_NAME: 'private-backups',
        R2_POLICY_CHECK_API_TOKEN: 'r2-policy-read-token',
      },
      new Date('2026-07-12T06:30:00Z'),
      (async () =>
        new Response(JSON.stringify({ success: true, result: { enabled: true } }))) as typeof fetch,
    )
    expect(result).toBe(true)
    expect(notifySpy).toHaveBeenCalled()
    const sent = JSON.parse((notifySpy.mock.calls[0]?.[1]?.body as string) ?? '{}') as {
      type: string
      payload: { component: string }
    }
    expect(sent.type).toBe('ops.monitor_failed')
    expect(sent.payload.component).toBe('r2-public-access')
  })

  it('persists a secret-free fallback record when the notifier is unavailable', async () => {
    const bindings = {
      ...(env as unknown as Bindings),
      APP_ENV: 'production',
      OPS_ALERT_EMAIL: 'ops@example.com',
      BACKUP_BUCKET_NAME: 'private-backups',
      R2_POLICY_CHECK_API_TOKEN: 'r2-policy-read-token',
    }
    vi.spyOn(env.NOTIFIER, 'fetch').mockRejectedValue(new Error('notifier unavailable') as never)
    const result = await checkR2Policy(
      bindings,
      new Date('2026-07-12T06:30:00Z'),
      (async () =>
        new Response(JSON.stringify({ success: true, result: { enabled: true } }))) as typeof fetch,
    )

    expect(result).toBe(true)
    const stored = await env.BACKUPS.list({ prefix: 'monitor-failures/' })
    const records = await Promise.all(
      stored.objects.map(async (listed) => {
        const object = await env.BACKUPS.get(listed.key)
        if (!object) return null
        return JSON.parse(await (object as R2ObjectBody).text()) as {
          type: string
          payload: Record<string, unknown>
        }
      }),
    )
    const record = records.find((candidate) => candidate?.type === 'ops.monitor_failed')
    expect(record).toBeDefined()
    if (!record) throw new Error('missing monitor failure fallback record')
    const typedRecord = record as {
      type: string
      payload: Record<string, unknown>
    }
    expect(typedRecord.payload).not.toHaveProperty('apiToken')
  })
})
