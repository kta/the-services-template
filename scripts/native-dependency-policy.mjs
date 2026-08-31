const TAURI_CLI = '@tauri-apps/cli'

function mapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function dependencyIgnores(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

export function inspectNativeCliKnipPolicy(config, services) {
  const violations = []
  const rootConfig = mapping(config)
  const rootIgnores = dependencyIgnores(rootConfig.ignoreDependencies)
  const exactRootEntries = rootIgnores.filter((entry) => entry === TAURI_CLI)
  const otherTauriEntries = rootIgnores.filter(
    (entry) => entry.includes('@tauri-apps') && entry !== TAURI_CLI,
  )
  if (exactRootEntries.length !== 1 || otherTauriEntries.length > 0) {
    violations.push(`Knip must define one exact root ${TAURI_CLI} exception`)
  }

  const workspaces = mapping(rootConfig.workspaces)
  for (const service of services.filter((entry) => entry?.native === true)) {
    const serviceConfig = mapping(workspaces[`services/${service.directory}`])
    if (dependencyIgnores(serviceConfig.ignoreDependencies).includes(TAURI_CLI)) {
      violations.push(
        `${service.directory} Knip workspace must inherit the root ${TAURI_CLI} exception without a service allowlist`,
      )
    }
  }
  return violations
}
