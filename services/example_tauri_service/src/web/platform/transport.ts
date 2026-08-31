import type { InvokeArgs } from '@tauri-apps/api/core'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const ALLOWED_HEADERS = new Set(['authorization', 'content-type'])
const ALLOWED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-type',
  'etag',
  'retry-after',
  'x-request-id',
])
const MAX_PATH_BYTES = 2048
const MAX_HEADER_COUNT = 16
const MAX_HEADER_NAME_BYTES = 128
const MAX_REQUEST_HEADER_TOTAL_BYTES = 16 * 8192
const MAX_HEADER_VALUE_BYTES = 8192
const MAX_BODY_BYTES = 1_048_576
const MAX_RESPONSE_HEADER_TOTAL_BYTES = 64 * 1024
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024
const BODY_READ_TIMEOUT_MS = 15_000

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function hasPathControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

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
  if (typeof Request !== 'undefined' && input instanceof Request) {
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

  // URL normalizes dot segments. Validate the unparsed path first so a path
  // such as /api/items/../admin cannot become /api/admin at this boundary.
  const queryStart = raw.indexOf('?')
  const fragmentStart = raw.indexOf('#')
  const pathEnd = [queryStart, fragmentStart]
    .filter((index) => index >= 0)
    .reduce((end, index) => Math.min(end, index), raw.length)
  const rawPath = raw.slice(0, pathEnd)
  let decodedRawPath: string
  try {
    decodedRawPath = decodeURIComponent(rawPath)
  } catch {
    throw new TypeError('Tauri API request path is malformed')
  }
  const rawSegments = decodedRawPath.split('/')
  if (
    !decodedRawPath.startsWith('/api/') ||
    decodedRawPath.includes('%') ||
    /%2f/i.test(rawPath) ||
    decodedRawPath.includes('\\') ||
    decodedRawPath.includes('?') ||
    decodedRawPath.includes('#') ||
    hasPathControlCharacter(decodedRawPath) ||
    rawSegments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TypeError('Tauri API request path is malformed')
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

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    throw new TypeError('Tauri API request path is malformed')
  }
  const segments = decodedPath.split('/')
  if (
    !decodedPath.startsWith('/api/') ||
    decodedPath.includes('%') ||
    hasPathControlCharacter(decodedPath) ||
    decodedPath.includes('\\') ||
    decodedPath.includes('?') ||
    decodedPath.includes('#') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TypeError('Tauri API request path is malformed')
  }
  return `${parsed.pathname}${parsed.search}`
}

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  let totalBytes = 0
  let headerCount = 0
  for (const [name, value] of request.headers) {
    headerCount += 1
    if (headerCount > MAX_HEADER_COUNT) {
      throw new TypeError('Tauri request has too many headers')
    }
    const normalized = name.toLowerCase()
    if (!ALLOWED_HEADERS.has(normalized)) {
      throw new TypeError(`Tauri request header is not allowed: ${name}`)
    }
    if (byteLength(name) > MAX_HEADER_NAME_BYTES) {
      throw new TypeError(`Tauri request header name is too large: ${name}`)
    }
    if (byteLength(value) > MAX_HEADER_VALUE_BYTES) {
      throw new TypeError(`Tauri request header is too large: ${name}`)
    }
    totalBytes += byteLength(name) + byteLength(value)
    if (totalBytes > MAX_REQUEST_HEADER_TOTAL_BYTES) {
      throw new TypeError('Tauri request headers are too large')
    }
    headers[normalized] = value
  }
  return headers
}

function requestMethod(input: RequestInfo | URL, init: RequestInit): string {
  return (
    init.method ??
    (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
  ).toUpperCase()
}

function combinedRequestHeaders(input: RequestInfo | URL, init: RequestInit): Headers {
  const headers =
    typeof Request !== 'undefined' && input instanceof Request
      ? new Headers(input.headers)
      : new Headers()
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
  return headers
}

function validateWebRequest(input: RequestInfo | URL, init: RequestInit): void {
  const method = requestMethod(input, init)
  if (byteLength(method) > 16) throw new TypeError('API method is too large')
  if (!ALLOWED_METHODS.has(method)) throw new TypeError(`API method is not allowed: ${method}`)

  const path = pathFromInput(input)
  if (byteLength(path) > MAX_PATH_BYTES) throw new TypeError('API request path is too large')
  requestHeaders(
    new Request('https://tauri.invalid', { headers: combinedRequestHeaders(input, init) }),
  )

  if (init.redirect !== undefined && init.redirect !== 'error') {
    throw new TypeError('API redirects are not followed')
  }
  const body = init.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('API request body must be a string')
  }
  if (method === 'GET' && body !== undefined && body !== null) {
    throw new TypeError('GET requests cannot have a body')
  }
  if (
    method === 'GET' &&
    body === undefined &&
    typeof Request !== 'undefined' &&
    input instanceof Request &&
    input.body !== null
  ) {
    throw new TypeError('GET requests cannot have a body')
  }
  if (body !== undefined && body !== null && byteLength(body) > MAX_BODY_BYTES) {
    throw new TypeError('API request body is too large')
  }
}

async function readBodyWithinLimit(request: Request): Promise<string> {
  return readStreamWithinLimit(
    request.body,
    MAX_BODY_BYTES,
    'Tauri API request body is too large',
    'Tauri request body read timed out',
  )
}

async function readResponseWithinLimit(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
      throw new TypeError('API response body is too large')
    }
  }
  return readStreamWithinLimit(
    response.body,
    MAX_RESPONSE_BODY_BYTES,
    'API response body is too large',
    'API response body read timed out',
  )
}

async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeMessage: string,
  timeoutMessage: string,
): Promise<string> {
  const reader = stream?.getReader()
  if (!reader) return ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TypeError(timeoutMessage)), BODY_READ_TIMEOUT_MS)
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout])
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        throw new TypeError(tooLargeMessage)
      }
      chunks.push(decoder.decode(result.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    // A hostile/custom stream is allowed to stall cancellation. Do not wait
    // indefinitely after the byte limit has already been crossed.
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    reader.releaseLock()
  }
}

function redactedResponse(result: TauriResponse): Response {
  if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 600) {
    throw new TypeError('Tauri API response status is invalid')
  }
  if (result.status >= 300 && result.status < 400) {
    throw new TypeError('Tauri API redirects are not followed')
  }
  if (byteLength(result.body) > MAX_RESPONSE_BODY_BYTES) {
    throw new TypeError('Tauri API response body is too large')
  }
  const headers = new Headers()
  let totalBytes = 0
  let headerCount = 0
  for (const [name, value] of Object.entries(result.headers)) {
    headerCount += 1
    if (headerCount > MAX_HEADER_COUNT) {
      throw new TypeError('Tauri API response has too many headers')
    }
    const normalized = name.toLowerCase()
    if (!ALLOWED_RESPONSE_HEADERS.has(normalized)) continue
    if (
      byteLength(value) > MAX_HEADER_VALUE_BYTES ||
      Array.from(value).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 0x20 || code === 0x7f
      })
    ) {
      continue
    }
    const nextTotal = totalBytes + byteLength(normalized) + byteLength(value)
    if (nextTotal > MAX_RESPONSE_HEADER_TOTAL_BYTES) continue
    totalBytes = nextTotal
    headers.set(normalized, value)
  }
  // Fetch forbids a body on 204/205. Native IPC is untrusted input, so discard
  // an accidentally supplied body instead of constructing an invalid Response.
  return new Response(result.status === 204 || result.status === 205 ? null : result.body, {
    status: result.status,
    headers,
  })
}

async function browserResponse(response: Response): Promise<Response> {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 600) {
    throw new TypeError('API response status is invalid')
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TypeError('API redirects are not followed')
  }
  const body = await readResponseWithinLimit(response)
  const headers = new Headers()
  let totalBytes = 0
  let headerCount = 0
  for (const [name, value] of response.headers) {
    const normalized = name.toLowerCase()
    if (!ALLOWED_RESPONSE_HEADERS.has(normalized)) continue
    headerCount += 1
    if (headerCount > MAX_HEADER_COUNT) {
      throw new TypeError('API response has too many headers')
    }
    if (
      byteLength(value) > MAX_HEADER_VALUE_BYTES ||
      Array.from(value).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 0x20 || code === 0x7f
      })
    ) {
      continue
    }
    const nextTotal = totalBytes + byteLength(normalized) + byteLength(value)
    if (nextTotal > MAX_RESPONSE_HEADER_TOTAL_BYTES) continue
    totalBytes = nextTotal
    headers.set(normalized, value)
  }
  return new Response(response.status === 204 || response.status === 205 ? null : body, {
    status: response.status,
    headers,
  })
}

async function invokeApiRequest(payload: TauriRequest): Promise<TauriResponse> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<TauriResponse>('api_request', payload as InvokeArgs)
}

async function tauriFetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const method = requestMethod(input, init)
  if (byteLength(method) > 16) {
    throw new TypeError('Tauri API method is too large')
  }
  if (!ALLOWED_METHODS.has(method)) {
    throw new TypeError(`Tauri API method is not allowed: ${method}`)
  }

  const headers = combinedRequestHeaders(input, init)
  const path = pathFromInput(input)
  if (byteLength(path) > MAX_PATH_BYTES) {
    throw new TypeError('Tauri API request path is too large')
  }

  let body: BodyInit | null | undefined = init.body
  if (
    body === undefined &&
    typeof Request !== 'undefined' &&
    input instanceof Request &&
    input.body !== null
  ) {
    body = await readBodyWithinLimit(input)
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('Tauri API request body must be a string')
  }
  if (method === 'GET' && body !== undefined && body !== null) {
    throw new TypeError('GET requests cannot have a body')
  }

  if (body !== undefined && body !== null && byteLength(body) > MAX_BODY_BYTES) {
    throw new TypeError('Tauri API request body is too large')
  }

  const payload: TauriRequest = {
    method,
    path,
    headers: requestHeaders(new Request('https://tauri.invalid', { headers })),
    body: method === 'GET' || body === undefined || body === null ? null : body,
  }
  return redactedResponse(await invokeApiRequest(payload))
}

export function platformFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isTauriRuntime()) {
    return (async () => {
      validateWebRequest(input, init)
      if (
        init.body === undefined &&
        typeof Request !== 'undefined' &&
        input instanceof Request &&
        input.body !== null
      ) {
        // Inspect a clone so the original Request remains available to fetch.
        await readBodyWithinLimit(input.clone())
      }
      return browserResponse(await fetch(input, { ...init, redirect: 'error' }))
    })()
  }
  return tauriFetch(input, init)
}
