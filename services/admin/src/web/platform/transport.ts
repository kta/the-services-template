import type { InvokeArgs } from '@tauri-apps/api/core'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const ALLOWED_HEADERS = new Set(['authorization', 'content-type'])

export type TauriRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
}

export type TauriResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown }

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as TauriWindow).__TAURI_INTERNALS__)
}

function pathFromInput(input: RequestInfo | URL): string {
  let raw: string
  if (input instanceof Request) {
    let requestUrl: URL
    try {
      requestUrl = new URL(input.url)
    } catch {
      throw new TypeError('Tauri API request path is malformed')
    }
    const documentOrigin = typeof location === 'undefined' ? null : location.origin
    if (documentOrigin === null || requestUrl.origin !== documentOrigin) {
      throw new TypeError('Tauri API requests must use a same-origin relative path')
    }
    raw = `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
  } else {
    raw = typeof input === 'string' ? input : input.toString()
  }
  if (!raw.startsWith('/api/') || raw.includes('\\')) {
    throw new TypeError('Tauri API requests must use a relative /api/ path')
  }

  let parsed: URL
  try {
    parsed = new URL(raw, 'https://tauri.invalid')
  } catch {
    throw new TypeError('Tauri API request path is malformed')
  }
  if (parsed.origin !== 'https://tauri.invalid' || parsed.hash !== '') {
    throw new TypeError('Tauri API requests must use a relative /api/ path')
  }

  const decodedPath = decodeURIComponent(parsed.pathname)
  const segments = decodedPath.split('/')
  if (
    !decodedPath.startsWith('/api/') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TypeError('Tauri API request path is malformed')
  }
  return `${parsed.pathname}${parsed.search}`
}

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    const normalized = name.toLowerCase()
    if (!ALLOWED_HEADERS.has(normalized)) {
      throw new TypeError(`Tauri request header is not allowed: ${name}`)
    }
    headers[normalized] = value
  }
  return headers
}

function redactedResponse(result: TauriResponse): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(result.headers)) {
    if (name.toLowerCase() !== 'set-cookie') headers.set(name, value)
  }
  return new Response(result.body, { status: result.status, headers })
}

async function invokeApiRequest(payload: TauriRequest): Promise<TauriResponse> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<TauriResponse>('api_request', payload as InvokeArgs)
}

async function tauriFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new TypeError(`Tauri API method is not allowed: ${method}`)
  }

  const headers = input instanceof Request ? new Headers(input.headers) : new Headers()
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
  let body: BodyInit | null | undefined = init.body
  if (body === undefined && input instanceof Request && input.body !== null) {
    body = await input.clone().text()
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('Tauri API request body must be a string')
  }
  if (method === 'GET' && body !== undefined && body !== null) {
    throw new TypeError('GET requests cannot have a body')
  }

  const payload: TauriRequest = {
    method,
    path: pathFromInput(input),
    headers: requestHeaders(new Request('https://tauri.invalid', { headers })),
    body: method === 'GET' || body === undefined || body === null ? null : body,
  }
  return redactedResponse(await invokeApiRequest(payload))
}

export function platformFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isTauriRuntime()) return fetch(input, init)
  return tauriFetch(input, init)
}
