import { spawnSync } from 'node:child_process'

const MAX_WORKFLOW_BYTES = 1024 * 1024
const MAX_YAML_NODES = 10_000
const MAX_YAML_DEPTH = 64
const MAX_YAML_MAPPING_WIDTH = 2_048
const YAML_PARSER_TIMEOUT_MS = 3_000
const PRODUCTION_WORKFLOWS = new Map([
  ['ci.yml', 'deploy'],
  ['production-bootstrap.yml', 'bootstrap'],
])
const PRODUCTION_MARKERS =
  /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_|environment:\s*production|id-token:\s*write|cloudflare\/wrangler-action|\bwrangler\s+(?:deploy|d1|r2)\b/
const PROTECTED_MAIN_PUSH =
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true"
const PROTECTED_MAIN_DISPATCH =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected == true"
const NATIVE_PLATFORM_PINS = {
  NODE_VERSION: 22,
  ANDROID_PLATFORM_API: 35,
  ANDROID_NDK_VERSION: '27.2.12479018',
  XCODEGEN_VERSION: '2.46.0',
}
const GITHUB_EXPRESSION = '$' + '{{'
const TRUSTED_NATIVE_NODE = `${GITHUB_EXPRESSION} steps.trusted-node.outputs.path }}`
const CHECKOUT_ACTION = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const PNPM_ACTION = 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86'
const NODE_ACTION = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
const JAVA_ACTION = 'actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3'
const ANDROID_ACTION = 'android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407'
const UPLOAD_ACTION = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
const CAPTURE_TRUSTED_NODE_RUN = `set -euo pipefail
node_path="$(node -p 'require("node:fs").realpathSync(process.execPath)')"
case "$node_path" in
  /*) ;;
  *) echo "Node did not resolve to an absolute path" >&2; exit 1 ;;
esac
test -x "$node_path"
case "$node_path" in
  "$GITHUB_WORKSPACE"/*) echo "Node resolved inside the checkout" >&2; exit 1 ;;
esac
printf 'path=%s\\n' "$node_path" >> "$GITHUB_OUTPUT"
`

// Ruby's Psych parser is available on the GitHub-hosted runner and parses the
// complete YAML object, including block scalars. We reject duplicate mapping
// keys before converting the syntax tree so a later duplicate cannot hide a
// production job from the policy checker. Do not use YAML.safe_load here:
// YAML 1.1 treats GitHub's unquoted `on` key as the boolean `true`.
const RUBY_YAML_TO_JSON = `
require 'yaml'
require 'json'
require 'set'

MAX_YAML_NODES = ${MAX_YAML_NODES}
MAX_YAML_DEPTH = ${MAX_YAML_DEPTH}
MAX_YAML_MAPPING_WIDTH = ${MAX_YAML_MAPPING_WIDTH}

def reject_unsafe_nodes(node, state, depth = 0)
  state[:nodes] += 1
  raise 'maximum YAML node count exceeded' if state[:nodes] > MAX_YAML_NODES
  if node.respond_to?(:tag) && node.tag
    raise "explicit YAML tags are not allowed: #{node.tag}"
  end
  case node
  when Psych::Nodes::Alias
    raise 'YAML aliases are not allowed'
  when Psych::Nodes::Mapping
    collection_depth = depth + 1
    raise 'maximum YAML depth exceeded' if collection_depth > MAX_YAML_DEPTH
    width = node.children.length / 2
    raise 'maximum YAML mapping width exceeded' if width > MAX_YAML_MAPPING_WIDTH
    keys = Set.new
    node.children.each_slice(2) do |key, value|
      unless key.is_a?(Psych::Nodes::Scalar)
        raise 'YAML mapping keys must be scalars'
      end
      reject_unsafe_nodes(key, state, collection_depth)
      if keys.include?(key.value)
        raise "duplicate YAML mapping key: #{key.value}"
      end
      keys.add(key.value)
      reject_unsafe_nodes(value, state, collection_depth)
    end
  when Psych::Nodes::Sequence
    collection_depth = depth + 1
    raise 'maximum YAML depth exceeded' if collection_depth > MAX_YAML_DEPTH
    node.children.each { |child| reject_unsafe_nodes(child, state, collection_depth) }
  when Psych::Nodes::Document
    reject_unsafe_nodes(node.root, state, depth)
  end
end

def scalar_value(node)
  return node.value unless node.style == Psych::Nodes::Scalar::PLAIN
  case node.value
  when 'null', 'Null', 'NULL', '~' then nil
  when 'true', 'True', 'TRUE' then true
  when 'false', 'False', 'FALSE' then false
  when /^[-+]?\\d+$/ then Integer(node.value, 10)
  when /^[-+]?(?:\\d+\\.\\d*|\\d*\\.\\d+)(?:[eE][-+]?\\d+)?$/ then Float(node.value)
  else node.value
  end
end

def to_value(node)
  case node
  when Psych::Nodes::Document then to_value(node.root)
  when Psych::Nodes::Scalar then scalar_value(node)
  when Psych::Nodes::Sequence then node.children.map { |child| to_value(child) }
  when Psych::Nodes::Mapping
    result = {}
    node.children.each_slice(2) do |key, value|
      result[key.value] = to_value(value)
    end
    result
  else
    raise 'unsupported YAML node'
  end
end

source = STDIN.read
stream = Psych.parse_stream(source)
documents = stream.children
raise 'multiple YAML documents are not allowed' unless documents.length == 1
reject_unsafe_nodes(documents.first, { nodes: 0 })
value = to_value(documents.first)
puts JSON.generate(value)
`

export function parseGithubWorkflow(source, options = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_WORKFLOW_BYTES) {
    throw new Error('workflow YAML is missing or too large')
  }
  const spawn = options.spawn ?? spawnSync
  const result = spawn('ruby', ['-e', RUBY_YAML_TO_JSON], {
    input: source,
    encoding: 'utf8',
    maxBuffer: MAX_WORKFLOW_BYTES * 2,
    timeout: YAML_PARSER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.error?.code === 'ETIMEDOUT') throw new Error('workflow YAML parser timed out')
  if (result.error?.code === 'ENOBUFS') {
    throw new Error('workflow YAML parser output exceeded maximum buffer')
  }
  if (result.error) throw new Error('workflow YAML parser failed to start')
  if (result.signal) {
    throw new Error(`workflow YAML parser terminated by signal ${result.signal}`)
  }
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim().split('\n')[0] || 'Ruby YAML parser failed'
    throw new Error(diagnostic)
  }
  const value = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow YAML root must be a mapping')
  }
  return value
}

function objectEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
}

function hasProductionMarker(value) {
  return PRODUCTION_MARKERS.test(JSON.stringify(value))
}

function isMapping(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function firstStructuralDifference(actual, expected, path = 'job') {
  if (Object.is(actual, expected)) return undefined
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return `${path} type`
    if (actual.length !== expected.length) {
      return `${path} length ${actual.length} (expected ${expected.length})`
    }
    for (let index = 0; index < actual.length; index += 1) {
      const difference = firstStructuralDifference(
        actual[index],
        expected[index],
        `${path}[${index}]`,
      )
      if (difference) return difference
    }
    return undefined
  }
  if (isMapping(actual) || isMapping(expected)) {
    if (!isMapping(actual) || !isMapping(expected)) return `${path} type`
    const actualKeys = Object.keys(actual).sort()
    const expectedKeys = Object.keys(expected).sort()
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      return `${path} fields ${actualKeys.join(',')} (expected ${expectedKeys.join(',')})`
    }
    for (const key of actualKeys) {
      const difference = firstStructuralDifference(actual[key], expected[key], `${path}.${key}`)
      if (difference) return difference
    }
    return undefined
  }
  return `${path} value ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`
}

const NATIVE_JOB_PROFILES = {
  'macos-universal': [
    ['Check native security boundary', 'boundary'],
    ['Build unsigned universal debug app', 'build-macos'],
    ['Scan macOS artifact for secrets', 'verify-macos'],
  ],
  'ios-simulator': [
    ['Check native security boundary', 'boundary'],
    ['Initialize iOS project', 'init-ios'],
    ['Re-check native security boundary after iOS generation', 'boundary'],
    ['Build unsigned simulator artifact', 'build-ios'],
    ['Scan iOS artifact for secrets', 'verify-ios'],
  ],
  'android-debug-apk': [
    ['Check native security boundary', 'boundary'],
    ['Initialize Android project', 'init-android'],
    ['Re-check native security boundary after Android generation', 'boundary'],
    ['Build debug APK', 'build-android-apk'],
    ['Scan Android APK for secrets', 'verify-android-apk'],
  ],
  'android-debug-aab': [
    ['Check native security boundary', 'boundary'],
    ['Initialize Android project', 'init-android'],
    ['Re-check native security boundary after Android generation', 'boundary'],
    ['Build debug AAB', 'build-android-aab'],
    ['Scan Android AAB for secrets', 'verify-android-aab'],
  ],
}

function nativeWrapperRun(directory, action) {
  return `${TRUSTED_NATIVE_NODE} scripts/native-workflow.mjs ${directory} ${action}`
}

function commonNativeSteps() {
  return [
    { uses: CHECKOUT_ACTION, with: { 'persist-credentials': false } },
    { uses: PNPM_ACTION },
    {
      uses: NODE_ACTION,
      with: { 'node-version': `${GITHUB_EXPRESSION} env.NODE_VERSION }}`, cache: 'pnpm' },
    },
    {
      name: 'Capture trusted absolute Node path',
      id: 'trusted-node',
      shell: 'bash',
      run: CAPTURE_TRUSTED_NODE_RUN,
    },
    { run: 'pnpm install --frozen-lockfile --ignore-scripts' },
  ]
}

function androidNativeSetupSteps() {
  return [
    {
      uses: JAVA_ACTION,
      with: { distribution: 'temurin', 'java-version': '17' },
    },
    { uses: ANDROID_ACTION },
  ]
}

function reviewedNativeJobs(directory) {
  const artifactPrefix = directory.replaceAll('_', '-')
  const protectedMain = PROTECTED_MAIN_DISPATCH
  const boundary = {
    name: 'Check native security boundary',
    run: nativeWrapperRun(directory, 'boundary'),
  }
  const rust = {
    name: 'Check pinned Rust toolchain',
    run: `test "$(rustc --version | awk '{print $2}')" = "1.88.0"`,
  }
  const androidPrerequisites = {
    name: 'Install Android SDK prerequisites',
    shell: 'bash',
    run: `yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "platforms;android-\${ANDROID_PLATFORM_API}" "ndk;\${ANDROID_NDK_VERSION}"
`,
  }
  const androidAlignment = {
    name: 'Align NDK with generated Gradle project',
    shell: 'bash',
    run: `compile_sdk="$(rg -o 'compileSdk(Version)?[[:space:]]*=[[:space:]]*[0-9]+' services/${directory}/src-tauri/gen/android -g '*.gradle*' | sed -E 's/.*[^0-9]([0-9]+)$/\\1/' | head -1)"
test "$compile_sdk" = "$ANDROID_PLATFORM_API"
build_tools="$(rg -o 'buildToolsVersion[[:space:]]*=[[:space:]]*"[^"]+"' services/${directory}/src-tauri/gen/android -g '*.gradle*' | sed -E 's/.*"([^"]+)".*/\\1/' | head -1)"
if [[ -n "$build_tools" ]]; then
  sdkmanager "build-tools;$build_tools"
fi
ndk_version="$(rg -o 'ndkVersion[[:space:]]*=[[:space:]]*"[^"]+"' services/${directory}/src-tauri/gen/android -g '*.gradle*' | sed -E 's/.*"([^"]+)".*/\\1/' | head -1)"
test "$ndk_version" = "$ANDROID_NDK_VERSION"
`,
  }
  const androidBase = () => [
    ...commonNativeSteps().slice(0, 3),
    ...androidNativeSetupSteps(),
    ...commonNativeSteps().slice(3),
    boundary,
    rust,
    androidPrerequisites,
    {
      name: 'Install Android Rust target',
      run: 'rustup target add aarch64-linux-android',
    },
    {
      name: 'Initialize Android project',
      run: nativeWrapperRun(directory, 'init-android'),
    },
    {
      name: 'Re-check native security boundary after Android generation',
      run: nativeWrapperRun(directory, 'boundary'),
    },
    androidAlignment,
  ]

  return {
    'macos-universal': {
      name: `${directory} macOS universal app bundle`,
      if: protectedMain,
      'runs-on': 'macos-15',
      steps: [
        ...commonNativeSteps(),
        boundary,
        rust,
        {
          name: 'Install universal Rust targets',
          run: 'rustup target add aarch64-apple-darwin x86_64-apple-darwin',
        },
        {
          name: 'Check Apple build tools',
          run: 'xcodebuild -version\npod --version\n',
        },
        {
          name: 'Build unsigned universal debug app',
          run: nativeWrapperRun(directory, 'build-macos'),
        },
        {
          name: 'Scan macOS artifact for secrets',
          run: nativeWrapperRun(directory, 'verify-macos'),
        },
        {
          uses: UPLOAD_ACTION,
          with: {
            name: `${artifactPrefix}-macos-universal-debug`,
            path: `services/${directory}/src-tauri/target/universal-apple-darwin/debug/bundle/macos/*.app`,
            'if-no-files-found': 'error',
            'retention-days': 7,
          },
        },
      ],
    },
    'ios-simulator': {
      name: `${directory} iOS simulator app`,
      if: protectedMain,
      'runs-on': 'macos-15',
      steps: [
        ...commonNativeSteps(),
        boundary,
        rust,
        {
          name: 'Install iOS simulator Rust target',
          run: 'rustup target add aarch64-apple-ios-sim',
        },
        { name: 'Install XcodeGen', run: 'brew install xcodegen' },
        {
          name: 'Check Apple build tools',
          run: `xcodebuild -version
pod --version
test "$(xcodegen --version)" = "Version: \${XCODEGEN_VERSION}"
`,
        },
        {
          name: 'Initialize iOS project',
          run: nativeWrapperRun(directory, 'init-ios'),
        },
        {
          name: 'Re-check native security boundary after iOS generation',
          run: nativeWrapperRun(directory, 'boundary'),
        },
        {
          name: 'Build unsigned simulator artifact',
          run: nativeWrapperRun(directory, 'build-ios'),
        },
        {
          name: 'Scan iOS artifact for secrets',
          run: nativeWrapperRun(directory, 'verify-ios'),
        },
        {
          uses: UPLOAD_ACTION,
          with: {
            name: `${artifactPrefix}-ios-simulator`,
            path: `services/${directory}/src-tauri/gen/apple/build`,
            'if-no-files-found': 'error',
            'retention-days': 7,
          },
        },
      ],
    },
    'android-debug-apk': {
      name: `${directory} Android debug APK`,
      if: protectedMain,
      'runs-on': 'ubuntu-24.04',
      steps: [
        ...androidBase(),
        {
          name: 'Build debug APK',
          run: nativeWrapperRun(directory, 'build-android-apk'),
        },
        {
          name: 'Scan Android APK for secrets',
          run: nativeWrapperRun(directory, 'verify-android-apk'),
        },
        {
          uses: UPLOAD_ACTION,
          with: {
            name: `${artifactPrefix}-android-debug-apk`,
            path: `services/${directory}/src-tauri/gen/android/app/build/outputs/apk/**/debug/*.apk`,
            'if-no-files-found': 'error',
            'retention-days': 7,
          },
        },
      ],
    },
    'android-debug-aab': {
      name: `${directory} Android debug AAB`,
      if: protectedMain,
      'runs-on': 'ubuntu-24.04',
      steps: [
        ...androidBase(),
        {
          name: 'Build debug AAB',
          run: nativeWrapperRun(directory, 'build-android-aab'),
        },
        {
          name: 'Scan Android AAB for secrets',
          run: nativeWrapperRun(directory, 'verify-android-aab'),
        },
        {
          uses: UPLOAD_ACTION,
          with: {
            name: `${artifactPrefix}-android-debug-aab`,
            path: `services/${directory}/src-tauri/gen/android/app/build/outputs/bundle/**/debug/*.aab`,
            'if-no-files-found': 'error',
            'retention-days': 7,
          },
        },
      ],
    },
  }
}

function containsSecretsContext(value) {
  if (typeof value === 'string') {
    return /\$\{\{[\s\S]*?\bsecrets\b[\s\S]*?\}\}/i.test(value)
  }
  if (Array.isArray(value)) return value.some(containsSecretsContext)
  return (
    isMapping(value) &&
    Object.entries(value).some(
      ([name, child]) => containsSecretsContext(name) || containsSecretsContext(child),
    )
  )
}

function containsCloudflareCapability(value) {
  if (typeof value === 'string') {
    return /CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|secrets\.PRODUCTION_/i.test(value)
  }
  if (Array.isArray(value)) return value.some(containsCloudflareCapability)
  if (!isMapping(value)) return false
  return Object.entries(value).some(
    ([name, child]) =>
      /^CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)$/i.test(name) ||
      containsCloudflareCapability(name) ||
      containsCloudflareCapability(child),
  )
}

function exactPermissionsValue(value, expected) {
  if (!isMapping(value)) return false
  const actual = Object.keys(value).sort()
  const keys = Object.keys(expected).sort()
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index] && value[key] === expected[key])
  )
}

function nativeWrapperCommand(step) {
  if (typeof step?.run !== 'string') return undefined
  const match = step.run
    .trim()
    .match(
      /^\$\{\{ steps\.trusted-node\.outputs\.path \}\} scripts\/native-workflow\.mjs ([a-z][a-z0-9_]{0,62}) ([a-z][a-z0-9-]*)$/,
    )
  return match ? { directory: match[1], action: match[2] } : undefined
}

function containsNativeWrapperReference(step) {
  return typeof step?.run === 'string' && step.run.includes('scripts/native-workflow.mjs')
}

const EXECUTION_INJECTION_ENV =
  /^(?:NODE_OPTIONS|NODE_PATH|PATH|PNPM_HOME|PNPM_[A-Z0-9_]*|npm_config_.+)$/i

function executionInjectionNames(value) {
  return Object.keys(isMapping(value) ? value : {}).filter((name) =>
    EXECUTION_INJECTION_ENV.test(name),
  )
}

function containsDirectNativeCommand(step) {
  return (
    typeof step?.run === 'string' &&
    /\b(?:build:tauri|tauri\s+(?:build|ios\s+(?:init|build)|android\s+(?:init|build)))\b/.test(
      step.run,
    )
  )
}

function writesGithubExecutionState(step) {
  return typeof step?.run === 'string' && /\bGITHUB_(?:PATH|ENV)\b/.test(step.run)
}

function nativeScriptEnvironment(value) {
  return Object.values(isMapping(value) ? value : {}).some(
    (entry) =>
      typeof entry === 'string' && /^(?:build:tauri|tauri(?::[a-z0-9_-]+)?)$/i.test(entry.trim()),
  )
}

function escapesRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dispatchesIndirectNativePackageScript(step, effectiveEnv, nativeServices) {
  if (typeof step?.run !== 'string' || !nativeScriptEnvironment(effectiveEnv)) return false
  if (!/\bpnpm\b/.test(step.run)) return false
  return nativeServices.some(({ directory, package: packageName }) => {
    const packagePattern = new RegExp(
      `(?:${escapesRegex(packageName)}|services/${escapesRegex(directory)})`,
    )
    return packagePattern.test(step.run) || packagePattern.test(JSON.stringify(effectiveEnv))
  })
}

const REVIEWED_NATIVE_PACKAGE_SCRIPTS = Object.freeze({
  'build:tauri': 'node ../../scripts/native-workflow.mjs package build',
  tauri: 'node ../../scripts/native-workflow.mjs package tauri',
})
const REVIEWED_OPTIONAL_NATIVE_PACKAGE_SCRIPTS = Object.freeze({
  'prepare:tauri:android': 'node ../../scripts/prepare-tauri-android.mjs',
})

function containsNativePackageCommand(value) {
  return (
    typeof value === 'string' &&
    (/(?:^|[\s;&|])(?:\.\/)?(?:node_modules[\\/]\.bin[\\/])?tauri(?:[\s;&|]|$)/i.test(value) ||
      /\bbuild\s*:\s*tauri\b/i.test(value) ||
      /scripts[\\/]native-workflow\.mjs/i.test(value))
  )
}

export function inspectNativePackagePolicy(directory, packageJson) {
  const violations = []
  const scripts = isMapping(packageJson?.scripts) ? packageJson.scripts : {}
  for (const [name, expected] of Object.entries(REVIEWED_NATIVE_PACKAGE_SCRIPTS)) {
    if (scripts[name] !== expected) {
      violations.push(
        `${directory}: native package script ${name} must use the exact reviewed wrapper`,
      )
    }
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (Object.hasOwn(REVIEWED_NATIVE_PACKAGE_SCRIPTS, name)) continue
    if (Object.hasOwn(REVIEWED_OPTIONAL_NATIVE_PACKAGE_SCRIPTS, name)) {
      if (value !== REVIEWED_OPTIONAL_NATIVE_PACKAGE_SCRIPTS[name]) {
        violations.push(
          `${directory}: native package script ${name} must use the exact reviewed wrapper`,
        )
      }
      continue
    }
    if (name.toLowerCase().includes('tauri') || containsNativePackageCommand(value)) {
      violations.push(`${directory}: native package script ${name} is not reviewed`)
    }
  }
  return violations
}

function executableScalarStrings(value, strings = []) {
  if (typeof value === 'string') {
    strings.push(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) executableScalarStrings(entry, strings)
  } else if (isMapping(value)) {
    for (const entry of Object.values(value)) executableScalarStrings(entry, strings)
  }
  return strings
}

function literalExecutionEnvironment(...values) {
  const environment = Object.create(null)
  for (const value of values) {
    for (const [name, entry] of objectEntries(value)) {
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
        environment[name] = String(entry)
      }
    }
  }
  return environment
}

function expandLiteralExecutionValue(value, environment) {
  let expanded = value
  for (let index = 0; index < 8; index += 1) {
    const next = expanded
      .replace(/\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) =>
        Object.hasOwn(environment, name) ? environment[name] : match,
      )
      .replace(
        /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
        (match, braced, plain) => {
          const name = braced ?? plain
          return Object.hasOwn(environment, name) ? environment[name] : match
        },
      )
    if (next === expanded) break
    expanded = next
  }
  return expanded
}

function executableSurfaceContainsNativeDispatch(values, environment) {
  const expanded = values.map((value) => expandLiteralExecutionValue(value, environment))
  const surface = expanded.join('\n')
  const compact = surface.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (compact.includes('scriptsnativeworkflowmjs')) return true
  if (/node_modules[\\/]\.bin[\\/]tauri/i.test(surface)) return true

  const tauriToken = /(?:^|[^A-Za-z0-9_])tauri(?:$|[^A-Za-z0-9_])/i.test(surface)
  const packageScript = /\bbuild\s*:\s*tauri\b/i.test(surface)
  const commandCarrier = /\b(?:pnpm|npm|npx|yarn|bunx?|exec|dlx|command|arguments?)\b/i.test(
    surface,
  )
  const directTauriCommand =
    /(?:^|[\s;&|])(?:\.\/?node_modules[\\/]\.bin[\\/])?tauri\s+(?:build|dev|info|ios|android|init)\b/im.test(
      surface,
    )
  return (packageScript && commandCarrier) || (tauriToken && commandCarrier) || directTauriCommand
}

function nativeStepHasRootExecution(step) {
  return (
    step['working-directory'] === undefined &&
    step.env === undefined &&
    step.shell === undefined &&
    step.if === undefined &&
    step['continue-on-error'] === undefined
  )
}

/**
 * Validate a catalog-owned manual native artifact workflow from parsed YAML
 * nodes. Security-critical commands are accepted only as exact single-line
 * calls to native-workflow.mjs; arbitrary shell text is never command
 * evidence.
 */
export function inspectNativeWorkflowPolicy(workflowPath, source, service) {
  const violations = []
  let workflow
  try {
    workflow = parseGithubWorkflow(source)
  } catch (error) {
    return [
      `${workflowPath}: native workflow is not valid safe YAML: ${error instanceof Error ? error.message : 'parse error'}`,
    ]
  }
  if (
    !isMapping(workflow.on) ||
    Object.keys(workflow.on).length !== 1 ||
    !Object.hasOwn(workflow.on, 'workflow_dispatch')
  ) {
    violations.push(`${workflowPath}: native workflow on must contain only workflow_dispatch`)
  }
  if (!isMapping(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    violations.push(`${workflowPath}: native workflow jobs must be a non-empty mapping`)
    return violations
  }
  if (!exactPermissionsValue(workflow.permissions, { contents: 'read' })) {
    violations.push(
      `${workflowPath}: native workflow effective permissions must be exactly contents: read`,
    )
  }
  if (containsCloudflareCapability(workflow.env) || containsSecretsContext(workflow.env)) {
    violations.push(
      `${workflowPath}: native workflow must not receive a Cloudflare credential or production capability`,
    )
  }
  if (containsSecretsContext(workflow.env)) {
    violations.push(`${workflowPath}: native workflow env must not use the secrets context`)
  }
  if (!exactPermissionsValue(workflow.env, NATIVE_PLATFORM_PINS)) {
    violations.push(
      `${workflowPath}: native workflow must use the exact workflow env schema and platform pins`,
    )
  }
  if (workflow.defaults !== undefined) {
    violations.push(`${workflowPath}: native workflow defaults and custom shells are forbidden`)
  }
  const reviewedJobs = reviewedNativeJobs(service.directory)
  const actualJobNames = Object.keys(workflow.jobs).sort()
  const reviewedJobNames = Object.keys(reviewedJobs).sort()
  const missingJobs = reviewedJobNames.filter((name) => !actualJobNames.includes(name))
  const extraJobs = actualJobNames.filter((name) => !reviewedJobNames.includes(name))
  if (missingJobs.length > 0 || extraJobs.length > 0) {
    const details = [
      missingJobs.length > 0 ? `missing ${missingJobs.join(', ')}` : undefined,
      extraJobs.length > 0 ? `extra ${extraJobs.join(', ')}` : undefined,
    ].filter(Boolean)
    violations.push(
      `${workflowPath}: native workflow job set must match the reviewed jobs (${details.join('; ')})`,
    )
  }
  for (const [name, expected] of Object.entries(NATIVE_PLATFORM_PINS)) {
    if (!isMapping(workflow.env) || String(workflow.env[name]) !== String(expected)) {
      violations.push(`${workflowPath}: native workflow is missing required platform pin ${name}`)
    }
  }

  for (const [jobName, job] of objectEntries(workflow.jobs)) {
    if (!isMapping(job)) {
      violations.push(`${workflowPath}:${jobName} must be a job mapping`)
      continue
    }
    if (typeof job['runs-on'] !== 'string' || job['runs-on'].trim() === '') {
      violations.push(`${workflowPath}:${jobName} must declare runs-on`)
    }
    if (job.if !== PROTECTED_MAIN_DISPATCH) {
      violations.push(`${workflowPath}:${jobName} must require the exact protected main predicate`)
    }
    const effectivePermissions = job.permissions ?? workflow.permissions
    if (!exactPermissionsValue(effectivePermissions, { contents: 'read' })) {
      violations.push(
        `${workflowPath}:${jobName} effective permissions must be exactly contents: read`,
      )
    }
    if (Object.hasOwn(job, 'environment')) {
      violations.push(`${workflowPath}:${jobName} must not declare an environment`)
    }
    if (isMapping(job.container) && job.container.credentials !== undefined) {
      violations.push(`${workflowPath}:${jobName} must not declare container credentials`)
    }
    if (
      objectEntries(job.services).some(([, serviceContainer]) =>
        Object.hasOwn(isMapping(serviceContainer) ? serviceContainer : {}, 'credentials'),
      )
    ) {
      violations.push(`${workflowPath}:${jobName} must not declare service credentials`)
    }
    if (containsCloudflareCapability(job.env) || containsSecretsContext(job.env)) {
      violations.push(
        `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
      )
    }
    if (containsSecretsContext(job.env)) {
      violations.push(`${workflowPath}:${jobName} env must not use the secrets context`)
    }
    if (job.env !== undefined) {
      const injection = executionInjectionNames(job.env)
      violations.push(
        `${workflowPath}:${jobName} job execution env is forbidden${injection.length ? ` (${injection.join(', ')})` : ''}`,
      )
    }
    if (job.defaults !== undefined) {
      violations.push(`${workflowPath}:${jobName} defaults and custom shells are forbidden`)
    }
    for (const pin of Object.keys(NATIVE_PLATFORM_PINS)) {
      if (isMapping(job.env) && Object.hasOwn(job.env, pin)) {
        violations.push(`${workflowPath}:${jobName} must not shadow platform pin ${pin}`)
      }
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      violations.push(`${workflowPath}:${jobName} must declare executable steps`)
      continue
    }
    const wrapperSteps = []
    for (const [index, step] of job.steps.entries()) {
      if (!isMapping(step)) {
        violations.push(`${workflowPath}:${jobName}:steps[${index}] must be a mapping`)
        continue
      }
      if (containsCloudflareCapability(step.env) || containsSecretsContext(step.env)) {
        violations.push(
          `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
        )
      }
      if (containsSecretsContext(step.env) || containsSecretsContext(step.with)) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] must not use the secrets context in env or with`,
        )
      }
      if (typeof step.uses === 'string' && !/@[0-9a-f]{40}$/i.test(step.uses)) {
        violations.push(
          `${workflowPath}:${jobName} action ${step.uses} must be pinned to a full commit SHA`,
        )
      }
      if (typeof step.uses === 'string' && /^cloudflare\//i.test(step.uses)) {
        violations.push(
          `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
        )
      }
      for (const pin of Object.keys(NATIVE_PLATFORM_PINS)) {
        if (isMapping(step.env) && Object.hasOwn(step.env, pin)) {
          violations.push(
            `${workflowPath}:${jobName}:steps[${index}] must not shadow platform pin ${pin}`,
          )
        }
      }
      const wrapper = nativeWrapperCommand(step)
      if (containsNativeWrapperReference(step) && !wrapper) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] contains an unreviewed native wrapper reference`,
        )
        if (/^\s*node\s+scripts\/native-workflow\.mjs\b/.test(step.run)) {
          violations.push(
            `${workflowPath}:${jobName}:steps[${index}] native wrapper must use the captured trusted absolute Node path`,
          )
        }
      }
      if (writesGithubExecutionState(step)) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] must not write GITHUB_PATH or GITHUB_ENV`,
        )
      }
      const injection = executionInjectionNames(step.env)
      if (injection.length > 0) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] contains execution env injection ${injection.join(', ')}`,
        )
      }
      if (wrapper) {
        wrapperSteps.push({ ...wrapper, name: step.name, step, index })
        if (!nativeStepHasRootExecution(step)) {
          violations.push(
            `${workflowPath}:${jobName}:steps[${index}] native wrapper must use the root working-directory without env/shell/if overrides`,
          )
        }
        if (wrapper.action.startsWith('build-')) {
          const effectiveEnv = {
            ...(isMapping(workflow.env) ? workflow.env : {}),
            ...(isMapping(job.env) ? job.env : {}),
            ...(isMapping(step.env) ? step.env : {}),
          }
          for (const [pin, expected] of Object.entries(NATIVE_PLATFORM_PINS)) {
            if (String(effectiveEnv[pin]) !== String(expected)) {
              violations.push(
                `${workflowPath}:${jobName} build step effective pin ${pin} must be ${expected}`,
              )
            }
          }
        }
      }
      if (containsDirectNativeCommand(step)) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] native commands must use the exact native wrapper`,
        )
      }
    }
    const expectedProfile = NATIVE_JOB_PROFILES[jobName]
    const actualProfile = wrapperSteps.map(({ name, directory, action }) => [
      name,
      directory,
      action,
    ])
    const expectedWithService = expectedProfile?.map(([name, action]) => [
      name,
      service.directory,
      action,
    ])
    if (!expectedProfile || JSON.stringify(actualProfile) !== JSON.stringify(expectedWithService)) {
      violations.push(`${workflowPath}:${jobName} must use the exact native wrapper sequence`)
    }
    const reviewedJob = reviewedJobs[jobName]
    const jobDifference = reviewedJob
      ? firstStructuralDifference(job, reviewedJob)
      : 'job name is not registered'
    if (jobDifference) {
      violations.push(
        `${workflowPath}:${jobName} must match the reviewed exact job profile (${jobDifference})`,
      )
    }
    if (containsSecretsContext(job) || containsCloudflareCapability(job)) {
      violations.push(
        `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
      )
    }
  }
  return [...new Set(violations)]
}

export function workflowContainsNativeBuild(source, nativeServices = []) {
  const workflow = parseGithubWorkflow(source)
  for (const [, job] of objectEntries(workflow.jobs)) {
    const jobEnvironment = literalExecutionEnvironment(workflow.env, job?.env)
    const jobSurface = [
      ...executableScalarStrings(job?.uses),
      ...executableScalarStrings(job?.with),
      ...executableScalarStrings(workflow.env),
      ...executableScalarStrings(job?.env),
    ]
    if (executableSurfaceContainsNativeDispatch(jobSurface, jobEnvironment)) return true
    if (!Array.isArray(job?.steps)) continue
    for (const step of job.steps) {
      // An unregistered workflow may not reference the reviewed executor at
      // all. Dynamic/quoted argv are still capable of selecting a heavy build.
      if (containsNativeWrapperReference(step)) return true
      const effectiveEnv = {
        ...(isMapping(workflow.env) ? workflow.env : {}),
        ...(isMapping(job.env) ? job.env : {}),
        ...(isMapping(step?.env) ? step.env : {}),
      }
      if (dispatchesIndirectNativePackageScript(step, effectiveEnv, nativeServices)) return true
      const literalEnvironment = literalExecutionEnvironment(effectiveEnv)
      const executableSurface = [
        ...executableScalarStrings(step?.run),
        ...executableScalarStrings(step?.uses),
        ...executableScalarStrings(workflow.env),
        ...executableScalarStrings(job?.env),
        ...executableScalarStrings(step?.env),
        ...executableScalarStrings(step?.with),
      ]
      if (executableSurfaceContainsNativeDispatch(executableSurface, literalEnvironment))
        return true
    }
  }
  return false
}

function exactPermissions(job, expected) {
  if (!isMapping(job?.permissions)) return false
  const actual = Object.keys(job.permissions).sort()
  const keys = Object.keys(expected).sort()
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index] && job.permissions[key] === expected[key])
  )
}

function exactNeeds(job, expected) {
  if (!Array.isArray(job?.needs) || job.needs.length !== expected.length) return false
  const actual = [...job.needs].sort()
  const required = [...expected].sort()
  return actual.every((value, index) => value === required[index])
}

function inspectProductionTopology(workflowPath, workflow, jobs, violations) {
  if (workflowPath === 'ci.yml') {
    const triggers = workflow.on
    if (!isMapping(triggers)) {
      violations.push(
        'ci.yml `on` must be a mapping with pull_request, push, and workflow_dispatch',
      )
    } else {
      if (!Object.hasOwn(triggers, 'pull_request')) {
        violations.push('ci.yml `on` must include pull_request')
      }
      if (!Object.hasOwn(triggers, 'workflow_dispatch')) {
        violations.push('ci.yml `on` must include workflow_dispatch')
      }
      if (!isMapping(triggers.push) || JSON.stringify(triggers.push.branches) !== '["main"]') {
        violations.push('ci.yml push.branches must be exactly [main]')
      }
    }
    const build = jobs['build-production']
    const deploy = jobs.deploy
    if (build?.if !== PROTECTED_MAIN_PUSH) {
      violations.push('ci.yml build-production must require the protected main push condition')
    }
    if (deploy?.if !== PROTECTED_MAIN_PUSH) {
      violations.push('ci.yml deploy must require the protected main push condition')
    }
    if (deploy?.environment !== 'production') {
      violations.push('ci.yml deploy must use the production environment')
    }
    if (!exactPermissions(build, { contents: 'read' })) {
      violations.push('ci.yml build-production permissions must be exactly contents: read')
    }
    if (!exactPermissions(deploy, { contents: 'read', actions: 'read' })) {
      violations.push('ci.yml deploy permissions must be exactly contents/actions read')
    }
    if (!exactNeeds(deploy, ['verify', 'build-production'])) {
      violations.push('ci.yml deploy needs must be exactly verify and build-production')
    }
    return
  }

  if (workflowPath === 'production-bootstrap.yml') {
    const triggers = workflow.on
    if (
      !isMapping(triggers) ||
      Object.keys(triggers).length !== 1 ||
      !Object.hasOwn(triggers, 'workflow_dispatch')
    ) {
      violations.push('production-bootstrap.yml `on` must contain only workflow_dispatch')
    } else if (
      !isMapping(triggers.workflow_dispatch) ||
      !isMapping(triggers.workflow_dispatch.inputs)
    ) {
      violations.push(
        'production-bootstrap.yml workflow_dispatch must require the domain_service input',
      )
    } else {
      const input = triggers.workflow_dispatch.inputs.domain_service
      if (!isMapping(input) || input.required !== true || input.type !== 'string') {
        violations.push('production-bootstrap.yml domain_service input must be required string')
      }
    }
    const build = jobs['build-production']
    const bootstrap = jobs.bootstrap
    if (build?.if !== PROTECTED_MAIN_DISPATCH) {
      violations.push(
        'production-bootstrap.yml build-production must require protected main dispatch',
      )
    }
    if (bootstrap?.if !== PROTECTED_MAIN_DISPATCH) {
      violations.push('production-bootstrap.yml bootstrap must require protected main dispatch')
    }
    if (bootstrap?.environment !== 'production') {
      violations.push('production-bootstrap.yml bootstrap must use the production environment')
    }
    if (!exactPermissions(build, { contents: 'read' })) {
      violations.push(
        'production-bootstrap.yml build-production permissions must be exactly contents: read',
      )
    }
    if (!exactPermissions(bootstrap, { contents: 'read', actions: 'read' })) {
      violations.push(
        'production-bootstrap.yml bootstrap permissions must be exactly contents/actions read',
      )
    }
    if (!exactNeeds(bootstrap, ['build-production'])) {
      violations.push('production-bootstrap.yml bootstrap needs must be exactly build-production')
    }
  }
}

/**
 * Inspect actual parsed GitHub workflow jobs. Production command identity and
 * ordering are validated separately from parsed step mappings by
 * service-wiring.mjs; arbitrary shell strings are never registration evidence.
 */
export function inspectWorkflowPolicy(workflowPath, source) {
  const violations = []
  let workflow
  try {
    workflow = parseGithubWorkflow(source)
  } catch (error) {
    return [
      `${workflowPath} is not valid safe YAML: ${error instanceof Error ? error.message : 'parse error'}`,
    ]
  }
  const jobs = workflow.jobs
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) {
    return [`${workflowPath} must declare jobs as a mapping`]
  }

  const credentialedJob = PRODUCTION_WORKFLOWS.get(workflowPath)
  inspectProductionTopology(workflowPath, workflow, jobs, violations)
  if (credentialedJob && !Object.hasOwn(jobs, credentialedJob)) {
    violations.push(`${workflowPath} must declare the reviewed credentialed job`)
  }
  for (const [jobName, job] of objectEntries(jobs)) {
    const jobText = JSON.stringify(job)
    const permissions =
      job && typeof job === 'object' && !Array.isArray(job) ? job.permissions : null
    if (permissions && typeof permissions === 'object' && permissions['id-token'] === 'write') {
      violations.push(`${workflowPath}:${jobName} must not grant id-token: write`)
    }
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (containsDirectNativeCommand(step)) {
        violations.push(
          `${workflowPath}:${jobName}:steps[${index}] direct native commands are forbidden; use native-workflow.mjs`,
        )
      }
    }
    if (!credentialedJob) {
      if (hasProductionMarker(job)) {
        violations.push(`${workflowPath}:${jobName} contains production capability material`)
      }
      continue
    }
    if (jobName !== credentialedJob && PRODUCTION_MARKERS.test(jobText)) {
      violations.push(`${workflowPath}:${jobName} must not contain production capability material`)
    }
    if (jobName === credentialedJob) {
      const environment = job && typeof job === 'object' ? job.environment : undefined
      const environmentName =
        typeof environment === 'string'
          ? environment
          : environment && typeof environment === 'object'
            ? environment.name
            : undefined
      if (environmentName !== 'production') {
        violations.push(`${workflowPath}:${jobName} must use the production environment`)
      }
    }
  }
  return violations
}
