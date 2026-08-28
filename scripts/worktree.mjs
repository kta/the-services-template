#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

function repositoryRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

export function safeWorktreeTarget(name, worktreeRoot) {
  const hasControlCharacter =
    typeof name === 'string' &&
    Array.from(name).some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 31 || code === 127
    })
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 200 ||
    name.startsWith('-') ||
    hasControlCharacter
  ) {
    throw new Error('worktree name is empty or contains unsafe characters')
  }
  const target = resolve(worktreeRoot, name)
  const outside = relative(worktreeRoot, target)
  if (!outside || outside.startsWith('..') || isAbsolute(outside)) {
    throw new Error('worktree name escapes the managed worktree directory')
  }
  return target
}

function validateBranch(name) {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    throw new Error('worktree name is not a valid git branch name')
  }
}

function ensureManagedWorktreeRoot(worktreeRoot) {
  try {
    const info = lstatSync(worktreeRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('managed worktree directory must be a real directory')
    }
    chmodSync(worktreeRoot, 0o700)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
    const info = lstatSync(worktreeRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('managed worktree directory must be a real directory')
    }
    chmodSync(worktreeRoot, 0o700)
  }
}

function ensureNoTargetSymlinks(worktreeRoot, target) {
  let current = target
  while (current !== worktreeRoot) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('worktree target must not pass through a symbolic link')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    current = dirname(current)
  }
}

function runWorktree(action, name, root = repositoryRoot()) {
  const worktreeRoot = resolve(root, '..', `${basename(root)}-worktrees`)
  ensureManagedWorktreeRoot(worktreeRoot)
  const target = safeWorktreeTarget(name, worktreeRoot)
  ensureNoTargetSymlinks(worktreeRoot, target)
  validateBranch(name)

  if (action === 'new') {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    execFileSync('git', ['worktree', 'add', '-b', name, target, 'HEAD'], { stdio: 'inherit' })
    execFileSync('pnpm', ['install'], { cwd: target, stdio: 'inherit' })
    return target
  }
  if (action === 'rm') {
    execFileSync('git', ['worktree', 'remove', target], { stdio: 'inherit' })
    execFileSync('git', ['worktree', 'prune'], { stdio: 'inherit' })
    // Refuse to delete an unmerged branch. A caller who really wants to
    // discard history can use an explicit, separately reviewed git command.
    execFileSync('git', ['branch', '-d', '--', name], { stdio: 'inherit' })
    return target
  }
  throw new Error(`unknown worktree action: ${action}`)
}

const action = process.argv[2]
if (action === 'new' || action === 'rm') {
  try {
    const name = process.env.WORKTREE_NAME
    if (!name) throw new Error('set name=<branch>')
    runWorktree(action, name)
  } catch (error) {
    console.error(`worktree ${action} blocked: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}
