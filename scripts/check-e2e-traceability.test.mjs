import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateTraceability } from './check-e2e-traceability.mjs'

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'e2e-traceability-'))
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const path = join(root, file)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }),
  )
  return root
}

async function withFixture(files, check) {
  const root = await fixture(files)
  try {
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const approvedSpec = `# Feature\n\n- ステータス: Approved\n\n- AC-ITEM-01: creates an item\n`
const mappedTest = `// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`

test('accepts every approved identifier mapped to one Playwright test', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': mappedTest,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [])
    },
  )
})

test('reports an approved identifier without an E2E mapping', async () => {
  await withFixture({ 'specs/example/features/001/spec.md': approvedSpec }, async (root) => {
    assert.deepEqual(await validateTraceability(root), [
      'Missing E2E mapping for approved AC-ITEM-01.',
    ])
  })
})

test('reports an unknown E2E mapping', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts':
        "// @e2e-covers AC-UNKNOWN-99\ntest('creates an item', async () => {})\n",
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'Unknown E2E mapping AC-UNKNOWN-99 in services/example/e2e/items.spec.ts.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('reports an identifier mapped by more than one E2E test', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `${mappedTest}\n// @e2e-covers AC-ITEM-01\ntest('creates it again', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'Duplicate E2E mapping for AC-ITEM-01: services/example/e2e/items.spec.ts:1, services/example/e2e/items.spec.ts:4.',
      ])
    },
  )
})

test('reports a mapping comment that is not attached to a Playwright test', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': "// @e2e-covers AC-ITEM-01\nconst title = 'orphaned'\n",
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:1 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})
