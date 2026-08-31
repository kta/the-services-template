#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function validateNewServiceSkill(source) {
  const violations = []
  const sectionMatches = [...source.matchAll(/^## Required template choice\s*$/gim)]
  if (sectionMatches.length !== 1) {
    violations.push('must contain exactly one "Required template choice" section')
    return violations
  }

  const sectionStart = sectionMatches[0].index
  const sectionBodyStart = sectionStart + sectionMatches[0][0].length
  const followingHeading = source.slice(sectionBodyStart).search(/^##\s+/m)
  const sectionEnd = followingHeading < 0 ? source.length : sectionBodyStart + followingHeading
  const beforeSection = source.slice(0, sectionStart)
  const section = source.slice(sectionBodyStart, sectionEnd)

  if (/\bcopy\s+`?services\/(?:example_service|example_tauri_service)\b/i.test(beforeSection)) {
    violations.push('must not copy a template before the required choice section')
  }
  const firstChoicePrompt = source.search(/choose exactly one template/i)
  const firstCopyCommand = source.search(
    /\bcopy\s+`?services\/(?:example_service|example_tauri_service)\b/i,
  )
  if (firstCopyCommand >= 0 && (firstChoicePrompt < 0 || firstCopyCommand < firstChoicePrompt)) {
    violations.push('must not copy a template before asking the required choice')
  }
  if (!/before copying/i.test(section)) {
    violations.push('must make the choice before copying')
  }
  if (!/choose exactly one template/i.test(section)) {
    violations.push('must require exactly one template answer')
  }
  if (!/wait for the answer/i.test(section)) {
    violations.push('must wait for the template answer')
  }
  if (!/do not copy[^\n]*before the user answers/i.test(section)) {
    violations.push('must explicitly forbid copying before the answer')
  }

  const webMappings = countMatches(
    source,
    /^\s*[-*]\s*\*{0,2}Web only[^\n]*services\/example_service(?![_a-z])/gim,
  )
  const tauriMappings = countMatches(
    source,
    /^\s*[-*]\s*\*{0,2}Web \+ Tauri[^\n]*services\/example_tauri_service\b/gim,
  )
  if (webMappings !== 1) {
    violations.push('must map Web only to services/example_service exactly once')
  }
  if (tauriMappings !== 1) {
    violations.push('must map Web + Tauri to services/example_tauri_service exactly once')
  }
  if (!/Web only[^\n]*recommended[^\n]*default/i.test(section)) {
    violations.push('must identify Web only as recommended and default')
  }
  if (/Web only[^\n]*services\/example_tauri_service\b/i.test(source)) {
    violations.push('must not map Web only to services/example_tauri_service')
  }
  if (/Web \+ Tauri[^\n]*services\/example_service(?![_a-z])/i.test(source)) {
    violations.push('must not map Web + Tauri to services/example_service')
  }
  if (!/copy[^\n]*rename[^\n]*tauri-boundary\.json/i.test(source)) {
    violations.push('must copy and rename the service-local tauri-boundary.json manifest')
  }
  for (const field of ['releaseOrigin', 'path', 'tokenKey', 'reason']) {
    if (!new RegExp(`tauri-boundary\\.json[^\\n]*${field}`, 'i').test(source)) {
      violations.push(`must explicitly review tauri-boundary.json ${field}`)
    }
  }

  return violations
}

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('usage: check-new-service-skill.mjs <SKILL.md>')
  const violations = validateNewServiceSkill(await readFile(path, 'utf8'))
  for (const violation of violations) console.error(`new-service: ${violation}`)
  process.exitCode = violations.length === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

export { validateNewServiceSkill }
