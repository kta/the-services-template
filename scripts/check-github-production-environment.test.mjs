import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkGitHubProductionEnvironment,
  REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS,
  validateProductionEnvironmentPolicy,
  validateProductionEnvironmentSecrets,
} from './check-github-production-environment.mjs'

const validEnvironment = {
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [
    { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User' }] },
  ],
}
const validBranchPolicies = {
  total_count: 1,
  branch_policies: [{ name: 'main', type: 'branch' }],
}
const validSecrets = {
  total_count: REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS.length,
  secrets: REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS.map((name) => ({ name })),
}
const validRepositorySecrets = {
  total_count: 1,
  secrets: [{ name: 'UNRELATED_REPOSITORY_SECRET' }],
}

test('requires protected branches, reviewer, and self-review prevention', () => {
  assert.equal(validateProductionEnvironmentPolicy(validEnvironment, validBranchPolicies), true)
  assert.throws(
    () =>
      validateProductionEnvironmentPolicy({
        ...validEnvironment,
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      }),
    /selected protected main/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentPolicy(validEnvironment, {
        total_count: 2,
        branch_policies: [
          { name: 'main', type: 'branch' },
          { name: 'release', type: 'branch' },
        ],
      }),
    /exactly the main branch/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentPolicy(
        {
          ...validEnvironment,
          protection_rules: [{ type: 'wait_timer', wait_timer: 30 }],
        },
        validBranchPolicies,
      ),
    /at least one reviewer/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentPolicy(
        {
          ...validEnvironment,
          protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }],
        },
        validBranchPolicies,
      ),
    /self-review/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentPolicy(
        { ...validEnvironment, can_admins_bypass: true },
        validBranchPolicies,
      ),
    /administrator bypass/,
  )
})

test('requires the exact environment secret source and rejects repository shadowing', () => {
  assert.equal(validateProductionEnvironmentSecrets(validSecrets, validRepositorySecrets), true)
  assert.throws(
    () =>
      validateProductionEnvironmentSecrets(
        { secrets: validSecrets.secrets.slice(1) },
        validRepositorySecrets,
      ),
    /missing.*CLOUDFLARE_API_TOKEN/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentSecrets(
        { secrets: [...validSecrets.secrets, { name: 'UNKNOWN_SECRET' }] },
        validRepositorySecrets,
      ),
    /unexpected.*UNKNOWN_SECRET/,
  )
  assert.throws(
    () =>
      validateProductionEnvironmentSecrets(validSecrets, {
        secrets: [{ name: 'PRODUCTION_AUTH_PEPPER' }],
      }),
    /repository shadow.*PRODUCTION_AUTH_PEPPER/,
  )
})

test('reads only the expected GitHub environment endpoint and hides API errors', async () => {
  const calls = []
  const result = await checkGitHubProductionEnvironment(
    'kta/the-services-template',
    'short-lived-token',
    async (input, init) => {
      calls.push({ input: String(input), init })
      const url = String(input)
      const body = url.includes('/deployment-branch-policies')
        ? validBranchPolicies
        : url.includes('/environments/production/secrets')
          ? validSecrets
          : url.includes('/actions/secrets')
            ? validRepositorySecrets
            : validEnvironment
      return new Response(JSON.stringify(body), { status: 200 })
    },
  )
  assert.equal(result, true)
  assert.equal(
    calls[0].input,
    'https://api.github.com/repos/kta/the-services-template/environments/production',
  )
  assert.equal(calls.length, 4)
  assert.equal(
    calls[1].input,
    'https://api.github.com/repos/kta/the-services-template/environments/production/deployment-branch-policies',
  )
  assert.equal(
    calls[2].input,
    'https://api.github.com/repos/kta/the-services-template/environments/production/secrets?per_page=100&page=1',
  )
  assert.equal(
    calls[3].input,
    'https://api.github.com/repos/kta/the-services-template/actions/secrets?per_page=100&page=1',
  )
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.authorization, 'Bearer short-lived-token')
  await assert.rejects(
    () =>
      checkGitHubProductionEnvironment(
        'kta/the-services-template',
        'short-lived-token',
        async () => new Response('private details', { status: 403 }),
      ),
    /lookup failed/,
  )
})

test('follows both environment and repository secret pagination and rejects inconsistent totals', async () => {
  const paginatedNames = [
    ...REQUIRED_PRODUCTION_ENVIRONMENT_SECRETS,
    ...Array.from({ length: 85 }, (_, index) => `EXTRA_SECRET_${index}`),
  ]
  const firstPage = paginatedNames.slice(0, 100).map((name) => ({ name }))
  const secondPage = paginatedNames.slice(100).map((name) => ({ name }))
  const calls = []
  await assert.rejects(
    checkGitHubProductionEnvironment(
      'kta/the-services-template',
      'short-lived-token',
      async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/deployment-branch-policies'))
          return new Response(JSON.stringify(validBranchPolicies))
        if (url.includes('/environments/production/secrets')) {
          return new Response(
            JSON.stringify(
              url.includes('page=2')
                ? { total_count: paginatedNames.length, secrets: secondPage }
                : { total_count: paginatedNames.length, secrets: firstPage },
            ),
          )
        }
        if (url.includes('/actions/secrets'))
          return new Response(JSON.stringify(validRepositorySecrets))
        return new Response(JSON.stringify(validEnvironment))
      },
    ),
    /unexpected.*EXTRA_SECRET_0/,
  )
  assert.ok(calls.some((url) => url.endsWith('secrets?per_page=100&page=2')))

  await assert.rejects(
    () =>
      checkGitHubProductionEnvironment(
        'kta/the-services-template',
        'short-lived-token',
        async (input) => {
          const url = String(input)
          if (url.includes('/deployment-branch-policies'))
            return new Response(JSON.stringify(validBranchPolicies))
          if (url.includes('/environments/production/secrets')) {
            return new Response(
              JSON.stringify({ total_count: 0, secrets: [{ name: 'CLOUDFLARE_API_TOKEN' }] }),
            )
          }
          return new Response(JSON.stringify(validEnvironment))
        },
      ),
    /pagination is invalid/,
  )
})
