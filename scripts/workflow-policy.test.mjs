import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  inspectNativeWorkflowPolicy,
  inspectWorkflowPolicy,
  parseGithubWorkflow,
} from './workflow-policy.mjs'

test('parses the checked-in CI job topology and finds no production capability drift', async () => {
  const source = await readFile(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
  const workflow = parseGithubWorkflow(source)
  assert.deepEqual(Object.keys(workflow.jobs), ['verify', 'e2e', 'build-production', 'deploy'])
  assert.deepEqual(inspectWorkflowPolicy('ci.yml', source), [])
})

test('rejects a new credential-bearing job even when text checks would skip the workflow', () => {
  const source = `
name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  verify:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps: []
  build-production:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true
    permissions:
      contents: read
    needs: [verify]
    runs-on: ubuntu-latest
    steps: []
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true
    permissions:
      contents: read
      actions: read
    needs: [verify, build-production]
    environment: production
    runs-on: ubuntu-latest
    steps: []
  rogue:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - run: |
          echo secrets.PRODUCTION_JWT_PRIVATE_KEY
`
  const violations = inspectWorkflowPolicy('ci.yml', source)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /rogue.*production capability/)
})

test('rejects id-token permission and duplicate YAML keys', () => {
  const source = `
name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  verify:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps: []
  build-production:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true
    permissions:
      contents: read
    needs: [verify]
    runs-on: ubuntu-latest
    steps: []
  deploy:
    permissions:
      contents: read
      id-token: write
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true
    needs: [verify, build-production]
    environment: production
    steps: []
`
  assert.match(inspectWorkflowPolicy('ci.yml', source).join('\n'), /id-token: write/)
  assert.throws(
    () =>
      parseGithubWorkflow(`
jobs:
  deploy: {}
  deploy: {}
`),
    /duplicate YAML mapping key/,
  )
})

test('preserves the literal GitHub `on` mapping key instead of YAML 1.1 boolean coercion', () => {
  const workflow = parseGithubWorkflow(`
name: CI
on:
  push:
    branches: [main]
  workflow_dispatch: {}
jobs: {}
`)
  assert.deepEqual(workflow.on, {
    push: { branches: ['main'] },
    workflow_dispatch: {},
  })
})

test('fails closed on explicit YAML tags and multiple documents', () => {
  assert.throws(() => parseGithubWorkflow('jobs: !ruby/object {}\n'), /explicit YAML tags/)
  assert.throws(() => parseGithubWorkflow('jobs: {}\n---\njobs: {}\n'), /multiple YAML documents/)
})

test('requires the exact protected-main trigger and credentialed job topology', () => {
  const source = `
name: CI
on:
  push:
    branches: [feature]
  pull_request:
  workflow_dispatch:
jobs:
  verify:
    permissions: {contents: read}
    runs-on: ubuntu-latest
    steps: []
  build-production:
    if: true
    permissions: {contents: read}
    needs: [verify]
    runs-on: ubuntu-latest
    steps: []
  deploy:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    permissions: {contents: read, actions: read}
    needs: [verify, build-production]
    environment: production
    runs-on: ubuntu-latest
    steps: []
`
  const violations = inspectWorkflowPolicy('ci.yml', source).join('\n')
  assert.match(violations, /push\.branches must be exactly \[main\]/)
  assert.match(violations, /build-production must require the protected main push condition/)
  assert.match(violations, /deploy must require the protected main push condition/)
})

const nativeService = {
  directory: 'booking',
  package: '@app/booking',
}

function nativeWorkflow(overrides = '') {
  return `
name: Booking native
on:
  workflow_dispatch: {}
permissions:
  contents: read
env:
  ANDROID_PLATFORM_API: 35
  ANDROID_NDK_VERSION: 27.2.12479018
  XCODEGEN_VERSION: 2.46.0
jobs:
  build:
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - run: node scripts/check-tauri-boundary.mjs
      - run: pnpm --filter @app/booking run build:tauri
      - run: node scripts/check-tauri-artifact.mjs services/booking/src-tauri/target
${overrides}`
}

test('native workflow policy validates actual trigger, job, step, and pin nodes', () => {
  assert.deepEqual(
    inspectNativeWorkflowPolicy('.github/workflows/booking.yml', nativeWorkflow(), nativeService),
    [],
  )
  for (const trigger of ['pull_request_target', 'workflow_run', 'issue_comment']) {
    const source = nativeWorkflow().replace(
      '  workflow_dispatch: {}',
      `  workflow_dispatch: {}\n  ${trigger}: {}`,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', source, nativeService).join(
        '\n',
      ),
      /only workflow_dispatch/,
    )
  }
  assert.match(
    inspectNativeWorkflowPolicy(
      '.github/workflows/booking.yml',
      nativeWorkflow().replace('on:\n  workflow_dispatch: {}', 'on: [workflow_dispatch]'),
      nativeService,
    ).join('\n'),
    /only workflow_dispatch/,
  )
})

test('native workflow policy rejects comments, block-scalar echoes, missing runner, and unpinned uses', () => {
  const spoofed = nativeWorkflow()
    .replace('    runs-on: ubuntu-24.04\n', '')
    .replace(
      '      - run: node scripts/check-tauri-boundary.mjs',
      '      # node scripts/check-tauri-boundary.mjs\n      - run: echo "node scripts/check-tauri-boundary.mjs"',
    )
    .replace(
      '      - run: node scripts/check-tauri-artifact.mjs services/booking/src-tauri/target',
      '      - run: |\n          echo "node scripts/check-tauri-artifact.mjs services/booking/src-tauri/target"',
    )
    .replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@main')
  const violations = inspectNativeWorkflowPolicy(
    '.github/workflows/booking.yml',
    spoofed,
    nativeService,
  ).join('\n')
  assert.match(violations, /build.*runs-on/)
  assert.match(violations, /boundary checker/)
  assert.match(violations, /artifact checker/)
  assert.match(violations, /full commit SHA/)
})

test('native workflow policy rejects Cloudflare capability in actual nodes and wrong service identity', () => {
  const unsafe = nativeWorkflow(`      - run: pnpm --filter @app/rogue run build:tauri
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      - uses: cloudflare/wrangler-action@1234567890123456789012345678901234567890
`)
  const withOidc = unsafe.replace(
    'permissions:\n  contents: read',
    'permissions:\n  contents: read\n  id-token: write',
  )
  const violations = inspectNativeWorkflowPolicy(
    '.github/workflows/booking.yml',
    withOidc,
    nativeService,
  ).join('\n')
  assert.match(violations, /Cloudflare credential or production capability/)
  assert.match(violations, /must build only @app\/booking/)
})
