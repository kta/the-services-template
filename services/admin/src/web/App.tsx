import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { bootstrap } from './auth/session'
import { useAuthenticated } from './auth/useSession'
import { AppShell } from './components/AppShell'
import { Toaster } from './components/Toaster'
import { Spinner } from './components/ui'
import { Invite } from './routes/Invite'
import { Login } from './routes/Login'
import { Orgs } from './routes/Orgs'

/**
 * admin SPA のルート。起動時に cookie でセッション復帰(refresh)を試み、
 * 未認証は Login へ。AppShell 配下(組織一覧)が保護領域。/invite は公開
 * (招待メールのリンク先)。
 */
export function App() {
  return (
    <BrowserRouter>
      {/* 全ルート共通のトースト表示点(Login も含む)。 */}
      <Toaster />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite" element={<Invite />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<Orgs />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

function RequireAuth() {
  const authed = useAuthenticated()
  const location = useLocation()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    bootstrap().finally(() => {
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper">
        <Spinner label="読み込み中" />
      </div>
    )
  }
  if (!authed) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}
