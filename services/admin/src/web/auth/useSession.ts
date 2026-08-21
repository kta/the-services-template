import { useSyncExternalStore } from 'react'
import { isAuthenticated, subscribe } from './session'

/** access token の有無をリアクティブに購読する(ルートガード / AppShell 用)。 */
export function useAuthenticated(): boolean {
  return useSyncExternalStore(subscribe, isAuthenticated, () => false)
}
