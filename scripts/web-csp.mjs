/**
 * Browser production CSP for the two SPA Workers and their Tauri static build.
 * Vite's development server needs its loopback WebSocket, so the source
 * index.html keeps a development policy and this plugin replaces it only for
 * builds. Cloudflare Workers Static Assets additionally receives the same
 * policy (including frame-ancestors) through public/_headers.
 */
export const PRODUCTION_WEB_CSP =
  "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'"

const CSP_META_PATTERN =
  /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=)(["'])(.*?)(\2\s*\/?>)/i

export function strictProductionCsp(html) {
  return html.replace(CSP_META_PATTERN, `$1$2${PRODUCTION_WEB_CSP}$4`)
}

export function webCspPlugin() {
  return {
    name: 'production-web-csp',
    transformIndexHtml(html, context) {
      // Keep HMR usable on the local dev server. A production build has no
      // Vite server context and must not retain loopback WebSocket or inline
      // style permissions.
      return context?.server ? html : strictProductionCsp(html)
    },
  }
}
