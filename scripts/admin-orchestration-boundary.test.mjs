import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateAdminDomainOrchestrationFiles } from './service-wiring.mjs'

async function withAdminSources(syncSource, workerSource, check) {
  const root = await mkdtemp(join(tmpdir(), 'admin-orchestration-'))
  const workerRoot = join(root, 'services/admin/src/worker')
  await mkdir(workerRoot, { recursive: true })
  await writeFile(join(workerRoot, 'sync.ts'), syncSource)
  await writeFile(join(workerRoot, 'index.ts'), workerSource)
  try {
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const orchestrationImport =
  "import { orchestrateDomainSyncIdentities } from './domain-sync-orchestration.mjs'\n"

test('accepts Worker request and scheduled paths that execute the shared orchestration boundary', async () => {
  await withAdminSources(
    `${orchestrationImport}
export async function syncOrgToConfiguredDomains(environment, identities, org) {
  return orchestrateDomainSyncIdentities(environment, identities, (target) =>
    syncOrgToDomain(target, org),
  )
}
`,
    `${orchestrationImport}
async function scheduled(event, env) {
  await cleanUp(event, env)
  await orchestrateDomainSyncIdentities(env, identities, reconcileDomain, {
    concurrency: 'sequential',
  })
}
`,
    async (root) => {
      assert.deepEqual(await validateAdminDomainOrchestrationFiles(root), [])
    },
  )
})

test('rejects an unused correct resolver beside a hard-coded sync.ts production call path', async () => {
  await withAdminSources(
    `import { resolveDomainSyncIdentity } from './domain-sync-orchestration.mjs'
void resolveDomainSyncIdentity
export async function syncOrgToConfiguredDomains(environment, identities, org) {
  return syncOrgToDomain({
    directory: 'booking',
    binding: environment.BOOKING,
    key: environment.ADMIN_TO_BOOKING_KEY,
  }, org)
}
`,
    `${orchestrationImport}
async function scheduled(_event, env) {
  await orchestrateDomainSyncIdentities(env, identities, reconcileDomain)
}
`,
    async (root) => {
      assert.match(
        (await validateAdminDomainOrchestrationFiles(root)).join('\n'),
        /sync\.ts.*production domain orchestration call path/i,
      )
    },
  )
})

test('comments and dead code cannot stand in for the scheduled orchestration call path', async () => {
  await withAdminSources(
    `${orchestrationImport}
export async function syncOrgToConfiguredDomains(environment, identities, org) {
  return orchestrateDomainSyncIdentities(environment, identities, (target) =>
    syncOrgToDomain(target, org),
  )
}
`,
    `${orchestrationImport}
// orchestrateDomainSyncIdentities(env, identities, reconcileDomain)
function unused() {
  return orchestrateDomainSyncIdentities(env, identities, reconcileDomain)
}
async function scheduled(_event, env) {
  for (const identity of identities) await reconcileDomain(identity, env.BOOKING)
}
`,
    async (root) => {
      assert.match(
        (await validateAdminDomainOrchestrationFiles(root)).join('\n'),
        /index\.ts.*scheduled.*orchestration call path/i,
      )
    },
  )
})
