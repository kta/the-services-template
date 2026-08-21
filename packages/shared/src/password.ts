/**
 * パスワード認証。
 *
 * **無料枠制約(Workers Free の CPU 10ms)への対応**: サーバ側 PBKDF2 600k は
 * Workers Free の CPU 10ms を超えるため不可。ストレッチングをクライアントへ移す:
 *
 *   1. クライアント: `stretched = PBKDF2-HMAC-SHA256(password, salt=SALT_PREFIX+email, 600k)`
 *      をブラウザで計算して送信(平文はネットワークにもサーバにも出ない)。
 *   2. サーバ(admin Worker): `passwordHash = HMAC-SHA256(PEPPER, stretched)` を保存・検証
 *      (1 回の HMAC = CPU ほぼゼロ)。DB 漏えい単独では pepper が、pepper 漏えい単独では
 *      600k ストレッチが防壁になる。
 *
 * WebCrypto(`crypto.subtle`)のみ使用(Workers ネイティブ・WASM 不要・ブラウザ共通)。
 * iterations は各関数の引数で下げられる(テスト高速化用)。
 */

const DEFAULT_ITERATIONS = 600_000
// salt のドメイン分離接頭辞。フォークしたらアプリ固有の値に変えること
// (変えると既存ハッシュは全て無効になるので、運用開始前に確定させる)。
const SALT_PREFIX = 'app:'

const enc = new TextEncoder()

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * クライアント側キーストレッチング。email 導出 salt で PBKDF2-HMAC-SHA256。
 * 出力は base64。ログイン/招待受諾フォームで実行し `stretched` として送る。
 *
 * **注意**: salt が email 由来なので、email を変更すると既存ハッシュは照合不能に
 * なる(サイレントにログイン不能)。email 変更機能を作る場合は必ずパスワード
 * 再設定(招待受諾と同じ再ストレッチ)をセットで実装すること。
 */
export async function stretchPassword(
  password: string,
  email: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(SALT_PREFIX + email.toLowerCase()),
      iterations,
    },
    key,
    256,
  )
  return toBase64(bits)
}

/**
 * サーバ側: pepper で stretched を HMAC-SHA256 し、保存形式 `hmac$<base64>` を返す。
 * pepper は `wrangler secret put AUTH_PEPPER`。
 */
export async function hashStretched(stretched: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(stretched))
  return `hmac$${toBase64(sig)}`
}

/** 定数時間比較(タイミング攻撃対策)。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** サーバ側: 保存済みハッシュと照合(定数時間)。壊れた保存形式は false(throw しない)。 */
export async function verifyStretched(
  stretched: string,
  pepper: string,
  storedHash: string,
): Promise<boolean> {
  const expected = await hashStretched(stretched, pepper)
  const [, expB64] = expected.split('$')
  const [prefix, gotB64] = storedHash.split('$')
  if (prefix !== 'hmac' || !gotB64 || !expB64) return false
  try {
    return timingSafeEqual(fromBase64(expB64), fromBase64(gotB64))
  } catch {
    // 保存値が base64 として不正(atob が throw)— ログインを 500 にせず不一致扱い。
    return false
  }
}
