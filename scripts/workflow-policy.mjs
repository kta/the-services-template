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
    .match(/^node scripts\/native-workflow\.mjs ([a-z][a-z0-9_]{0,62}) ([a-z][a-z0-9-]*)$/)
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
    if (containsSecretsContext(job) || containsCloudflareCapability(job)) {
      violations.push(
        `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
      )
    }
  }
  return [...new Set(violations)]
}

export function workflowContainsNativeBuild(source) {
  const workflow = parseGithubWorkflow(source)
  for (const [, job] of objectEntries(workflow.jobs)) {
    if (!Array.isArray(job?.steps)) continue
    for (const step of job.steps) {
      // An unregistered workflow may not reference the reviewed executor at
      // all. Dynamic/quoted argv are still capable of selecting a heavy build.
      if (containsNativeWrapperReference(step)) return true
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
