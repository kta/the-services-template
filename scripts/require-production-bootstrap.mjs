#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshPublishedMain } from './published-main.mjs'

function fail(message) {
  console.error(`production bootstrap blocked: ${message}`)
  process.exitCode = 1
}

export function isProtectedMainWorkflowDispatch(environment) {
  return (
    environment?.GITHUB_ACTIONS === 'true' &&
    environment?.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    environment?.GITHUB_REF === 'refs/heads/main' &&
    environment?.GITHUB_REF_PROTECTED === 'true' &&
    environment?.PRODUCTION_ENVIRONMENT === 'production'
  )
}

export function requireProtectedMainWorkflowDispatch(
  environment = process.env,
  refresh = refreshPublishedMain,
  runGit = execFileSync,
) {
  if (!isProtectedMainWorkflowDispatch(environment)) {
    throw new Error('bootstrap requires workflow_dispatch on protected main production environment')
  }
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
    throw new Error(`bootstrap requires the checked-out main branch (got ${branch || 'detached'})`)
  }
  if (status?.trim())
    throw new Error('the current main checkout has uncommitted or untracked changes')
  if (!environment.GITHUB_SHA || environment.GITHUB_SHA !== head) {
    throw new Error('the checked-out commit does not match GITHUB_SHA')
  }
  let originMain
  try {
    originMain = refresh(environment, runGit)
  } catch {
    throw new Error('bootstrap requires a fresh fetch from the canonical origin/main')
  }
  if (!originMain || originMain !== head) {
    throw new Error('bootstrap requires HEAD to match the freshly fetched origin/main commit')
  }
  return true
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  if (process.argv.length !== 2) {
    fail('no command-line overrides are accepted')
  } else {
    try {
      requireProtectedMainWorkflowDispatch()
    } catch (error) {
      fail(error instanceof Error ? error.message : 'reviewed checkout validation failed')
    }
  }
}
