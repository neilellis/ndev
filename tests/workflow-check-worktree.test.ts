import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { runCheck } from '../hooks/workflow/effects'

const MAIN = '/kaygee'
const WT = '/kaygee/wt'
const GIT_DIR = '/kaygee/.git/worktrees/wt'
const PATH = 'scripts/ndev/workflow/pre-commit-check.sh'
const BASE = '#!/bin/sh\ncd "$(dirname "$0")/../../.."\npnpm run check\n'

const engine = (worktreeCopy: string) => {
  const ok = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' })
  const started: { script: string; cwd?: string; env?: Record<string, string> }[] = []
  const files: Record<string, string> = { [`${WT}/${PATH}`]: worktreeCopy, [`${MAIN}/${PATH}`]: 'main-copy\n' }
  const $ = {
    plugin: { root: '/plugin' },
    fs: { write: async (p: string, s: string) => { files[p] = s }, exists: async (p: string) => p in files, read: async (p: string) => files[p] },
    clock: { now: async () => 0 },
    ui: { log: () => {}, status: () => {} },
    process: {
      run: async (a: string[], o: { cwd?: string; env?: Record<string, string> } = {}) => {
        if (a[0] === 'bash' && a[2] === 'start') {
          started.push({ script: a[4]!, cwd: o.cwd, env: o.env })
          return ok('42\n')
        }
        if (a[0] === 'bash' && a[2] === 'wait') return ok('0\n')
        if (a[0] === 'bash' || a[0] === 'mkdir') return ok('')
        if (a[1] === 'rev-parse' && a.includes('--git-dir')) return ok(`${GIT_DIR}\n/kaygee/.git\n`)
        if (a[1] === 'rev-parse') return ok('', 1)
        if (a[1] === 'cat-file') return ok()
        if (a[1] === 'show') return ok(BASE)
        if (a[1] === 'merge-base') return ok('abc\n')
        if (a[1] === 'status') return ok()
        if (a[1] === 'diff' && a.includes('--name-only')) return ok('')
        if (a[1] === 'diff') return ok('', worktreeCopy === BASE ? 0 : 1)
        return ok()
      },
    },
  } as unknown as EngineInterface
  return { $, started }
}

test('a check the branch did not change runs the worktree copy in place, in the worktree', async () => {
  const { $, started } = engine(BASE)
  expect(await runCheck($, WT, 'main', 'pre-commit-check.sh')).toBeUndefined()
  expect(started).toHaveLength(1)
  expect(started[0]!.script).toBe(`${WT}/${PATH}`)
  expect(started[0]!.cwd).toBe(WT)
  expect(started[0]!.env?.NDEV_WORKTREE_ROOT).toBe(WT)
})

test('a check the branch changed runs the base version from outside the main checkout, in the worktree, with a note', async () => {
  const { $, started } = engine('#!/bin/sh\nexit 0\n')
  const note = await runCheck($, WT, 'main', 'pre-commit-check.sh')
  expect(started).toHaveLength(1)
  expect(started[0]!.script).toBe(`${GIT_DIR}/ndev-base-checks/${PATH}`)
  expect(started[0]!.cwd).toBe(WT)
  expect(started[0]!.env?.NDEV_WORKTREE_ROOT).toBe(WT)
  expect(note).toContain('NDEV_WORKTREE_ROOT')
})
