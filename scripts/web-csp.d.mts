export const PRODUCTION_WEB_CSP: string
export function strictProductionCsp(html: string): string
export function webCspPlugin(): {
  name: string
  transformIndexHtml(html: string, context?: { server?: unknown }): string
}
