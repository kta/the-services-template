import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

async function addSymlink(root, path, target) {
  const link = join(root, path)
  await mkdir(join(link, '..'), { recursive: true })
  await symlink(target, link)
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
const playwrightImport = `import { test } from '@playwright/test'\n`
const mappedTest = `${playwrightImport}// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`

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
      'services/example/e2e/items.spec.ts': `${playwrightImport}// @e2e-covers AC-UNKNOWN-99\ntest('creates an item', async () => {})\n`,
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
        'Duplicate E2E mapping for AC-ITEM-01: services/example/e2e/items.spec.ts:2, services/example/e2e/items.spec.ts:5.',
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

for (const modifier of ['skip', 'fixme', 'only']) {
  test(`rejects an E2E mapping on test.${modifier}`, async () => {
    await withFixture(
      {
        'specs/example/features/001/spec.md': approvedSpec,
        'services/example/e2e/items.spec.ts': `${playwrightImport}// @e2e-covers AC-ITEM-01\ntest.${modifier}('creates an item', async () => {})\n`,
      },
      async (root) => {
        assert.deepEqual(await validateTraceability(root), [
          `E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:2 targets test.${modifier}, which cannot satisfy traceability.`,
          'Missing E2E mapping for approved AC-ITEM-01.',
        ])
      },
    )
  })
}

test('requires every feature spec to declare a status', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': '# Feature\n\n- AC-ITEM-01: creates an item\n',
      'services/example/e2e/items.spec.ts': mappedTest,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'Feature spec specs/example/features/001/spec.md must declare `- ステータス: Draft` or `- ステータス: Approved`.',
        'Unknown E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts.',
      ])
    },
  )
})

test('accepts an aliased Playwright test import', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `import { test as playwrightTest } from '@playwright/test'\n// @e2e-covers AC-ITEM-01\nplaywrightTest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [])
    },
  )
})

test('rejects a local function named test', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `function test() {}\n// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:2 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a shadowed Playwright test binding', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `import { test as playwrightTest } from '@playwright/test'\nfunction scoped(playwrightTest: () => void) {\n  // @e2e-covers AC-ITEM-01\n  playwrightTest()\n}\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:3 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a mapping inside an uncalled function despite a Playwright import', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `${playwrightImport}function registerScenario() {\n  // @e2e-covers AC-ITEM-01\n  test('creates an item', async () => {})\n}\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:3 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a mapping inside a skipped describe block', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `${playwrightImport}test.describe.skip('disabled suite', () => {\n  // @e2e-covers AC-ITEM-01\n  test('creates an item', async () => {})\n})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:3 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a mapping backed only by a type-only Playwright import', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `import type { test } from '@playwright/test'\n// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:2 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('accepts an imported top-level registration despite a nested shadow', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `import { test as playwrightTest } from '@playwright/test'\n// @e2e-covers AC-ITEM-01\nplaywrightTest('creates an item', async () => {})\nfunction helper(playwrightTest: () => void) {\n  playwrightTest()\n}\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [])
    },
  )
})

test('rejects a top-level binding that shadows the Playwright import before it', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `const playwrightTest = () => {}\nimport { test as playwrightTest } from '@playwright/test'\n// @e2e-covers AC-ITEM-01\nplaywrightTest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:3 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a module-scoped var shadow inside a top-level block', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `${playwrightImport}{\n  var test = () => {}\n}\n// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:5 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('rejects a test imported from another module', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': `import { test } from 'vitest'\n// @e2e-covers AC-ITEM-01\ntest('creates an item', async () => {})\n`,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'E2E mapping AC-ITEM-01 in services/example/e2e/items.spec.ts:2 does not target a Playwright test.',
        'Missing E2E mapping for approved AC-ITEM-01.',
      ])
    },
  )
})

test('only extracts UC and AC identifiers from definition bullets', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': `# Feature\n\n- ステータス: Approved\n\n本文で AC-ITEM-99 を参照する。\n\n- AC-ITEM-01: creates an item\n`,
      'services/example/e2e/items.spec.ts': mappedTest,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [])
    },
  )
})

test('reports an identifier defined by more than one approved spec', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'specs/example/features/002/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': mappedTest,
    },
    async (root) => {
      assert.deepEqual(await validateTraceability(root), [
        'Duplicate specification identifier AC-ITEM-01: specs/example/features/001/spec.md, specs/example/features/002/spec.md.',
      ])
    },
  )
})

test('rejects symlinked specification and E2E files without following them', async () => {
  await withFixture(
    {
      'specs/example/features/001/spec.md': approvedSpec,
      'services/example/e2e/items.spec.ts': mappedTest,
    },
    async (root) => {
      const external = await mkdtemp(join(tmpdir(), 'e2e-traceability-external-'))
      try {
        const externalSpec = join(external, 'spec.md')
        const externalE2E = join(external, 'items.spec.ts')
        await writeFile(externalSpec, approvedSpec)
        await writeFile(externalE2E, mappedTest)
        await addSymlink(root, 'specs/example/features/002/spec.md', externalSpec)
        await addSymlink(root, 'services/example/e2e/external.spec.ts', externalE2E)
        assert.deepEqual(await validateTraceability(root), [
          'Refusing non-regular specification file specs/example/features/002/spec.md.',
          'Refusing non-regular E2E file services/example/e2e/external.spec.ts.',
        ])
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    },
  )
})
