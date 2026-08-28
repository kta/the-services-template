/**
 * バックアップの純ロジック。HTTP/R2 I/O から分離してテスト可能にする。
 * ここには I/O を持ち込まない。
 */

/**
 * 検証: 空 DB / 破損ダンプを弾く(≥minBytes・CREATE TABLE・sentinel テーブルへの
 * INSERT が 1 件以上)。sentinel はターゲットごとに異なる(例: admin=users)ため、
 * その DB に必ず存在し中身があるはずの表を指定する(別サービスの表名を流用しない)。
 * minBytes の既定は 1,000 — seed 直後の小さな健全 DB(数 KB)を弾かないための床。
 * 運用でダンプサイズの平常値が分かったら per-target に引き上げるとよい。
 * 計算済みバイト長を返すので、呼び出し側で再エンコードしないこと。
 */
const MAX_BACKUP_BYTES = 512 * 1024 * 1024
// A manifest more than five minutes ahead of the monitor clock is not a
// harmless clock skew: it can make an old/malicious object look indefinitely
// fresh. Keep a small allowance for runtime clock differences, then fail
// closed as stale.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

class Sha256 {
  private readonly state = Uint32Array.from(SHA256_INITIAL)
  private readonly block = new Uint8Array(64)
  private readonly schedule = new Uint32Array(64)
  private blockLength = 0
  private bytesHashed = 0

  update(input: Uint8Array): void {
    this.bytesHashed += input.byteLength
    let offset = 0
    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength
      if (input.byteLength < needed) {
        this.block.set(input, this.blockLength)
        this.blockLength += input.byteLength
        return
      }
      this.block.set(input.subarray(0, needed), this.blockLength)
      this.processBlock(this.block)
      this.blockLength = 0
      offset = needed
    }
    while (offset + 64 <= input.byteLength) {
      this.processBlock(input.subarray(offset, offset + 64))
      offset += 64
    }
    if (offset < input.byteLength) {
      this.block.set(input.subarray(offset), 0)
      this.blockLength = input.byteLength - offset
    }
  }

  digestHex(): string {
    const bitLength = this.bytesHashed * 8
    this.block[this.blockLength] = 0x80
    this.block.fill(0, this.blockLength + 1)
    if (this.blockLength >= 56) {
      this.processBlock(this.block)
      this.block.fill(0)
    }
    const view = new DataView(this.block.buffer)
    view.setUint32(56, Math.floor(bitLength / 0x100000000))
    view.setUint32(60, bitLength >>> 0)
    this.processBlock(this.block)
    return [...this.state].map((value) => value.toString(16).padStart(8, '0')).join('')
  }

  private processBlock(block: Uint8Array): void {
    for (let i = 0; i < 16; i += 1) {
      const offset = i * 4
      this.schedule[i] =
        ((block[offset] as number) << 24) |
        ((block[offset + 1] as number) << 16) |
        ((block[offset + 2] as number) << 8) |
        (block[offset + 3] as number)
    }
    for (let i = 16; i < 64; i += 1) {
      const value = this.schedule[i - 15] as number
      const value2 = this.schedule[i - 2] as number
      const smallSigma0 = rightRotate(value, 7) ^ rightRotate(value, 18) ^ (value >>> 3)
      const smallSigma1 = rightRotate(value2, 17) ^ rightRotate(value2, 19) ^ (value2 >>> 10)
      this.schedule[i] =
        ((this.schedule[i - 16] as number) +
          smallSigma0 +
          (this.schedule[i - 7] as number) +
          smallSigma1) >>>
        0
    }

    let a = this.state[0] as number
    let b = this.state[1] as number
    let c = this.state[2] as number
    let d = this.state[3] as number
    let e = this.state[4] as number
    let f = this.state[5] as number
    let g = this.state[6] as number
    let h = this.state[7] as number
    for (let i = 0; i < 64; i += 1) {
      const bigSigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 =
        (h + bigSigma1 + choice + (SHA256_K[i] as number) + (this.schedule[i] as number)) >>> 0
      const bigSigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (bigSigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    this.state[0] = ((this.state[0] as number) + a) >>> 0
    this.state[1] = ((this.state[1] as number) + b) >>> 0
    this.state[2] = ((this.state[2] as number) + c) >>> 0
    this.state[3] = ((this.state[3] as number) + d) >>> 0
    this.state[4] = ((this.state[4] as number) + e) >>> 0
    this.state[5] = ((this.state[5] as number) + f) >>> 0
    this.state[6] = ((this.state[6] as number) + g) >>> 0
    this.state[7] = ((this.state[7] as number) + h) >>> 0
  }
}

export function sha256Hex(chunks: Iterable<Uint8Array>): string {
  const hash = new Sha256()
  for (const chunk of chunks) hash.update(chunk)
  return hash.digestHex()
}

function sentinelPattern(sentinelTable: string): RegExp {
  const escaped = sentinelTable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quote = String.fromCharCode(96)
  return new RegExp(
    'INSERT\\s+INTO\\s+(?:' +
      escaped +
      '|"' +
      escaped +
      '"|' +
      quote +
      escaped +
      quote +
      '|\\[' +
      escaped +
      '\\])(?=\\s|\\()',
    'i',
  )
}

function createSqlStructuralScanner() {
  let state = 'normal'
  return {
    push(sql: string): string {
      let result = ''
      for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index]
        const next = sql[index + 1]
        if (state === 'line-comment') {
          if (character === '\n') {
            state = 'normal'
            result += '\n'
          } else {
            result += ' '
          }
          continue
        }
        if (state === 'block-comment') {
          if (character === '*' && next === '/') {
            result += '  '
            index += 1
            state = 'normal'
          } else {
            result += character === '\n' ? '\n' : ' '
          }
          continue
        }
        if (state === 'string') {
          if (character === "'" && next === "'") {
            result += '  '
            index += 1
          } else if (character === "'") {
            result += ' '
            state = 'normal'
          } else {
            result += character === '\n' ? '\n' : ' '
          }
          continue
        }
        if (character === '-' && next === '-') {
          result += '  '
          index += 1
          state = 'line-comment'
        } else if (character === '/' && next === '*') {
          result += '  '
          index += 1
          state = 'block-comment'
        } else if (character === "'") {
          result += ' '
          state = 'string'
        } else {
          result += character
        }
      }
      return result
    },
  }
}

function sqlForStructuralChecks(sql: string): string {
  return createSqlStructuralScanner().push(sql)
}

function validateDumpText(
  sql: string,
  sentinelTable: string,
  minBytes: number,
  bytes: number,
  maxBytes: number,
): { ok: boolean; reason?: string; bytes: number } {
  if (bytes > maxBytes) return { ok: false, reason: 'too_large', bytes }
  if (bytes < minBytes) return { ok: false, reason: 'too_small', bytes }
  const structuralSql = sqlForStructuralChecks(sql)
  if (!/CREATE\s+TABLE/i.test(structuralSql)) return { ok: false, reason: 'no_schema', bytes }
  // sentinel テーブルへの INSERT が 1 件以上(空 DB 検知)。
  if (!sentinelPattern(sentinelTable).test(structuralSql)) {
    return { ok: false, reason: 'no_rows', bytes }
  }
  return { ok: true, bytes }
}

export function validateDump(
  sql: string,
  sentinelTable = 'users',
  minBytes = 1_000,
  maxBytes = MAX_BACKUP_BYTES,
): { ok: boolean; reason?: string; bytes: number } {
  const bytes = new TextEncoder().encode(sql).length
  return validateDumpText(sql, sentinelTable, minBytes, bytes, maxBytes)
}

/**
 * SQL dump の validation branch。R2 upload branch と tee して使うため、本文全体を
 * 文字列化せず UTF-8 の検査窓だけを保持する。maxBytes を超えた入力は fail close
 * し、無制限の signed URL response が Worker を占有することを防ぐ。
 */
export async function validateDumpStream(
  stream: ReadableStream<Uint8Array>,
  sentinelTable = 'users',
  minBytes = 1_000,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<{ ok: boolean; reason?: string; bytes: number; sha256?: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  const rowPattern = sentinelPattern(sentinelTable)
  const hash = new Sha256()
  let bytes = 0
  let scanWindow = ''
  let hasSchema = false
  let hasRows = false
  const scanner = createSqlStructuralScanner()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        // Stop the validation branch immediately. In backupTarget the sibling
        // branch is the R2 upload, so leaving this reader open would let a
        // maliciously long response accumulate in the tee queue while the
        // upload branch keeps consuming it.
        await reader.cancel('dump_too_large').catch(() => undefined)
        return { ok: false, reason: 'too_large', bytes }
      }
      hash.update(value)
      try {
        scanWindow = `${scanWindow}${scanner.push(decoder.decode(value, { stream: true }))}`.slice(
          -16 * 1024,
        )
      } catch {
        await reader.cancel('invalid_utf8').catch(() => undefined)
        return { ok: false, reason: 'invalid_utf8', bytes }
      }
      if (!hasSchema) hasSchema = /CREATE\s+TABLE/i.test(scanWindow)
      if (!hasRows) hasRows = rowPattern.test(scanWindow)
    }
    try {
      scanWindow = `${scanWindow}${scanner.push(decoder.decode())}`.slice(-16 * 1024)
    } catch {
      return { ok: false, reason: 'invalid_utf8', bytes }
    }
    if (!hasSchema) hasSchema = /CREATE\s+TABLE/i.test(scanWindow)
    if (!hasRows) hasRows = rowPattern.test(scanWindow)
  } finally {
    reader.releaseLock()
  }
  if (bytes < minBytes) return { ok: false, reason: 'too_small', bytes }
  if (!hasSchema) return { ok: false, reason: 'no_schema', bytes }
  if (!hasRows) return { ok: false, reason: 'no_rows', bytes }
  return { ok: true, bytes, sha256: hash.digestHex() }
}

/**
 * 世代 prune 計画。世代キー(例 `admin/2026-07-12T02-00-00.sql`)を新しい順に keep 世代
 * だけ残し、超過分の削除対象キーを返す。時刻順は文字列辞書順(ISO 風命名)で担保。
 */
export function prunePlan(keys: string[], keep = 30): string[] {
  const sorted = keys
    .filter((key) => /^[a-z][a-z0-9_-]{0,62}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/.test(key))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // 降順(新しいものが先頭)
  return sorted.slice(keep)
}

/**
 * 通知の冪等スロットキー(12h 単位)。同一失敗を 12h に 1 回だけ通知するため、
 * job.id をこのスロットから決定的に導出する。UTC 基準・日付 + 午前/午後で分割。
 */
export function backupSlotKey(kind: string, now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  const half = now.getUTCHours() < 12 ? 'am' : 'pm'
  return `${kind}:${y}-${m}-${d}:${half}`
}

/**
 * 鮮度判定: latest.json の作成時刻が閾値(既定 13h)より古ければ stale。
 * 閾値の根拠: バックアップは 12h 間隔・鮮度チェックはその +1.5h 後に走るので、
 * 1 回欠落した直後のチェック時点で latest は 13.5h 前。閾値が 13.5h を超える
 * (例: 14h)と、その欠落を検知できるのが翌日のチェック(25.5h 後)までずれ込む。
 * 13h なら欠落を最初のチェックで検知しつつ、正常時(1.5h)には遠く届かない。
 */
export function isStale(latestIso: string | null, now: Date, thresholdHours = 13): boolean {
  if (!latestIso) return true
  const t = Date.parse(latestIso)
  if (Number.isNaN(t)) return true
  const ageMs = now.getTime() - t
  if (ageMs < -MAX_FUTURE_SKEW_MS) return true
  return ageMs > thresholdHours * 60 * 60 * 1000
}

/** 世代オブジェクトキー命名(R2 内でソート可能・人間可読)。 */
export function backupKey(target: string, now: Date): string {
  const iso = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  return `${target}/${iso}.sql`
}

/**
 * D1 容量監視の閾値。Free プランの上限は 500MB/DB。その 80% = 400MB を超えたら
 * `ops.capacity_warning` を出し、上限到達前に手を打てるようにする。取得自体の
 * 失敗は `ops.monitor_failed` として別途通知し、未知のサイズを安全な値とみなさない。
 */
export const D1_CAPACITY_THRESHOLD_BYTES = 400 * 1024 * 1024

/** バイト → MB(小数第 1 位まで)。通知 payload / ログの可読化用。 */
export function bytesToMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

/** 容量超過判定: 使用バイト数が閾値(既定 400MB)を超えていれば true。 */
export function isOverCapacity(bytes: number, threshold = D1_CAPACITY_THRESHOLD_BYTES): boolean {
  return bytes > threshold
}

/**
 * 容量警告の冪等スロットキー(日付単位・UTC)。同一日の複数 Cron(18:30/06:30)で
 * 二重通知しないよう、job.id をこの日付スロットから決定的に導出する。
 */
export function capacitySlotKey(now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `capacity:${y}-${m}-${d}`
}
