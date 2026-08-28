#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshPublishedMain } from './published-main.mjs'

function fail(message) {
  console.error(`production secret provisioning blocked: ${message}`)
  process.exitCode = 1
}

export function requireCleanPublishedMain(refresh = refreshPublishedMain, runGit = execFileSync) {
  let branch
  let status
  let head
  try {
    branch = runGit('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
    status = runGit('git', ['status', '--porcelain'], { encoding: 'utf8' })
    head = runGit('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('the reviewed main checkout or fetched origin/main could not be determined')
  }
  if (branch !== 'main') {
    throw new Error(
      `secret provisioning requires the checked-out main branch (got ${branch || 'detached'})`,
    )
  }
  if (status.trim())
    throw new Error('the current main checkout has uncommitted or untracked changes')
  let originMain
  try {
    originMain = refresh()
  } catch {
    throw new Error('the canonical origin could not refresh refs/remotes/origin/main')
  }
  if (!originMain || originMain !== head) {
    throw new Error('secret provisioning requires HEAD to match the fetched origin/main commit')
  }
  return true
}

export function isProtectedProductionWorkflow(environment = process.env) {
  return (
    environment?.GITHUB_ACTIONS === 'true' &&
    environment?.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    environment?.GITHUB_REF === 'refs/heads/main' &&
    environment?.GITHUB_REF_PROTECTED === 'true' &&
    environment?.PRODUCTION_ENVIRONMENT === 'production'
  )
}

/** All production state mutations must receive secrets from a protected job. */
export function requireProtectedProductionWorkflow(
  environment = process.env,
  refresh = refreshPublishedMain,
  runGit = execFileSync,
) {
  if (!isProtectedProductionWorkflow(environment)) {
    throw new Error('production state mutations require a protected production workflow on main')
  }
  return requireCleanPublishedMain(refresh, runGit)
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    if (process.argv.length !== 2) throw new Error('no command-line overrides are accepted')
    requireProtectedProductionWorkflow()
  } catch (error) {
    fail(error instanceof Error ? error.message : 'reviewed checkout validation failed')
  }
}
