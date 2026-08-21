import { cn } from '@app/ui'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { logout } from '../auth/session'

/**
 * admin AppShell: サイドバー + paper 地のメイン。モバイルは下部タブ。
 * テンプレートの管理領域は「組織」のみ — サービスを増やしたら NAV に追記する。
 */

const NAV = [{ to: '/', label: '組織', end: true }] as const

export function AppShell() {
  const navigate = useNavigate()

  async function onLogout(): Promise<void> {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-dvh bg-paper">
      <div className="mx-auto flex min-h-dvh max-w-7xl">
        <aside className="hidden w-56 flex-none flex-col border-r border-line bg-surface px-4 pt-7 pb-6 md:flex">
          <div className="px-3 pb-7">
            <div className="font-display text-xl font-semibold tracking-tight text-pine">
              Admin Console
            </div>
            <div className="mt-1 font-sans text-sm text-ink-muted">運営管理</div>
          </div>
          <nav aria-label="メイン" className="flex flex-1 flex-col gap-1">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="px-3.5 pt-4">
            <div className="mb-2.5 font-sans text-sm text-ink-muted">
              <strong className="block font-sans text-sm font-semibold text-ink">
                管理者アカウント
              </strong>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex min-h-11 items-center font-sans text-sm text-ink-muted hover:text-ink"
            >
              ログアウト
            </button>
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 px-5 pt-6 pb-24 md:px-10 md:pt-8">
          <Outlet />
        </main>
      </div>

      <nav
        aria-label="メイン"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface md:hidden"
      >
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={tabClass}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-h-11 items-center rounded-ctl px-3.5 font-sans text-sm transition-colors',
    isActive
      ? 'bg-pine/10 font-semibold text-pine'
      : 'text-ink-muted hover:bg-paper hover:text-ink',
  )
}

function tabClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 font-sans text-xs',
    isActive ? 'font-semibold text-pine' : 'text-ink-muted',
  )
}
