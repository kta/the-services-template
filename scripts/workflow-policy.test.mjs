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

test('non-catalog workflows cannot execute direct native build commands', () => {
  const source = `
on: {workflow_dispatch: {}}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: false && pnpm --filter @app/booking run build:tauri
`
  assert.match(
    inspectWorkflowPolicy('orphan.yml', source).join('\n'),
    /direct native commands are forbidden.*native-workflow\.mjs/i,
  )
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
  assert.throws(() => parseGithubWorkflow('!unsafe jobs: {}\n'), /explicit YAML tags/)
  assert.throws(() => parseGithubWorkflow('jobs: {}\n---\njobs: {}\n'), /multiple YAML documents/)
})

function deeplyNestedWorkflow(depth) {
  let source = ''
  for (let index = 0; index < depth; index += 1) {
    source += `${'  '.repeat(index)}level_${index}:\n`
  }
  return `${source}${'  '.repeat(depth)}value: true\n`
}

function wideWorkflow(width) {
  return `${Array.from({ length: width }, (_, index) => `key_${index}: true`).join('\n')}\n`
}

test('enforces safe YAML depth, mapping width, and total node limits at their boundaries', () => {
  assert.doesNotThrow(() => parseGithubWorkflow(deeplyNestedWorkflow(63)))
  assert.throws(() => parseGithubWorkflow(deeplyNestedWorkflow(64)), /maximum YAML depth/i)

  assert.doesNotThrow(() => parseGithubWorkflow(wideWorkflow(2_048)))
  assert.throws(() => parseGithubWorkflow(wideWorkflow(2_049)), /maximum YAML mapping width/i)

  const nodeHeavy = `jobs:\n  values:\n${Array.from(
    { length: 10_000 },
    (_, index) => `    - value_${index}`,
  ).join('\n')}\n`
  assert.throws(() => parseGithubWorkflow(nodeHeavy), /maximum YAML node count/i)
})

test('bounds the Ruby parser subprocess and normalizes timeout, buffer, and signal failures', () => {
  let spawnOptions
  const successfulSpawn = (_command, _args, options) => {
    spawnOptions = options
    return { error: undefined, signal: null, status: 0, stderr: '', stdout: '{"jobs":{}}\n' }
  }
  assert.deepEqual(parseGithubWorkflow('jobs: {}\n', { spawn: successfulSpawn }), { jobs: {} })
  assert.equal(spawnOptions.timeout, 3_000)
  assert.equal(spawnOptions.killSignal, 'SIGKILL')
  assert.equal(spawnOptions.maxBuffer, 2 * 1024 * 1024)

  for (const [result, diagnostic] of [
    [
      {
        error: Object.assign(new Error('spawnSync ruby ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        signal: 'SIGKILL',
        status: null,
        stderr: '',
        stdout: '',
      },
      /YAML parser timed out/i,
    ],
    [
      {
        error: Object.assign(new Error('spawnSync ruby ENOBUFS'), { code: 'ENOBUFS' }),
        signal: null,
        status: null,
        stderr: '',
        stdout: '',
      },
      /YAML parser output exceeded/i,
    ],
    [
      { error: undefined, signal: 'SIGTERM', status: null, stderr: '', stdout: '' },
      /YAML parser terminated by signal SIGTERM/i,
    ],
  ]) {
    assert.throws(() => parseGithubWorkflow('jobs: {}\n', { spawn: () => result }), diagnostic)
  }
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
  NODE_VERSION: 22
  ANDROID_PLATFORM_API: 35
  ANDROID_NDK_VERSION: 27.2.12479018
  XCODEGEN_VERSION: 2.46.0
jobs:
  macos-universal:
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true
    runs-on: macos-15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - name: Check native security boundary
        run: node scripts/native-workflow.mjs booking boundary
      - name: Build unsigned universal debug app
        run: node scripts/native-workflow.mjs booking build-macos
      - name: Scan macOS artifact for secrets
        run: node scripts/native-workflow.mjs booking verify-macos
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
    .replace('    runs-on: macos-15\n', '')
    .replace(
      '        run: node scripts/native-workflow.mjs booking boundary',
      '        # node scripts/native-workflow.mjs booking boundary\n        run: echo "node scripts/native-workflow.mjs booking boundary"',
    )
    .replace(
      '        run: node scripts/native-workflow.mjs booking verify-macos',
      '        run: |\n          echo "node scripts/native-workflow.mjs booking verify-macos"',
    )
    .replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@main')
  const violations = inspectNativeWorkflowPolicy(
    '.github/workflows/booking.yml',
    spoofed,
    nativeService,
  ).join('\n')
  assert.match(violations, /macos-universal.*runs-on/)
  assert.match(violations, /exact native wrapper sequence/)
  assert.match(violations, /full commit SHA/)
})

test('native workflow policy rejects Cloudflare capability in actual nodes and wrong service identity', () => {
  const unsafe = nativeWorkflow(`      - run: node scripts/native-workflow.mjs rogue build-macos
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
  assert.match(violations, /exact native wrapper sequence/)
})

test('native workflow effective permissions are exactly contents read and jobs hold no credentials', () => {
  for (const [mutation, expected] of [
    [
      (source) => source.replace('permissions:\n  contents: read', 'permissions: write-all'),
      /effective permissions must be exactly contents: read/i,
    ],
    [
      (source) => source.replace('  contents: read', '  contents: write'),
      /effective permissions must be exactly contents: read/i,
    ],
    [
      (source) =>
        source.replace(
          '    runs-on: macos-15',
          '    permissions: write-all\n    runs-on: macos-15',
        ),
      /effective permissions must be exactly contents: read/i,
    ],
    [
      (source) =>
        source.replace(
          '    runs-on: macos-15',
          '    environment: production\n    runs-on: macos-15',
        ),
      /must not declare an environment/i,
    ],
    [
      (source) =>
        source.replace(
          '    runs-on: macos-15',
          '    container:\n      image: node:22\n      credentials: {username: ci, password: token}\n    runs-on: macos-15',
        ),
      /container credentials/i,
    ],
    [
      (source) =>
        source.replace(
          '    runs-on: macos-15',
          '    services:\n      registry:\n        image: example.invalid/image\n        credentials: {username: ci, password: token}\n    runs-on: macos-15',
        ),
      /service credentials/i,
    ],
  ]) {
    assert.match(
      inspectNativeWorkflowPolicy(
        '.github/workflows/booking.yml',
        mutation(nativeWorkflow()),
        nativeService,
      ).join('\n'),
      expected,
    )
  }
})

test('native workflow rejects every secrets context spelling in recursive env and with nodes', () => {
  const githubExpression = '$' + '{{'
  for (const expression of [
    `${githubExpression} secrets.NATIVE_TOKEN }}`,
    `${githubExpression} secrets['NATIVE_TOKEN'] }}`,
    `${githubExpression} toJSON(secrets) }}`,
  ]) {
    const withSecret = nativeWorkflow().replace(
      '          persist-credentials: false',
      `          persist-credentials: false\n          token: "${expression}"`,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', withSecret, nativeService).join(
        '\n',
      ),
      /secrets context/i,
    )
    const secretKey = nativeWorkflow().replace(
      '          persist-credentials: false',
      `          persist-credentials: false\n          "${expression}": harmless`,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', secretKey, nativeService).join(
        '\n',
      ),
      /secrets context/i,
    )
    const nestedEnv = nativeWorkflow().replace(
      '    steps:',
      `    env:\n      SAFE:\n        nested: "${expression}"\n    steps:`,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', nestedEnv, nativeService).join(
        '\n',
      ),
      /secrets context/i,
    )
  }
})

test('native workflow forbids pin shadowing and validates the build step effective pins', () => {
  for (const mutation of [
    (source) =>
      source.replace('    steps:', '    env:\n      ANDROID_PLATFORM_API: 34\n    steps:'),
    (source) =>
      source.replace(
        '      - name: Build unsigned universal debug app',
        '      - name: Build unsigned universal debug app\n        env:\n          XCODEGEN_VERSION: 0.0.0',
      ),
    (source) =>
      source.replace(
        '        run: node scripts/native-workflow.mjs booking build-macos',
        '        env:\n          ANDROID_NDK_VERSION: null\n        run: node scripts/native-workflow.mjs booking build-macos',
      ),
  ]) {
    const diagnostic = inspectNativeWorkflowPolicy(
      '.github/workflows/booking.yml',
      mutation(nativeWorkflow()),
      nativeService,
    ).join('\n')
    assert.match(diagnostic, /must not shadow platform pin|build step effective pin/i)
  }
})

test('native workflow accepts only the exact wrapper argv, order, and root working directory', () => {
  for (const [replacement, expected] of [
    ['node scripts/native-workflow.mjs booking boundary || true', /exact native wrapper sequence/i],
    [
      'false && node scripts/native-workflow.mjs booking boundary',
      /exact native wrapper sequence/i,
    ],
    [
      "printf '%s\\n' 'node scripts/native-workflow.mjs booking boundary'",
      /exact native wrapper sequence/i,
    ],
    ['node scripts/native-workflow.mjs "booking" boundary', /exact native wrapper sequence/i],
    [
      'node scripts/native-workflow.mjs booking/../rogue boundary',
      /exact native wrapper sequence/i,
    ],
  ]) {
    const source = nativeWorkflow().replace(
      'node scripts/native-workflow.mjs booking boundary',
      replacement,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', source, nativeService).join(
        '\n',
      ),
      expected,
    )
  }

  const wrongCwd = nativeWorkflow().replace(
    '        run: node scripts/native-workflow.mjs booking build-macos',
    '        working-directory: services/booking\n        run: node scripts/native-workflow.mjs booking build-macos',
  )
  assert.match(
    inspectNativeWorkflowPolicy('.github/workflows/booking.yml', wrongCwd, nativeService).join(
      '\n',
    ),
    /native wrapper.*working-directory/i,
  )

  const ignoredFailure = nativeWorkflow().replace(
    '        run: node scripts/native-workflow.mjs booking build-macos',
    `        continue-on-error: ${'$' + '{{'} true }}\n        run: node scripts/native-workflow.mjs booking build-macos`,
  )
  assert.match(
    inspectNativeWorkflowPolicy(
      '.github/workflows/booking.yml',
      ignoredFailure,
      nativeService,
    ).join('\n'),
    /native wrapper.*without env\/shell\/if overrides/i,
  )

  const injectedNodeOptions = nativeWorkflow().replace(
    '        run: node scripts/native-workflow.mjs booking build-macos',
    '        env:\n          NODE_OPTIONS: --require ./rogue.cjs\n        run: node scripts/native-workflow.mjs booking build-macos',
  )
  assert.match(
    inspectNativeWorkflowPolicy(
      '.github/workflows/booking.yml',
      injectedNodeOptions,
      nativeService,
    ).join('\n'),
    /native wrapper.*without env\/shell\/if overrides/i,
  )

  const reordered = nativeWorkflow()
    .replace('booking build-macos', 'booking TEMP')
    .replace('booking verify-macos', 'booking build-macos')
    .replace('booking TEMP', 'booking verify-macos')
  assert.match(
    inspectNativeWorkflowPolicy('.github/workflows/booking.yml', reordered, nativeService).join(
      '\n',
    ),
    /exact native wrapper sequence/i,
  )
})

test('native workflow rejects inherited execution injection and custom default shells', () => {
  const mutations = [
    (source) =>
      source.replace(
        '  XCODEGEN_VERSION: 2.46.0',
        '  XCODEGEN_VERSION: 2.46.0\n  NODE_OPTIONS: --require=./rogue.cjs',
      ),
    (source) =>
      source.replace(
        '    runs-on: macos-15',
        '    env:\n      NODE_PATH: ./rogue-modules\n      PATH: ./rogue-bin\n      PNPM_HOME: ./rogue-pnpm\n    runs-on: macos-15',
      ),
    (source) => source.replace('jobs:', 'defaults:\n  run:\n    shell: ./rogue-shell {0}\njobs:'),
    (source) =>
      source.replace(
        '    runs-on: macos-15',
        '    defaults:\n      run:\n        shell: ./rogue-shell {0}\n    runs-on: macos-15',
      ),
  ]

  for (const mutate of mutations) {
    assert.match(
      inspectNativeWorkflowPolicy(
        '.github/workflows/booking.yml',
        mutate(nativeWorkflow()),
        nativeService,
      ).join('\n'),
      /execution env|exact workflow env|defaults.*shell|NODE_OPTIONS|NODE_PATH|PATH|PNPM_HOME/i,
    )
  }
})

test('registered native workflow rejects dynamic, quoted, and additional wrapper references', () => {
  for (const invocation of [
    'node scripts/native-workflow.mjs booking "$ACTION"',
    'node "scripts/native-workflow.mjs" booking build-macos',
    'node scripts/native-workflow.mjs booking build-macos',
  ]) {
    const source = nativeWorkflow(
      `      - name: Alternate native build\n        run: ${invocation}\n`,
    )
    assert.match(
      inspectNativeWorkflowPolicy('.github/workflows/booking.yml', source, nativeService).join(
        '\n',
      ),
      /unreviewed native wrapper reference|exact native wrapper sequence/i,
    )
  }
})
