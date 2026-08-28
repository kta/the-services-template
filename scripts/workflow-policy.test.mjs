import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { inspectWorkflowPolicy, parseGithubWorkflow } from './workflow-policy.mjs'

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
