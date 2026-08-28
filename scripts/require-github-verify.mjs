#!/usr/bin/env node

const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_API_TIMEOUT_MS = 10_000

function validRepository(value) {
  return typeof value === 'string' && /^[^/\s]+\/[^/\s]+$/.test(value)
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

/**
 * The deploy job already depends on the local `verify` job, but this check
 * binds the gate to an independently observed successful run for exactly the
 * commit being deployed. A renamed/replaced job cannot satisfy it unless the
 * workflow file itself is still `.github/workflows/ci.yml`.
 */
export function hasSuccessfulVerifyRun(body, sha) {
  return (
    Array.isArray(body?.workflow_runs) &&
    body.workflow_runs.some(
      (run) =>
        run &&
        typeof run === 'object' &&
        run.path === '.github/workflows/ci.yml' &&
        run.event === 'push' &&
        run.head_branch === 'main' &&
        run.head_sha === sha &&
        run.status === 'completed' &&
        run.conclusion === 'success',
    )
  )
}

export async function requireGitHubVerify(repository, sha, token, fetchImpl = fetch) {
  if (!validRepository(repository)) throw new Error('GITHUB_REPOSITORY is invalid')
  if (!validSha(sha)) throw new Error('GITHUB_SHA is invalid')
  if (typeof token !== 'string' || token.length === 0) throw new Error('GITHUB_TOKEN is missing')
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`)
  url.searchParams.set('event', 'push')
  url.searchParams.set('head_sha', sha)
  url.searchParams.set('status', 'completed')
  url.searchParams.set('per_page', '100')
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': GITHUB_API_VERSION,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('GitHub verify run lookup failed')
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error('GitHub verify run response is invalid')
  }
  if (!hasSuccessfulVerifyRun(body, sha)) {
    throw new Error('no successful exact-SHA CI verify run was found')
  }
  return true
}

if (process.argv[1]?.endsWith('require-github-verify.mjs')) {
  try {
    await requireGitHubVerify(
      process.env.GITHUB_REPOSITORY,
      process.env.GITHUB_SHA,
      process.env.GITHUB_TOKEN,
    )
    console.log('GitHub exact-SHA CI verify: ok')
  } catch (error) {
    console.error(
      `production verify gate blocked: ${error instanceof Error ? error.message : 'validation failed'}`,
    )
    process.exitCode = 1
  }
}
