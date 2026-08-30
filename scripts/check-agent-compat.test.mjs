import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const agentCompatibilityCheck = join(process.cwd(), 'scripts/check-agent-compat.sh')

async function writeFixture(root, path, content) {
  const destination = join(root, path)
  await mkdir(join(destination, '..'), { recursive: true })
  await writeFile(destination, content)
}

async function withAgentFixture(skill, check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-compat-'))
  try {
    await writeFixture(root, 'AGENTS.md', '# Canonical instructions\n')
    await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
    for (const service of ['admin', 'example_service', 'notifier', 'ops']) {
      await writeFixture(root, `services/${service}/AGENTS.md`, '# Service instructions\n')
      await symlink('AGENTS.md', join(root, `services/${service}/CLAUDE.md`))
    }
    await writeFixture(root, '.agents/skills/new-service/SKILL.md', skill)
    await mkdir(join(root, '.claude'), { recursive: true })
    await symlink('../.agents/skills', join(root, '.claude/skills'))
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runAgentCompatibilityCheck(root) {
  try {
    const { stderr, stdout } = await execFileAsync('bash', [agentCompatibilityCheck, root])
    return { code: 0, stderr, stdout }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stderr: error.stderr ?? '',
      stdout: error.stdout ?? '',
    }
  }
}

test('rejects a new-service skill that copies before the required template choice', async () => {
  await withAgentFixture(
    [
      '---',
      'name: new-service',
      'description: Creates a service from the standard template.',
      '---',
      '',
      '# New service',
      '',
      'Copy services/example_service before collecting any additional input.',
    ].join('\n'),
    async (root) => {
      const result = await runAgentCompatibilityCheck(root)
      assert.notEqual(result.code, 0)
      assert.match(`${result.stderr}${result.stdout}`, /new-service/)
    },
  )
})
