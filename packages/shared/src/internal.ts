/**
 * サービス間(service binding)内部 API の共有部品。
 * - `internalAuth()`: `x-internal-key` ガード(secret 未設定は fail close)
 * - `sendNotification()`: notifier の同期送信 API への best-effort POST
 * 3 サービス以上で同じコードが増殖しないよう、ここが単一ソース。
 */
import type { NotificationJob } from '@app/contracts'
import type { MiddlewareHandler } from 'hono'

type InternalEnv = { Bindings: { INTERNAL_KEY: string } }

const enc = new TextEncoder()

/**
 * 定数時間比較。`/api/internal/*` は service binding 経由が正規経路だが Worker の
 * 公開 URL からも到達できるため、共有 secret の照合を `!==`(早期 return)にしない。
 * 長さ不一致の早期 return は長さ以外を漏らさないので許容。
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

/**
 * `/api/internal/*` を守る共有キーガード。secret 未設定なら全拒否(fail close —
 * 未設定の env と欠落ヘッダが undefined 同士で一致して素通りするのを防ぐ)。
 */
export function internalAuth(): MiddlewareHandler<InternalEnv> {
  return async (c, next) => {
    const expected = c.env.INTERNAL_KEY
    const got = c.req.header('x-internal-key')
    if (!expected || !got || !timingSafeEqualStr(got, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}

/**
 * fetch を持つ service binding。@cloudflare/workers-types の Fetcher と DOM の
 * fetch 双方に構造適合するよう、必要最小のシグネチャだけを要求する。
 */
type InternalFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

type FetcherLike = {
  fetch(input: string, init?: InternalFetchInit): Promise<{ ok: boolean; status: number }>
}

// 同期送信のタイムアウト。notifier(や Resend 上流)がハングしても、呼び出し側の
// 本処理(item 作成・招待発行など)を無期限に道連れにしない。
const NOTIFY_TIMEOUT_MS = 10_000

/**
 * notifier へ NotificationJob を同期 POST する(best-effort)。2xx で true。
 * 失敗しても throw しない — 呼び出し側の本処理を止めないのが規約。
 *
 * **冪等キーの規約**: `job.id` が notifier 側の KV dedupe キー(TTL 24h)。
 * 再検知 Cron など繰り返し発火するものは時間スロットキーを渡すこと
 * (ランダム UUID を毎回渡すと dedupe が効かず連打になる)。
 */
export async function sendNotification(
  notifier: FetcherLike,
  internalKey: string,
  job: NotificationJob,
): Promise<boolean> {
  try {
    // signal は FetcherLike の init 型に載せない: lib.dom と workers-types の
    // AbortSignal は相互に構造非互換で、型に含めると DOM fetch / Fetcher の
    // どちらかが必ず適合しなくなる。双方のランタイムは受け付けるので、実行時
    // にだけ渡す(このキャストはその型の穴を局所化するためのもの)。
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': internalKey },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    }
    const r = await notifier.fetch('http://notifier/api/internal/send', init as InternalFetchInit)
    if (!r.ok) console.error('notify returned non-2xx', r.status, job.type, job.id)
    return r.ok
  } catch (err) {
    console.error('notify failed', job.type, job.id, err)
    return false
  }
}
