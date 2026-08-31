import { describe, expect, it } from 'vitest'
import {
  backupKey,
  backupSlotKey,
  bytesToMB,
  capacitySlotKey,
  D1_CAPACITY_THRESHOLD_BYTES,
  isOverCapacity,
  isStale,
  prunePlan,
  sha256Hex,
  validateDump,
  validateDumpStream,
} from '../src/lib/backup'

const bigUsers = `CREATE TABLE users (id text);\n${'INSERT INTO users VALUES (1);\n'.repeat(500)}`

const bigItems = `CREATE TABLE items (id text);\n${'INSERT INTO items VALUES (1);\n'.repeat(500)}`

describe('validateDump', () => {
  it('既定 sentinel(users)の INSERT で合格し、計算済みバイト長を返す', () => {
    const res = validateDump(bigUsers)
    expect(res.ok).toBe(true)
    expect(res.bytes).toBe(new TextEncoder().encode(bigUsers).length)
  })
  it('seed 直後の小さな健全 DB(数 KB 未満でも ≥1KB)は合格する', () => {
    // 旧閾値 10KB だと新規デプロイ直後の DB が恒久 too_small になり
    // バックアップが 1 本も残らない(レビュー指摘の回帰テスト)。
    const small = `CREATE TABLE users (id text);\n${'INSERT INTO users VALUES (1);\n'.repeat(40)}`
    expect(validateDump(small).ok).toBe(true)
  })
  it('sentinel=items を指定すると items INSERT のダンプで合格', () => {
    expect(validateDump(bigItems, 'items').ok).toBe(true)
  })
  it('sentinel はターゲットごとに合わせる(別 DB の表名のままだと恒久失敗)', () => {
    // items しか無い DB のダンプは、既定 sentinel(users)のままだと恒久失敗する。
    expect(validateDump(bigItems)).toMatchObject({ ok: false, reason: 'no_rows' })
    expect(validateDump(bigItems, 'items').ok).toBe(true)
  })
  it('minBytes 未満のダンプは too_small(per-target で引き上げ可)', () => {
    expect(validateDump('CREATE TABLE users (id);INSERT INTO users VALUES(1)')).toMatchObject({
      ok: false,
      reason: 'too_small',
    })
    // 平常サイズが分かった DB は床を引き上げて空振り export を検知できる
    expect(validateDump(bigUsers, 'users', 10 * 1024 * 1024)).toMatchObject({
      ok: false,
      reason: 'too_small',
    })
  })
  it('スキーマ無しは no_schema', () => {
    const noSchema = 'INSERT INTO users VALUES (1);\n'.repeat(1000)
    expect(validateDump(noSchema)).toMatchObject({ ok: false, reason: 'no_schema' })
  })
  it('sentinel テーブルへの INSERT 無し(空 DB)は no_rows', () => {
    const empty = `CREATE TABLE users (id text);\n${'-- comment line padding\n'.repeat(1000)}`
    expect(validateDump(empty)).toMatchObject({ ok: false, reason: 'no_rows' })
  })
  it('コメント・文字列内の INSERT と部分一致テーブル名を sentinel として数えない', () => {
    const deceptive =
      `CREATE TABLE users (id text);\n-- INSERT INTO users (id) VALUES (1);\n` +
      `INSERT INTO users_backup (id) VALUES (1);\n` +
      `'INSERT INTO users (id) VALUES (1);'\n` +
      'x'.repeat(1_000)
    expect(validateDump(deceptive)).toMatchObject({ ok: false, reason: 'no_rows' })
  })
  it('ブロックコメントと SQLite 文字列の境界も構造検査から除外する', () => {
    const blockComment =
      `CREATE TABLE users (id text); /* hidden\nINSERT INTO users (id) VALUES (1); */\n` +
      'x'.repeat(1_000)
    const quotedString =
      `CREATE TABLE users (id text); 'it''s\nINSERT INTO users (id) VALUES (1);'\n` +
      'x'.repeat(1_000)
    expect(validateDump(blockComment)).toMatchObject({ ok: false, reason: 'no_rows' })
    expect(validateDump(quotedString)).toMatchObject({ ok: false, reason: 'no_rows' })
  })
})

describe('validateDumpStream', () => {
  it('分割された UTF-8 stream を全量バッファせず検証し、byte 数を返す', async () => {
    const encoder = new TextEncoder()
    const source = encoder.encode(bigUsers)
    const chunks = [source.slice(0, 17), source.slice(17, 241), source.slice(241)]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })

    await expect(validateDumpStream(stream)).resolves.toMatchObject({
      ok: true,
      bytes: source.byteLength,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('上限超過は too_large として扱う', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
        controller.close()
      },
    })

    await expect(validateDumpStream(stream, 'users', 1, 512)).resolves.toMatchObject({
      ok: false,
      reason: 'too_large',
    })
  })

  it('最小サイズ未満は too_small として扱う', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('CREATE TABLE users (id);'))
        controller.close()
      },
    })

    await expect(validateDumpStream(stream)).resolves.toMatchObject({
      ok: false,
      reason: 'too_small',
    })
  })

  it('スキーマ無しは no_schema として扱う', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1_000)))
        controller.close()
      },
    })

    await expect(validateDumpStream(stream)).resolves.toMatchObject({
      ok: false,
      reason: 'no_schema',
    })
  })

  it('sentinel 行無しは no_rows として扱う', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`CREATE TABLE users (id);\n${'-- padding\n'.repeat(100)}`),
        )
        controller.close()
      },
    })

    await expect(validateDumpStream(stream)).resolves.toMatchObject({
      ok: false,
      reason: 'no_rows',
    })
  })

  it('不正な UTF-8 は置換文字に変換せず invalid_utf8 で拒否する', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('CREATE TABLE users (id);'))
        controller.enqueue(new Uint8Array([0xff, 0xfe]))
        controller.close()
      },
    })

    await expect(validateDumpStream(stream, 'users', 1)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_utf8',
    })
  })
})

describe('sha256Hex', () => {
  it('既知ベクタを段階的に hash する', () => {
    const encoder = new TextEncoder()
    expect(sha256Hex([encoder.encode('a'), encoder.encode('bc')])).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('56 byte 境界を正しく hash する', () => {
    const encoder = new TextEncoder()
    expect(sha256Hex([encoder.encode('a'.repeat(56))])).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    )
  })
})

describe('prunePlan', () => {
  it('keep を超えた古い世代のみ削除対象(新しい順に残す)', () => {
    const keys = Array.from(
      { length: 33 },
      (_, i) => `admin/2026-07-${String(i + 1).padStart(2, '0')}T02-00-00.sql`,
    )
    const del = prunePlan(keys, 30)
    expect(del).toHaveLength(3)
    // 最古 3 件(01,02,03)が削除対象
    expect(del).toEqual([
      'admin/2026-07-03T02-00-00.sql',
      'admin/2026-07-02T02-00-00.sql',
      'admin/2026-07-01T02-00-00.sql',
    ])
  })
  it('keep 以下なら削除なし', () => {
    expect(prunePlan(['a', 'b'], 30)).toEqual([])
  })
  it('世代命名でないオブジェクト(latest/pre-restore)は削除対象にしない', () => {
    expect(
      prunePlan(
        [
          'admin/2026-07-03T02-00-00.sql',
          'admin/2026-07-02T02-00-00.sql',
          'latest.json',
          'pre-restore/admin/old.sql',
        ],
        1,
      ),
    ).toEqual(['admin/2026-07-02T02-00-00.sql'])
  })
})

describe('backupSlotKey', () => {
  it('同一 12h スロット内は同じキー、午前/午後で分かれる', () => {
    const am = backupSlotKey('backup_failed', new Date('2026-07-12T02:00:00Z'))
    const am2 = backupSlotKey('backup_failed', new Date('2026-07-12T05:30:00Z'))
    const pm = backupSlotKey('backup_failed', new Date('2026-07-12T14:00:00Z'))
    expect(am).toBe(am2)
    expect(am).not.toBe(pm)
    expect(am).toBe('backup_failed:2026-07-12:am')
  })
})

describe('isStale', () => {
  const now = new Date('2026-07-12T18:30:00Z')
  it('直近バックアップ(1.5h 前)は fresh', () => {
    expect(isStale('2026-07-12T17:00:00Z', now)).toBe(false)
  })
  it('12h バックアップが 1 回欠落したら最初のチェック(13.5h)で stale', () => {
    // 17:00 の枠が欠落 → 18:30 のチェック時点で latest は 05:00(13.5h 前)。
    // 既定閾値が 13.5h を超えていると検知が翌日まで遅れる(回帰テスト)。
    expect(isStale('2026-07-12T05:00:00Z', now)).toBe(true)
  })
  it('閾値は明示指定もできる', () => {
    expect(isStale('2026-07-12T05:00:00Z', now, 14)).toBe(false)
    expect(isStale('2026-07-12T03:00:00Z', now, 14)).toBe(true)
  })
  it('null / 不正時刻は stale 扱い', () => {
    expect(isStale(null, now)).toBe(true)
    expect(isStale('not-a-date', now)).toBe(true)
  })
})

describe('backupKey', () => {
  it('target 配下にソート可能な命名で置く', () => {
    expect(backupKey('admin', new Date('2026-07-12T02:00:00.000Z'))).toBe(
      'admin/2026-07-12T02-00-00.sql',
    )
  })
})

describe('D1 容量監視', () => {
  it('閾値は 400MB(Free 500MB/DB の 80%)', () => {
    expect(D1_CAPACITY_THRESHOLD_BYTES).toBe(400 * 1024 * 1024)
  })

  it('bytesToMB はバイトを MB(小数第 1 位)に換算', () => {
    expect(bytesToMB(1024 * 1024)).toBe(1)
    expect(bytesToMB(400 * 1024 * 1024)).toBe(400)
    expect(bytesToMB(1_572_864)).toBe(1.5)
  })

  it('isOverCapacity は閾値超で true、閾値ちょうど/未満で false', () => {
    expect(isOverCapacity(D1_CAPACITY_THRESHOLD_BYTES + 1)).toBe(true)
    expect(isOverCapacity(D1_CAPACITY_THRESHOLD_BYTES)).toBe(false)
    expect(isOverCapacity(0)).toBe(false)
    // 明示閾値も渡せる
    expect(isOverCapacity(101, 100)).toBe(true)
  })

  it('capacitySlotKey は日付単位(同一日は同じ・翌日は別)', () => {
    const a = capacitySlotKey(new Date('2026-07-12T06:30:00Z'))
    const b = capacitySlotKey(new Date('2026-07-12T18:30:00Z'))
    const c = capacitySlotKey(new Date('2026-07-13T06:30:00Z'))
    expect(a).toBe('capacity:2026-07-12')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
