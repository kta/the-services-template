#!/usr/bin/env node

import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export function cleanBuildSecrets(buildRoot) {
  const root = resolve(buildRoot)
  if (basename(root) !== 'dist' || root === resolve('/') || root === resolve('.')) {
    throw new Error('refusing to clean a path that is not a service dist directory')
  }

  const removed = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === '.dev.vars') {
        const stats = lstatSync(path)
        if (stats.isDirectory()) throw new Error(`refusing to remove directory ${path}`)
        unlinkSync(path)
        removed.push(path)
        continue
      }
      if (entry.isDirectory()) visit(path)
    }
  }

  try {
    if (lstatSync(root).isDirectory()) visit(root)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return removed
}

if (process.argv[1]?.endsWith('clean-build-secrets.mjs')) {
  const buildRoot = process.argv[2]
  if (!buildRoot) {
    console.error('usage: clean-build-secrets.mjs <build-directory>')
    process.exitCode = 2
  } else {
    try {
      const removed = cleanBuildSecrets(buildRoot)
      if (removed.length > 0) console.log(`removed ${removed.length} build secret file(s)`)
    } catch (error) {
      console.error(
        `build secret cleanup blocked: ${error instanceof Error ? error.message : error}`,
      )
      process.exitCode = 1
    }
  }
}
