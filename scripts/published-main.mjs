import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANONICAL_REPOSITORY = 'kta/the-services-template'
const CANONICAL_REMOTE = 'https://github.com/kta/the-services-template.git'

function normalizeRepository(value) {
  return typeof value === 'string'
    ? value
        .trim()
        .replace(/\.git$/, '')
        .toLowerCase()
    : ''
}

function repositoryFromRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null
  const value = remoteUrl.trim()
  const match =
    value.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/i) ??
    value.match(/^git@github\.com:([^/\s]+\/[^/\s]+)$/i)
  return match ? normalizeRepository(match[1]) : null
}

function trustedGitEnvironment(environment) {
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'false',
  }
}

/**
 * Resolve the published main SHA from the canonical GitHub remote immediately
 * before a production mutation. The remote-tracking ref is not an approval
 * source, and the network lookup runs from a fresh temporary Git directory so
 * repository-local URL rewrites cannot redirect it to an operator-controlled
 * mirror. The caller may inject a runner for unit tests only.
 */
export function refreshPublishedMain(environment = process.env, runGit = execFileSync) {
  const gitEnv = trustedGitEnvironment(environment)
  const remoteUrl = runGit('git', ['config', '--local', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
    env: gitEnv,
  })
  const remoteRepository = repositoryFromRemote(remoteUrl)
  if (!remoteRepository || remoteRepository !== normalizeRepository(CANONICAL_REPOSITORY)) {
    throw new Error('origin must point to the canonical GitHub repository')
  }
  const directory = mkdtempSync(join(tmpdir(), 'published-main-'))
  try {
    const output = runGit('git', ['ls-remote', '--refs', CANONICAL_REMOTE, 'refs/heads/main'], {
      cwd: directory,
      encoding: 'utf8',
      env: gitEnv,
    }).trim()
    const match = output.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/i)
    if (!match) throw new Error('canonical origin did not return a valid main SHA')
    return match[1].toLowerCase()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
