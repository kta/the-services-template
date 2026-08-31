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
const scheduledImports = `${orchestrationImport}import { reconcileOrgs } from './reconcile'\nimport { listDomainOrgs, syncOrgToDomain } from './sync'\n`

const validRequestSource = `${orchestrationImport}
export async function syncOrgToConfiguredDomains(environment, identities, org) {
  return await orchestrateDomainSyncIdentities(
    environment,
    identities,
    (target) => syncOrgToDomain(target, org),
    {
      concurrency: 'parallel',
      onFailure(identity, error) {
        console.error(\`failed to resolve domain sync target \${identity.directory}\`, error)
      },
    },
  )
}
`

const validScheduledSource = `${scheduledImports}
async function scheduled(_event, env) {
  await cleanUp(_event, env)
  await orchestrateDomainSyncIdentities(
    env,
    identities,
    async (target) => {
      const result = await reconcileOrgs({
        listAdminOrgs: loadAdminOrgs,
        listDomainOrgs: () => listDomainOrgs(target),
        resync: (org) => syncOrgToDomain(target, toOrganization(org.row)),
        notifyDrift: async ({ drift, failed, truncated }) => {
          const alertEmail = configuredAlertEmail(env)
          if (!alertEmail) {
            console.warn(
              \`sync drift detected for \${target.directory} but OPS_ALERT_EMAIL is unset\`,
              drift,
            )
            return
          }
          await notify(env, {
            id: \`ops.sync_drift:\${target.directory}:\${new Date().toISOString().slice(0, 10)}\`,
            type: 'ops.sync_drift',
            to: alertEmail,
            payload: {
              domain: target.directory,
              organizationIds: drift,
              count: drift.length,
              failed,
              truncated,
            },
          })
        },
      })
      if (result.drift.length > 0) {
        console.warn(\`org sync drift reconciled for \${target.directory}\`, result)
      }
    },
    {
      concurrency: 'sequential',
      onFailure: (identity, error) =>
        reportReconcileFailure(env, identity.directory, error),
    },
  )
}
`

test('accepts Worker request and scheduled paths that execute the shared orchestration boundary', async () => {
  await withAdminSources(validRequestSource, validScheduledSource, async (root) => {
    assert.deepEqual(await validateAdminDomainOrchestrationFiles(root), [])
  })
})

for (const { name, syncSource = validRequestSource, workerSource = validScheduledSource } of [
  {
    name: 'a locally shadowed orchestration import',
    syncSource: validRequestSource.replace(
      '  return await orchestrateDomainSyncIdentities(',
      '  const orchestrateDomainSyncIdentities = async () => true\n  return await orchestrateDomainSyncIdentities(',
    ),
  },
  {
    name: 'a request callback that discards the computed target',
    syncSource: validRequestSource.replace(
      '(target) => syncOrgToDomain(target, org)',
      `() => syncOrgToDomain({
      directory: 'booking',
      binding: environment.BOOKING,
      key: environment.ADMIN_TO_BOOKING_KEY,
    }, org)`,
    ),
  },
  {
    name: 'an unawaited request orchestration call',
    syncSource: validRequestSource.replace('return await orchestrate', 'return orchestrate'),
  },
  {
    name: 'request orchestration with swapped environment and identities arguments',
    syncSource: validRequestSource.replace(
      '    environment,\n    identities,',
      '    identities,\n    environment,',
    ),
  },
  {
    name: 'request orchestration with sequential concurrency',
    syncSource: validRequestSource.replace("concurrency: 'parallel'", "concurrency: 'sequential'"),
  },
  {
    name: 'request orchestration with a malformed failure callback',
    syncSource: validRequestSource.replace(
      `onFailure(identity, error) {
        console.error(\`failed to resolve domain sync target \${identity.directory}\`, error)
      }`,
      `onFailure() {
        console.error('failed')
      }`,
    ),
  },
  {
    name: 'a scheduled callback that discards the computed target',
    workerSource: validScheduledSource
      .replace('listDomainOrgs(target)', 'listDomainOrgs(env.BOOKING)')
      .replace(
        'syncOrgToDomain(target, toOrganization(org.row))',
        'syncOrgToDomain(env.BOOKING, toOrganization(org.row))',
      ),
  },
  {
    name: 'a scheduled resync callback that substitutes a different organization',
    workerSource: validScheduledSource.replace(
      'resync: (org) => syncOrgToDomain(target, toOrganization(org.row))',
      'resync: (_org) => syncOrgToDomain(target, toOrganization(hardCodedOrganization.row))',
    ),
  },
  {
    name: 'a locally shadowed scheduled sync callee',
    workerSource: validScheduledSource.replace(
      "import { listDomainOrgs, syncOrgToDomain } from './sync'",
      "import { listDomainOrgs } from './sync'\nconst syncOrgToDomain = async (_target, org) => Boolean(org)",
    ),
  },
  {
    name: 'a dead computed directory beside hard-coded notification and log identities',
    workerSource: validScheduledSource
      .replace(
        'const alertEmail = configuredAlertEmail(env)',
        'void target.directory\n          const alertEmail = configuredAlertEmail(env)',
      )
      .replace(
        `id: \`ops.sync_drift:\${target.directory}:\${new Date().toISOString().slice(0, 10)}\``,
        `id: \`ops.sync_drift:example_service:\${new Date().toISOString().slice(0, 10)}\``,
      )
      .replace('domain: target.directory', "domain: 'example_service'")
      .replace(
        `\`org sync drift reconciled for \${target.directory}\``,
        "'org sync drift reconciled for example_service'",
      ),
  },
  {
    name: 'an unawaited scheduled orchestration call',
    workerSource: validScheduledSource.replace(
      '  await orchestrateDomainSyncIdentities(',
      '  orchestrateDomainSyncIdentities(',
    ),
  },
  {
    name: 'a scheduled callback with an unawaited reconcile operation',
    workerSource: validScheduledSource.replace(
      'const result = await reconcileOrgs(',
      'const result = reconcileOrgs(',
    ),
  },
  {
    name: 'scheduled orchestration with the wrong arity',
    workerSource: validScheduledSource.replace(
      `    {
      concurrency: 'sequential',
      onFailure: (identity, error) =>
        reportReconcileFailure(env, identity.directory, error),
    },`,
      '',
    ),
  },
  {
    name: 'parallel scheduled orchestration',
    workerSource: validScheduledSource.replace(
      "concurrency: 'sequential'",
      "concurrency: 'parallel'",
    ),
  },
  {
    name: 'scheduled orchestration with a malformed failure callback',
    workerSource: validScheduledSource.replace(
      `(identity, error) =>
        reportReconcileFailure(env, identity.directory, error)`,
      `() => reportReconcileFailure(env, 'booking', new Error('failed'))`,
    ),
  },
]) {
  test(`rejects ${name}`, async () => {
    await withAdminSources(syncSource, workerSource, async (root) => {
      assert.match(
        (await validateAdminDomainOrchestrationFiles(root)).join('\n'),
        /production domain orchestration call path|scheduled domain orchestration call path/i,
      )
    })
  })
}

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
