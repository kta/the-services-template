import { join, resolve } from 'node:path'

function exactInvocation(actual, expected) {
  return (
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual) &&
    Object.keys(actual).sort().join('|') === 'args|command|cwd' &&
    actual.command === expected.command &&
    actual.cwd === expected.cwd &&
    Array.isArray(actual.args) &&
    actual.args.length === expected.args.length &&
    actual.args.every((argument, index) => argument === expected.args[index])
  )
}

export function inspectNativePackageBuildPlan(plan, workspaceRoot, service, nodePath) {
  const root = resolve(workspaceRoot)
  const serviceRoot = join(root, 'services', service.directory)
  const expected = [
    {
      command: nodePath,
      args: [
        join(root, 'scripts/run-without-cloudflare-env.mjs'),
        'pnpm',
        'exec',
        'vite',
        '--config',
        'vite.tauri.config.ts',
        'build',
      ],
      cwd: serviceRoot,
    },
    {
      command: nodePath,
      args: [join(root, 'scripts/clean-build-secrets.mjs'), 'dist'],
      cwd: serviceRoot,
    },
    {
      command: nodePath,
      args: [join(root, 'scripts/check-tauri-artifact.mjs'), 'dist/tauri'],
      cwd: serviceRoot,
    },
  ]
  if (
    !Array.isArray(plan) ||
    plan.length !== expected.length ||
    expected.some((invocation, index) => !exactInvocation(plan[index], invocation))
  ) {
    return [
      `${service.directory} native package build must exactly execute Vite build, secret cleanup, and artifact scan in order`,
    ]
  }
  return []
}
