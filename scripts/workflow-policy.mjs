import { spawnSync } from 'node:child_process'

const MAX_WORKFLOW_BYTES = 1024 * 1024
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

def reject_unsafe_nodes(node)
  if node.respond_to?(:tag) && node.tag
    raise "explicit YAML tags are not allowed: #{node.tag}"
  end
  case node
  when Psych::Nodes::Alias
    raise 'YAML aliases are not allowed'
  when Psych::Nodes::Mapping
    keys = []
    node.children.each_slice(2) do |key, value|
      unless key.is_a?(Psych::Nodes::Scalar)
        raise 'YAML mapping keys must be scalars'
      end
      if keys.include?(key.value)
        raise "duplicate YAML mapping key: #{key.value}"
      end
      keys << key.value
      reject_unsafe_nodes(value)
    end
  when Psych::Nodes::Sequence
    node.children.each { |child| reject_unsafe_nodes(child) }
  when Psych::Nodes::Document
    reject_unsafe_nodes(node.root)
  when Psych::Nodes::Stream
    node.children.each { |child| reject_unsafe_nodes(child) }
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
reject_unsafe_nodes(stream)
documents = stream.children
raise 'multiple YAML documents are not allowed' unless documents.length == 1
value = to_value(documents.first)
puts JSON.generate(value)
`

export function parseGithubWorkflow(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_WORKFLOW_BYTES) {
    throw new Error('workflow YAML is missing or too large')
  }
  const result = spawnSync('ruby', ['-e', RUBY_YAML_TO_JSON], {
    input: source,
    encoding: 'utf8',
    maxBuffer: MAX_WORKFLOW_BYTES * 2,
  })
  if (result.error) throw result.error
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

function actualShellCommands(run) {
  if (typeof run !== 'string') return []
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^echo\b/.test(line))
}

function nativeCapabilityMaterial(value) {
  if (!isMapping(value)) return false
  for (const [name, raw] of Object.entries(value)) {
    if (/^CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)$/.test(name)) return true
    if (name === 'id-token' && raw === 'write') return true
    if (/secrets\.PRODUCTION_|secrets\.CLOUDFLARE_/.test(String(raw))) return true
  }
  return false
}

/**
 * Validate a catalog-owned manual native artifact workflow from parsed YAML
 * nodes. Comments are discarded by the YAML parser and command evidence must
 * be an executable shell line, so an echo or comment cannot satisfy policy.
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
  if (nativeCapabilityMaterial(workflow.env) || nativeCapabilityMaterial(workflow.permissions)) {
    violations.push(
      `${workflowPath}: native workflow must not receive a Cloudflare credential or production capability`,
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
    if (nativeCapabilityMaterial(job.env) || nativeCapabilityMaterial(job.permissions)) {
      violations.push(
        `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
      )
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      violations.push(`${workflowPath}:${jobName} must declare executable steps`)
      continue
    }
    const commands = []
    for (const [index, step] of job.steps.entries()) {
      if (!isMapping(step)) {
        violations.push(`${workflowPath}:${jobName}:steps[${index}] must be a mapping`)
        continue
      }
      if (nativeCapabilityMaterial(step.env)) {
        violations.push(
          `${workflowPath}:${jobName} must not receive a Cloudflare credential or production capability`,
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
      commands.push(...actualShellCommands(step.run))
    }
    if (!commands.some((line) => /^node scripts\/check-tauri-boundary\.mjs(?:\s|$)/.test(line))) {
      violations.push(`${workflowPath}:${jobName} must run the Tauri boundary checker`)
    }
    if (!commands.some((line) => /^node scripts\/check-tauri-artifact\.mjs(?:\s|$)/.test(line))) {
      violations.push(`${workflowPath}:${jobName} must run the Tauri artifact checker`)
    }
    const buildPackages = commands
      .flatMap((line) => [
        ...line.matchAll(
          /\bpnpm\s+--filter\s+(@app\/[a-z][a-z0-9_]*)\s+(?:(?:run\s+)?build:tauri|exec\s+tauri\s+(?:build|ios\s+build|android\s+build))/g,
        ),
      ])
      .map((match) => match[1])
    if (buildPackages.length === 0 || buildPackages.some((name) => name !== service.package)) {
      violations.push(`${workflowPath}:${jobName} must build only ${service.package}`)
    }
    if (
      !commands.some(
        (line) =>
          /^node scripts\/check-tauri-artifact\.mjs(?:\s|$)/.test(line) &&
          line.includes(`services/${service.directory}/src-tauri`),
      )
    ) {
      violations.push(
        `${workflowPath}:${jobName} artifact checker must inspect services/${service.directory}/src-tauri`,
      )
    }
    if (
      commands.some((line) => /\bwrangler\s+deploy\b/.test(line)) ||
      commands.some((line) => /secrets\.PRODUCTION_|secrets\.CLOUDFLARE_/.test(line))
    ) {
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
      for (const command of actualShellCommands(step?.run)) {
        if (/\b(?:build:tauri|tauri\s+(?:build|ios\s+build|android\s+build))\b/.test(command)) {
          return true
        }
      }
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
 * Inspect actual parsed GitHub workflow jobs. Regex checks remain useful for
 * exact command ordering, but this structural pass prevents a new job,
 * comment, or block-scalar trick from bypassing the credential boundary.
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
