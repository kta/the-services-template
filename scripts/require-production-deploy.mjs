#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshPublishedMain } from './published-main.mjs'

function fail(message) {
  console.error(`production deploy blocked: ${message}`)
  process.exitCode = 1
}

export function isProtectedMainPush(environment) {
  return (
    environment?.GITHUB_ACTIONS === 'true' &&
    environment?.GITHUB_EVENT_NAME === 'push' &&
    environment?.GITHUB_REF === 'refs/heads/main' &&
    environment?.GITHUB_REF_PROTECTED === 'true'
  )
}

export function requireProtectedMainPush(
  environment = process.env,
  refresh = refreshPublishedMain,
  runGit = execFileSync,
) {
  const developmentAuthentication = [
    ['E2E_AUTH', environment.E2E_AUTH],
    ['AUTH_DEV_GRANT', environment.AUTH_DEV_GRANT],
    ['AUTH_DEV_PRIVATE_KEY', environment.AUTH_DEV_PRIVATE_KEY],
  ]
    .filter(([name, value]) =>
      name === 'AUTH_DEV_PRIVATE_KEY'
        ? Boolean(value?.trim())
        : value?.trim().toLowerCase() === 'true',
    )
    .map(([name]) => name)

  if (developmentAuthentication.length > 0) {
    throw new Error(
      `development authentication settings are not allowed (${developmentAuthentication.join(', ')})`,
    )
  }
  if (!isProtectedMainPush(environment)) {
    throw new Error('production deploys are CI-only and require a push to protected main')
  }

  let branch
  let status
  let head
  try {
    branch = runGit('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
    status = runGit('git', ['status', '--porcelain'], { encoding: 'utf8' })
    head = runGit('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('the current checkout branch could not be determined')
  }
  if (branch !== 'main') {
    throw new Error(`deploys require the checked-out main branch (got ${branch || 'detached'})`)
  }
  if (status?.trim())
    throw new Error('the current main checkout has uncommitted or untracked changes')
  if (!environment.GITHUB_SHA || environment.GITHUB_SHA !== head) {
    throw new Error('the checked-out commit does not match GITHUB_SHA')
  }

  try {
    const originMain = refresh(environment, runGit)
    if (originMain && originMain !== head) {
      throw new Error(
        'local production deploy requires HEAD to match the freshly fetched origin/main commit',
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('local production deploy')) throw error
    throw new Error('production deploy requires a fresh fetch from the canonical origin/main')
  }
  return true
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    requireProtectedMainPush()
  } catch (error) {
    fail(error instanceof Error ? error.message : 'reviewed checkout validation failed')
  }
}
