/**
 * エラーコード / HTTP ステータス → 分かりやすい日本語文。
 */

const GENERIC = 'エラーが発生しました'
const NETWORK = '通信に失敗しました。時間をおいて再度お試しください。'
const SESSION_EXPIRED = 'セッションが切れました。再度ログインしてください。'
const NOT_FOUND = '対象が見つかりませんでした。'
const FORBIDDEN = 'この操作を行う権限がありません。'
const CONFLICT = '既に使われています。内容を確認してください。'

// このリポジトリのサーバが実際に返すコードだけを持つ(返さないコードの文言は
// 存在しないプロトコルのドキュメントになるので置かない)。
function messageForKnownCode(code: string): string | undefined {
  switch (code) {
    case 'email_taken':
      return CONFLICT
    case 'expired':
    case 'unauthorized':
    case 'no_session':
      return SESSION_EXPIRED
    case 'not_found':
      return NOT_FOUND
    case 'forbidden':
    case 'operator_only':
      return FORBIDDEN
    default:
      return undefined
  }
}

export function messageForStatus(status: number): string {
  if (status === 0) return NETWORK
  if (status === 401) return SESSION_EXPIRED
  if (status === 403) return FORBIDDEN
  if (status === 404) return NOT_FOUND
  if (status === 409) return CONFLICT
  if (status === 429 || status >= 500) return NETWORK
  if (status >= 400) return `${GENERIC}（${status}）`
  return GENERIC
}

function messageForCode(code?: string, status?: number): string {
  if (code) {
    const known = messageForKnownCode(code)
    if (known) return known
  }
  if (typeof status === 'number') return messageForStatus(status)
  if (code) return `${GENERIC}（${code}）`
  return GENERIC
}

export function messageForError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown }
    const status = typeof e.status === 'number' ? e.status : undefined
    const code = typeof e.code === 'string' ? e.code : undefined
    if (code !== undefined || status !== undefined) return messageForCode(code, status)
  }
  return NETWORK
}
