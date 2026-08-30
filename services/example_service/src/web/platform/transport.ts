function apiUrl(input: RequestInfo | URL): URL {
  let url: URL
  try {
    if (typeof input === 'string') {
      if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) {
        throw new TypeError('Web API requests must use a same-origin /api/ path')
      }
      url = new URL(input, location.origin)
    } else if (input instanceof Request) {
      url = new URL(input.url)
    } else {
      url = new URL(input.toString())
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('same-origin /api/ path')) {
      throw error
    }
    throw new TypeError('Web API requests must use a same-origin /api/ path')
  }

  if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.hash !== '') {
    throw new TypeError('Web API requests must use a same-origin /api/ path')
  }
  return url
}

export async function platformFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  apiUrl(input)
  return fetch(input, { ...init, redirect: 'error' })
}
