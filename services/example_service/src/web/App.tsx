import { CreateItem, type Item } from '@app/contracts'
import { ANALYTICS_EVENTS, auth, trackEvent } from '@app/shared'
import { Button, Field, Notice, TextInput } from '@app/ui'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { client } from './client'

/*
 * Exemplar screen for the template. Layout intent (see
 * docs/frontend/DESIGN_RULE.md): a single narrow column shaped like a paper
 * ledger — masthead, entry form, then entries separated by hairlines. The
 * display face appears exactly twice (masthead, empty state); everything else
 * stays quiet. Timestamps are set in the mono face like a register column.
 */

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

export function App() {
  const [org, setOrg] = useState(() => auth.getOrganization())
  return org ? (
    <Ledger
      org={org}
      onSignOut={() => {
        auth.logout()
        setOrg(null)
      }}
    />
  ) : (
    <SignIn onSignedIn={setOrg} />
  )
}

function Masthead({ org, onSignOut }: { org?: string; onSignOut?: () => void }) {
  return (
    <header className="flex items-baseline justify-between border-b-2 border-ink pb-3">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Example Service
      </h1>
      {org && onSignOut && (
        <p className="font-sans text-sm text-ink-muted">
          <span className="font-mono">{org}</span>
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            onClick={onSignOut}
            className="text-pine underline underline-offset-2 hover:text-pine-deep"
          >
            Sign out
          </button>
        </p>
      )}
    </header>
  )
}

function SignIn({ onSignedIn }: { onSignedIn: (org: string) => void }) {
  const [orgId, setOrgId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!orgId.trim()) {
      setError('Enter a workspace id to continue.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await auth.login(orgId.trim())
      trackEvent(ANALYTICS_EVENTS.LOGIN_SUCCESS)
      onSignedIn(orgId.trim())
    } catch {
      setError('Could not open the workspace. Check the id and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <Masthead />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Workspace id" htmlFor="org" error={error}>
          <TextInput
            id="org"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="e.g. org_acme"
            autoFocus
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Opening…' : 'Open workspace'}
        </Button>
        <p className="font-sans text-xs leading-relaxed text-ink-muted">
          Template note: this is the dev token grant — any id works, no credential is checked.
          Replace it with real authentication before shipping.
        </p>
      </form>
    </main>
  )
}

function Ledger({ org, onSignOut }: { org: string; onSignOut: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await client.api.items.$get()
    if (res.status === 401) {
      onSignOut()
      return
    }
    if (!res.ok) {
      setApiError('Could not load items. Reload to try again.')
      return
    }
    setItems(await res.json())
  }, [onSignOut])

  useEffect(() => {
    load().catch(() => setApiError('Could not load items. Reload to try again.'))
  }, [load])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFieldError(null)
    setApiError(null)
    const parsed = CreateItem.safeParse({ title, body })
    if (!parsed.success) {
      setFieldError('A title is required (200 characters max).')
      return
    }
    setSaving(true)
    try {
      const res = await client.api.items.$post({ json: parsed.data })
      // アクセストークンは 15 分で切れ、このサービスに refresh は無い。401 に
      // 「try again」を出しても永久に成功しない — load() と同じくサインアウトする。
      // (401 は認証ミドルウェア由来で RPC の型面には現れないため number に広げる)
      const status: number = res.status
      if (status === 401) {
        onSignOut()
        return
      }
      if (!res.ok) {
        setApiError('Saving failed. Your entry is still in the form — try again.')
        return
      }
      trackEvent(ANALYTICS_EVENTS.ITEM_CREATED)
      setTitle('')
      setBody('')
      await load()
    } catch {
      setApiError('Network error. Your entry is still in the form — try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-8 px-6 py-10">
      <Masthead org={org} onSignOut={onSignOut} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Title" htmlFor="title" error={fieldError}>
          <TextInput
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What happened?"
          />
        </Field>
        <Field label="Notes" htmlFor="body">
          <TextInput
            id="body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Optional detail"
          />
        </Field>
        <div>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Add entry'}
          </Button>
        </div>
      </form>

      {apiError && <Notice>{apiError}</Notice>}

      <section aria-label="Entries">
        {items === null ? (
          // 初回フェッチ中に空状態を見せない(「空です」→行が出る、のちらつき防止)
          <p className="border-t border-line pt-6 text-center font-sans text-sm text-ink-muted">
            Loading…
          </p>
        ) : items.length === 0 ? (
          <p className="border-t border-line pt-6 text-center font-display text-lg text-ink-muted italic">
            The ledger is empty — add its first entry above.
          </p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-sm font-medium text-ink">{item.title}</p>
                  {item.body && (
                    <p className="truncate font-sans text-sm text-ink-muted">{item.body}</p>
                  )}
                </div>
                <time
                  dateTime={item.createdAt}
                  className="shrink-0 font-mono text-xs text-ink-muted"
                >
                  {timeFormat.format(new Date(item.createdAt))}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
