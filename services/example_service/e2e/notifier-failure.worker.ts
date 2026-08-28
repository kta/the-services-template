type FixtureEnv = {
  E2E_FIXTURE_CONTROL_TOKEN?: string
  E2E_FIXTURE_INTERNAL_KEY?: string
}

type SafeJob = {
  id: string
  type: string
  recipientDomain: string
  payloadKeys: string[]
  itemId?: string
  titleLength?: number
}

type CapturedRequest = {
  caller: string
  job: SafeJob | null
  method: string
  pathname: string
}

let calls = 0
let lastRequest: CapturedRequest | null = null

function isAuthorized(request: Request, expected: string | undefined, header: string): boolean {
  return Boolean(expected && expected.length >= 32 && request.headers.get(header) === expected)
}

function recordSafeJob(value: unknown): SafeJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const payload =
    input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {}
  const to = typeof input.to === 'string' ? input.to : ''
  const itemId = typeof payload.itemId === 'string' ? payload.itemId : undefined
  const title = typeof payload.title === 'string' ? payload.title : undefined
  return {
    id: typeof input.id === 'string' ? input.id : '',
    type: typeof input.type === 'string' ? input.type : '',
    recipientDomain: to.includes('@') ? to.slice(to.lastIndexOf('@') + 1) : '',
    payloadKeys: Object.keys(payload).sort(),
    ...(itemId ? { itemId } : {}),
    ...(title ? { titleLength: title.length } : {}),
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')

    if (url.pathname === '/__e2e/reset' && request.method === 'POST') {
      if (!isAuthorized(request, env.E2E_FIXTURE_CONTROL_TOKEN, 'x-e2e-control-token'))
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      calls = 0
      lastRequest = null
      return Response.json({ calls })
    }

    if (url.pathname === '/__e2e/status' && request.method === 'GET') {
      if (!isAuthorized(request, env.E2E_FIXTURE_CONTROL_TOKEN, 'x-e2e-control-token'))
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({ calls, lastRequest })
    }

    if (url.pathname === '/api/internal/send' && request.method === 'POST') {
      if (
        !isAuthorized(request, env.E2E_FIXTURE_INTERNAL_KEY, 'x-internal-key') ||
        request.headers.get('x-internal-caller') !== 'domain'
      )
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      const body = await request.text()
      if (body.length > 64 * 1024) return new Response('payload too large', { status: 413 })
      calls += 1
      lastRequest = {
        caller: 'domain',
        job: recordSafeJob(JSON.parse(body) as unknown),
        method: request.method,
        pathname: url.pathname,
      }
      return Response.json(
        { error: 'E2E notifier failure fixture' },
        { status: 418, headers: { 'x-e2e-notifier-fixture': 'failure' } },
      )
    }
    return new Response('not found', { status: 404 })
  },
}
