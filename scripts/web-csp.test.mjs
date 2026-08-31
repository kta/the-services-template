import assert from 'node:assert/strict'
import test from 'node:test'
import { PRODUCTION_WEB_CSP, strictProductionCsp, webCspPlugin } from './web-csp.mjs'

const developmentHtml = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*">`

test('production CSP removes dev WebSocket and unsafe-inline permissions', () => {
  const built = strictProductionCsp(developmentHtml)
  assert.match(built, new RegExp(PRODUCTION_WEB_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(built, /unsafe-inline|localhost|127\.0\.0\.1/)
  assert.match(built, /frame-ancestors 'none'/)
})

test('the Vite plugin leaves dev HTML intact and transforms build HTML', () => {
  const plugin = webCspPlugin()
  assert.equal(plugin.transformIndexHtml(developmentHtml, { server: {} }), developmentHtml)
  assert.equal(plugin.transformIndexHtml(developmentHtml, {}), strictProductionCsp(developmentHtml))
})
