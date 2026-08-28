#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_API_TIMEOUT_MS = 10_000
export const REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS = Object.freeze([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'PRODUCTION_JWT_PRIVATE_KEY',
  'PRODUCTION_JWT_PUBLIC_KEY',
  'PRODUCTION_DOMAIN_TO_ADMIN_KEY',
  'PRODUCTION_ADMIN_TO_DOMAIN_KEY',
  'PRODUCTION_ADMIN_TO_NOTIFIER_KEY',
  'PRODUCTION_DOMAIN_TO_NOTIFIER_KEY',
  'PRODUCTION_OPS_TO_NOTIFIER_KEY',
  'PRODUCTION_AUTH_PEPPER',
  'PRODUCTION_RESEND_API_KEY',
  'PRODUCTION_D1_EXPORT_API_TOKEN',
  'PRODUCTION_R2_POLICY_CHECK_API_TOKEN',
  'PRODUCTION_BACKUP_SIGNING_PRIVATE_KEY',
  'PRODUCTION_NOTIFIER_DEDUPE_ID',
  'PRODUCTION_BACKUP_BUCKET_NAME',
  'PRODUCTION_RESOURCE_MANIFEST',
])

/**
 * Validate the repository-side production environment policy. Workflow YAML
 * can require `environment: production`, but the branch policy and required
 * reviewers are mutable GitHub settings outside the repository. Keep that
 * external control fail-closed at the last point before a production job uses
 * Cloudflare credentials.
 */
export function validateProductionEnvironmentPolicy(environment, branchPolicies) {
  if (environment?.can_admins_bypass !== false) {
    throw new Error('production environment must disable administrator bypass')
  }
  const branchPolicy = environment?.deployment_branch_policy
  if (branchPolicy?.protected_branches !== false || branchPolicy.custom_branch_policies !== true) {
    throw new Error('production environment must use the selected protected main branch policy')
  }
  const selectedBranches = branchPolicies?.branch_policies
  if (
    !Array.isArray(selectedBranches) ||
    selectedBranches.length !== 1 ||
    selectedBranches[0]?.type !== 'branch' ||
    selectedBranches[0]?.name !== 'main'
  ) {
    throw new Error('production environment must allow exactly the main branch')
  }

  const hasRequiredReviewer = (environment?.protection_rules ?? []).some(
    (rule) =>
      rule?.type === 'required_reviewers' &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.length > 0 &&
      rule.prevent_self_review === true,
  )
  if (!hasRequiredReviewer) {
    throw new Error(
      'production environment must require at least one reviewer and prevent self-review',
    )
  }
  return true
}

function secretNames(response) {
  const entries = response?.secrets
  if (!Array.isArray(entries)) throw new Error('GitHub production secret list is invalid')
  const names = entries.map((entry) => entry?.name)
  if (names.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error('GitHub production secret list contains an invalid name')
  }
  if (new Set(names).size !== names.length) {
    throw new Error('GitHub production secret list contains duplicate names')
  }
  return names
}

export function validateProductionEnvironmentSecrets(environmentSecrets, repositorySecrets) {
  const environmentNames = secretNames(environmentSecrets)
  const repositoryNames = secretNames(repositorySecrets)
  const expected = new Set(REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS)
  const missing = REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS.filter(
    (name) => !environmentNames.includes(name),
  )
  const unexpected = environmentNames.filter((name) => !expected.has(name))
  const shadowed = repositoryNames.filter((name) => expected.has(name))
  if (missing.length || unexpected.length || shadowed.length) {
    throw new Error(
      `GitHub production secret source is invalid (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}; repository shadow: ${shadowed.join(', ') || 'none'})`,
    )
  }
  return true
}

export async function checkGitHubProductionEnvironment(repository, token, fetchImpl = fetch) {
  if (typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY is invalid')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('GITHUB_TOKEN is missing')
  }
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': GITHUB_API_VERSION,
  }
  async function getJson(url, label) {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub production ${label} lookup failed`)
    try {
      return await response.json()
    } catch {
      throw new Error(`GitHub production ${label} response is invalid`)
    }
  }

  async function getSecretList(url, label) {
    const entries = []
    for (let page = 1; page <= 10; page += 1) {
      const body = await getJson(`${url}?per_page=100&page=${page}`, label)
      if (!Array.isArray(body?.secrets)) {
        throw new Error(`GitHub production ${label} list is invalid`)
      }
      entries.push(...body.secrets)
      const total = body.total_count
      if (Number.isSafeInteger(total) && total >= 0) {
        if (total < entries.length) {
          throw new Error(`GitHub production ${label} pagination is invalid`)
        }
        if (entries.length >= total) return { secrets: entries }
        if (body.secrets.length < 100) {
          throw new Error(`GitHub production ${label} pagination is invalid`)
        }
      } else {
        if (body.secrets.length < 100) return { secrets: entries }
        throw new Error(`GitHub production ${label} pagination is invalid`)
      }
    }
    throw new Error(`GitHub production ${label} list is too large`)
  }

  const baseUrl = `https://api.github.com/repos/${repository}/environments/production`
  const environment = await getJson(baseUrl, 'environment')
  const branchPolicies = await getJson(`${baseUrl}/deployment-branch-policies`, 'branch policy')
  const environmentSecrets = await getSecretList(`${baseUrl}/secrets`, 'environment secret')
  const repositorySecrets = await getSecretList(
    `https://api.github.com/repos/${repository}/actions/secrets`,
    'repository secret',
  )
  validateProductionEnvironmentPolicy(environment, branchPolicies)
  return validateProductionEnvironmentSecrets(environmentSecrets, repositorySecrets)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await checkGitHubProductionEnvironment(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN)
    console.log('GitHub production environment policy: ok')
  } catch (error) {
    console.error(
      `production environment blocked: ${error instanceof Error ? error.message : 'validation failed'}`,
    )
    process.exitCode = 1
  }
}
