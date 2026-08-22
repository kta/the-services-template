type CapturedRequest = {
  headers: Record<string, string>
  job: unknown
  method: string
  pathname: string
}

let calls = 0
let lastRequest: CapturedRequest | null = null

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')
    if (url.pathname === '/__e2e/reset' && request.method === 'POST') {
      calls = 0
      lastRequest = null
      return Response.json({ calls })
    }
    if (url.pathname === '/__e2e/status' && request.method === 'GET') {
      return Response.json({ calls, lastRequest })
    }
    if (url.pathname === '/api/internal/send' && request.method === 'POST') {
      calls += 1
      lastRequest = {
        headers: Object.fromEntries(request.headers),
        job: await request.json().catch(() => null),
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
