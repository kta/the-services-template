#!/usr/bin/env node
import { spawn } from 'node:child_process'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: without-git-local-env.mjs <command> [args...]')
  process.exit(2)
}

const env = { ...process.env }
for (const name of [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
]) {
  delete env[name]
}

const child = spawn(command, args, { env, stdio: 'inherit' })
child.once('error', (error) => {
  console.error(`without-git-local-env: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
