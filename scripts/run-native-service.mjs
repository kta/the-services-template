#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { loadServiceCatalog } from './service-catalog.mjs'

const [operation, directory] = process.argv.slice(2)
if (!['dev', 'build'].includes(operation) || !directory) {
  console.error('usage: run-native-service.mjs dev|build <catalog-directory>')
  process.exit(2)
}

const services = await loadServiceCatalog()
const service = services.find((candidate) => candidate.directory === directory)
if (!service) throw new Error(`${directory}: service is not registered in service-catalog.json`)
if (!service.native)
  throw new Error(`${directory}: Web-only service cannot run native Tauri commands`)

const args =
  operation === 'dev'
    ? ['--filter', service.package, 'tauri', 'dev']
    : ['--filter', service.package, 'build:tauri']
const child = spawn('pnpm', args, { stdio: 'inherit' })
child.once('error', (error) => {
  console.error(`native ${operation}: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
