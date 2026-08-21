import type { NotificationJob } from '@app/contracts'

// Provider-agnostic sender interface (swap implementations per environment).
export interface Sender {
  send(job: NotificationJob): Promise<void>
}

/**
 * dev 専用: メールを送らずログに出す。**明示オプトイン(MAIL_DEV_LOG=true)でのみ
 * 選ばれる** — RESEND_API_KEY 忘れの本番が黙ってこれに落ちると、招待が「送信済み」
 * と報告されながら誰にも届かず、しかも payload の acceptUrl(ワンタイム資格情報)が
 * 観測ログに平文で残る。dev では acceptUrl をログから拾えるのが利便なので全文を出す。
 */
export class LogSender implements Sender {
  async send(job: NotificationJob): Promise<void> {
    console.log(`[notify] ${job.type} → ${job.to}`, job.payload)
  }
}

// Default sender address. Overridable via the MAIL_FROM env var. Resend requires
// the `from` domain to be verified in your account, so prod must set MAIL_FROM to
// a verified operational domain (see docs/howto/deploy.md).
const DEFAULT_MAIL_FROM = 'notifications@example.com'

/**
 * 種別ごとの件名と本文。**受信者が読んで行動できる文面**にする — JSON をそのまま
 * 送ると、招待メールは「リンクとして踏めない JSON 文字列」になり実質不達になる。
 * ops 系は運用者向けなので、要旨 + 詳細(JSON)の 2 部構成。
 */
export function formatJob(job: NotificationJob): { subject: string; text: string } {
  const p = job.payload
  const detail = () => JSON.stringify(p, null, 2)
  switch (job.type) {
    case 'user.invited':
      return {
        subject: 'アカウント招待のご案内',
        text: [
          'アカウントへの招待が届いています。',
          '',
          '次の URL を開き、招待された本人のメールアドレスとパスワードを設定してください:',
          '',
          String(p.acceptUrl ?? ''),
          '',
          '※ 招待リンクには有効期限があります。心当たりがない場合はこのメールを破棄してください。',
        ].join('\n'),
      }
    case 'item.created':
      return {
        subject: 'アイテムが作成されました',
        text: `新しいアイテムが作成されました: ${String(p.title ?? p.itemId ?? '')}`,
      }
    case 'ops.backup_failed':
      return {
        subject: '[ops] D1 バックアップ失敗',
        text: `バックアップに失敗したターゲットがあります。詳細:\n\n${detail()}`,
      }
    case 'ops.backup_stale':
      return {
        subject: '[ops] バックアップ鮮度警告',
        text: `最新バックアップが鮮度閾値を超えています。バックアップ Cron/Workflow を確認してください。詳細:\n\n${detail()}`,
      }
    case 'ops.health_check_failed':
      return {
        subject: '[ops] 死活監視: 応答異常',
        text: `ヘルスチェックに失敗したサービスがあります。詳細:\n\n${detail()}`,
      }
    case 'ops.sync_drift':
      return {
        subject: '[ops] org 同期ドリフト検知',
        text: `admin とドメインサービスの organization 同期にずれがあります(自動再同期済み/失敗分は詳細参照)。詳細:\n\n${detail()}`,
      }
    case 'ops.capacity_warning':
      return {
        subject: '[ops] D1 容量警告',
        text: `D1 使用量が閾値を超えました。データ整理またはプラン移行を検討してください。詳細:\n\n${detail()}`,
      }
    default:
      return { subject: `[${job.type satisfies never}]`, text: detail() }
  }
}

// Email via Resend (https://resend.com). Throws on non-2xx so the consumer
// retries. Enable by setting the RESEND_API_KEY secret.
export class ResendSender implements Sender {
  private readonly from: string

  constructor(
    private readonly apiKey: string,
    from?: string,
  ) {
    // Empty string / undefined → fall back to the default address.
    this.from = from || DEFAULT_MAIL_FROM
  }

  async send(job: NotificationJob): Promise<void> {
    const { subject, text } = formatJob(job)
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        // Lets Resend dedupe if the consumer redelivers (at-least-once).
        'idempotency-key': job.id,
      },
      body: JSON.stringify({ from: this.from, to: job.to, subject, text }),
    })
    if (!res.ok) throw new Error(`resend failed: ${res.status}`)
  }
}

/**
 * 送信手段の選択。**fail close**: RESEND_API_KEY が無く、かつ MAIL_DEV_LOG=true の
 * 明示も無い環境では throw する(→ 呼び出しは 502 send_failed になり、呼び出し側の
 * フォールバック — 招待ならリンク表示 — が働く)。「未設定の本番が LogSender に
 * 落ちて送信成功を偽装する」事故を塞ぐ。
 */
export function pickSender(env: {
  RESEND_API_KEY?: string
  MAIL_FROM?: string
  MAIL_DEV_LOG?: string
}): Sender {
  if (env.RESEND_API_KEY) return new ResendSender(env.RESEND_API_KEY, env.MAIL_FROM)
  if (env.MAIL_DEV_LOG === 'true') return new LogSender()
  throw new Error('no_sender_configured (set RESEND_API_KEY, or MAIL_DEV_LOG=true for dev)')
}
