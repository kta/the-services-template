import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { safeWorktreeTarget } from './worktree.mjs'

const root = join('/tmp', 'repo-worktrees')

test('worktree names remain under the managed worktree root', () => {
  assert.equal(safeWorktreeTarget('feature/security', root), join(root, 'feature/security'))
  assert.throws(() => safeWorktreeTarget('../outside', root), /escapes/)
  assert.throws(() => safeWorktreeTarget('/tmp/outside', root), /escapes/)
  assert.throws(() => safeWorktreeTarget('', root), /unsafe/)
  assert.throws(() => safeWorktreeTarget('feature\u0000branch', root), /unsafe/)
})
