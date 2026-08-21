import type { Organization, Plan } from '@app/contracts'
import { ANALYTICS_EVENTS, trackEvent } from '@app/shared'
import { Button, Chip, Dialog, Notice, TextInput } from '@app/ui'
import { useEffect, useState } from 'react'
import { client, unwrap } from '../client'
import { EmptyState, PageHeader, Section, Spinner } from '../components/ui'
import { messageForError, messageForStatus } from '../lib/errorMessages'
import { toast } from '../store/toast'

/**
 * 組織一覧: 組織の作成・招待・プラン切替・無効化・削除。canonical な
 * `/api/organizations` が単一ソース。破壊的操作は Dialog で 2 段確認。
 */

const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium' })

export function Orgs() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 作成フォーム
  const [name, setName] = useState('')
  const [plan, setPlan] = useState<Plan>('free')

  // ダイアログ状態
  const [inviteFor, setInviteFor] = useState<Organization | null>(null)
  const [deleteFor, setDeleteFor] = useState<Organization | null>(null)

  async function load(): Promise<void> {
    try {
      const rows = await unwrap<Organization[]>(await client.api.organizations.$get())
      setOrgs(rows)
      setError(null)
    } catch (err) {
      setError('組織を読み込めませんでした。再読み込みしてください。')
      toast.error(messageForError(err))
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function createOrg(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusyId('create')
    try {
      await unwrap<Organization>(
        await client.api.organizations.$post({ json: { name: trimmed, plan } }),
      )
      trackEvent(ANALYTICS_EVENTS.ORGANIZATION_CREATED)
      setName('')
      setPlan('free')
      await load()
    } catch (err) {
      setError('組織の作成に失敗しました。')
      toast.error(messageForError(err))
    } finally {
      setBusyId(null)
    }
  }

  async function setOrgPlan(o: Organization, next: Plan): Promise<void> {
    setBusyId(o.id)
    try {
      // hono client は 4xx/5xx でも throw しないため res.ok を検査して失敗を surface。
      const res = await client.api.organizations[':id'].$patch({
        param: { id: o.id },
        json: { plan: next },
      })
      if (!res.ok) {
        setError('プランの変更に失敗しました。')
        toast.error(messageForStatus(res.status))
        return
      }
      await load()
    } catch (err) {
      // ネットワーク断など fetch 自体の失敗も他ハンドラ同様に surface する
      setError('プランの変更に失敗しました。')
      toast.error(messageForError(err))
    } finally {
      setBusyId(null)
    }
  }

  async function setDisabled(o: Organization, isDisabled: boolean): Promise<void> {
    setBusyId(o.id)
    try {
      const res = await client.api.organizations[':id'].$patch({
        param: { id: o.id },
        json: { isDisabled },
      })
      if (!res.ok) {
        setError(isDisabled ? '無効化に失敗しました。' : '有効化に失敗しました。')
        toast.error(messageForStatus(res.status))
        return
      }
      await load()
    } catch (err) {
      setError(isDisabled ? '無効化に失敗しました。' : '有効化に失敗しました。')
      toast.error(messageForError(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader title="組織" sub={orgs ? `${orgs.length} 組織を管理しています` : undefined} />

      <Section title="新しい組織を作成" className="mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="new-org-name" className="flex min-w-56 flex-1 flex-col gap-1.5">
            <span className="font-sans text-sm text-ink-muted">組織名</span>
            <TextInput
              id="new-org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: Acme Inc."
            />
          </label>
          <label htmlFor="new-org-plan" className="flex flex-col gap-1.5">
            <span className="font-sans text-sm text-ink-muted">プラン</span>
            <select
              id="new-org-plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value as Plan)}
              className="min-h-11 rounded-ctl border border-line bg-surface px-3 font-sans text-sm text-ink"
            >
              <option value="free">無料</option>
              <option value="contracted">契約</option>
            </select>
          </label>
          <Button onClick={createOrg} disabled={busyId === 'create' || !name.trim()}>
            {busyId === 'create' ? '作成中…' : '作成する'}
          </Button>
        </div>
      </Section>

      {error && (
        <div className="mb-6">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {!orgs ? (
        error ? (
          // 初回ロード失敗時にスピナーを回し続けない(「読み込み中」のまま固まって
          // 見える)。再試行の導線を出す。
          <div className="flex justify-center py-8">
            <Button variant="ghost" onClick={() => void load()}>
              再読み込み
            </Button>
          </div>
        ) : (
          <Spinner />
        )
      ) : orgs.length === 0 ? (
        <EmptyState>まだ組織がありません。上のフォームから作成してください。</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {orgs.map((o) => (
            <OrgRow
              key={o.id}
              org={o}
              busy={busyId === o.id}
              onPlan={(next) => setOrgPlan(o, next)}
              onDisable={(v) => setDisabled(o, v)}
              onInvite={() => setInviteFor(o)}
              onDelete={() => setDeleteFor(o)}
            />
          ))}
        </ul>
      )}

      {inviteFor && <InviteDialog org={inviteFor} onClose={() => setInviteFor(null)} />}
      {deleteFor && (
        <DeleteDialog
          org={deleteFor}
          onClose={() => setDeleteFor(null)}
          onDeleted={async () => {
            setDeleteFor(null)
            await load()
          }}
        />
      )}
    </>
  )
}

function OrgRow({
  org,
  busy,
  onPlan,
  onDisable,
  onInvite,
  onDelete,
}: {
  org: Organization
  busy: boolean
  onPlan: (next: Plan) => void
  onDisable: (v: boolean) => void
  onInvite: () => void
  onDelete: () => void
}) {
  return (
    <li className="rounded-ctl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="font-sans text-base font-semibold text-ink">{org.name}</span>
            <Chip tone={org.plan === 'contracted' ? 'success' : 'neutral'}>
              {org.plan === 'contracted' ? '契約' : '無料'}
            </Chip>
            {org.isDisabled && <Chip tone="danger">無効</Chip>}
          </div>
          <div className="mt-1 font-mono text-xs text-ink-muted">{org.id}</div>
          <div className="mt-2 font-sans text-sm text-ink-muted">
            作成 {dateFormat.format(new Date(org.createdAt))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onInvite} disabled={busy}>
            招待
          </Button>
          <Button
            variant="ghost"
            onClick={() => onPlan(org.plan === 'contracted' ? 'free' : 'contracted')}
            disabled={busy}
          >
            {org.plan === 'contracted' ? '無料に変更' : '契約に変更'}
          </Button>
          <Button variant="ghost" onClick={() => onDisable(!org.isDisabled)} disabled={busy}>
            {org.isDisabled ? '有効化' : '無効化'}
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={busy}>
            削除
          </Button>
        </div>
      </div>
    </li>
  )
}

function InviteDialog({ org, onClose }: { org: Organization; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ emailed: boolean; acceptUrl?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await client.api.organizations[':id'].invitations.$post({
        param: { id: org.id },
        json: { email, role: 'staff' },
      })
      if (!res.ok) throw new Error('invite_failed')
      setResult((await res.json()) as { emailed: boolean; acceptUrl?: string })
    } catch {
      setError('招待の送信に失敗しました。')
      toast.error('招待の送信に失敗しました。')
    } finally {
      setBusy(false)
    }
  }

  return (
    // メール不達時の acceptUrl は再表示できない一度きりの情報 — Esc の誤爆で
    // 破棄させない(明示の「閉じる」ボタンのみ)。
    <Dialog
      open
      onClose={onClose}
      labelledBy="invite-title"
      disableEscape={result !== null && !result.emailed}
    >
      <h2 id="invite-title" className="font-sans text-lg font-semibold text-ink">
        担当者を招待 — {org.name}
      </h2>
      {result ? (
        <div className="mt-4 flex flex-col gap-3">
          {result.emailed ? (
            <Notice tone="info">招待メールを送信しました。</Notice>
          ) : (
            <>
              <Notice tone="danger">
                メール送信に失敗しました。以下のリンクを手動で共有してください(この画面を閉じると再表示できません)。
              </Notice>
              <p className="break-all rounded-ctl bg-paper p-3 font-mono text-xs text-ink">
                {result.acceptUrl}
              </p>
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>閉じる</Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <label htmlFor="invite-email" className="flex flex-col gap-1.5">
            <span className="font-sans text-sm text-ink-muted">メールアドレス</span>
            <TextInput
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="staff@example.com"
              className="font-mono"
            />
          </label>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            <Button onClick={submit} disabled={busy || !email}>
              {busy ? '送信中…' : '招待を送信'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function DeleteDialog({
  org,
  onClose,
  onDeleted,
}: {
  org: Organization
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await client.api.organizations[':id'].$delete({ param: { id: org.id } })
      if (!res.ok) throw new Error('delete_failed')
      setDone(true)
    } catch {
      setError('削除に失敗しました。')
      toast.error('組織の削除に失敗しました。')
      setBusy(false)
    }
  }

  return (
    // 削除成功後は Esc でも onDeleted(一覧の再読込)を通す — onClose に流すと
    // 削除済みの org が有効なままの見た目で一覧に残る。
    <Dialog open onClose={done ? onDeleted : onClose} labelledBy="del-title">
      <h2 id="del-title" className="font-sans text-lg font-semibold text-ink">
        組織を削除 — {org.name}
      </h2>
      {!done ? (
        <div className="mt-4 flex flex-col gap-3">
          <Notice tone="danger">
            この組織を無効化し、ドメイン側の同期コピーにも反映します(行そのものは監査のため残ります)。続行しますか?
          </Notice>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button variant="danger" onClick={confirm} disabled={busy}>
              {busy ? '削除中…' : '削除を確定'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <Notice tone="info">削除しました(組織は無効化されています)。</Notice>
          <div className="flex justify-end">
            <Button onClick={onDeleted}>閉じる</Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
