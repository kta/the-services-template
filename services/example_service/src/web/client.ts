import type { AppType } from '@app/example_service'
import { hc } from 'hono/client'
import { auth } from './auth/session'

// Typed Hono RPC client. The API lives on this same origin (one Worker serves
// SPA + API), so the base is simply '/'. `authFetch` attaches the bearer token.
export const client = hc<AppType>('/', { fetch: auth.authFetch })
