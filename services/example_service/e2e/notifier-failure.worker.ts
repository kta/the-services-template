export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === '/health') return new Response('ok')
    return new Response('E2E notifier failure fixture', {
      status: 418,
      headers: { 'x-e2e-notifier-fixture': 'failure' },
    })
  },
}
