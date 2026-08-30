import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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
    for (const service of [
      'admin',
      'example_service',
      'example_tauri_service',
      'notifier',
      'ops',
    ]) {
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

const skillFrontmatter = [
  '---',
  'name: new-service',
  'description: Creates a service from a selected template.',
  '---',
  '',
  '# New service',
  '',
]
const validTemplateChoiceSkill = [
  ...skillFrontmatter,
  'Before copying, ask the user to choose one template:',
  '- Web only (recommended): after this answer, copy services/example_service.',
  '- Web + Tauri: after this answer, copy services/example_tauri_service.',
  'Do not copy either template before the user answers.',
].join('\n')

async function assertRejectedTemplateChoiceSkill(skill) {
  await withAgentFixture(skill, async (root) => {
    const result = await runAgentCompatibilityCheck(root)
    assert.notEqual(result.code, 0)
    assert.match(`${result.stderr}${result.stdout}`, /new-service/)
  })
}

test('accepts a new-service skill with both choices and their matching copy sources', async () => {
  await withAgentFixture(validTemplateChoiceSkill, async (root) => {
    const result = await runAgentCompatibilityCheck(root)
    assert.equal(result.code, 0)
  })
})

test('rejects a broken CLAUDE.md link in the Tauri template', async () => {
  await withAgentFixture(validTemplateChoiceSkill, async (root) => {
    await unlink(join(root, 'services/example_tauri_service/CLAUDE.md'))
    const result = await runAgentCompatibilityCheck(root)
    assert.notEqual(result.code, 0)
    assert.match(`${result.stderr}${result.stdout}`, /services\/example_tauri_service\/CLAUDE\.md/)
  })
})

for (const [caseName, skill] of [
  [
    'copies before the required template choice',
    [
      ...skillFrontmatter,
      'Copy services/example_service before collecting any additional input.',
    ].join('\n'),
  ],
  [
    'offers only the Web template choice',
    [
      ...skillFrontmatter,
      'Before copying, ask whether the user wants Web only.',
      'After the answer, copy services/example_service.',
    ].join('\n'),
  ],
  [
    'maps the Web choice to the Tauri template',
    [
      ...skillFrontmatter,
      'Before copying, ask the user to choose Web only or Web + Tauri.',
      'Web only: copy services/example_tauri_service.',
      'Web + Tauri: copy services/example_tauri_service.',
    ].join('\n'),
  ],
  [
    'maps the Tauri choice to the Web template',
    [
      ...skillFrontmatter,
      'Before copying, ask the user to choose Web only or Web + Tauri.',
      'Web only: copy services/example_service.',
      'Web + Tauri: copy services/example_service.',
    ].join('\n'),
  ],
]) {
  test(`rejects a new-service skill that ${caseName}`, async () => {
    await assertRejectedTemplateChoiceSkill(skill)
  })
}
