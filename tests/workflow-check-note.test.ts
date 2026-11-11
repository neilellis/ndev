import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { runCheck } from '../hooks/workflow/effects'

// A fake git for one check script. `mainMoved`: origin/main changed the script after the branch left it.
// `branchEdited`: the branch changed it. A two-dot diff against origin/main sees both, as real git does;
// a three-dot diff (from the merge base) sees only the branch's own edit.
const engine = (opts: { mainMoved: boolean; branchEdited: boolean }) => {
  const ok = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' })
  return {
    plugin: { root: '/plugin' },
    fs: { write: async () => {} },
    clock: { now: async () => 0 },
    ui: { log: () => {}, status: () => {} },
    process: {
      run: async (a: string[]) => {
        if (a[0] === 'bash' && a[2] === 'start') return ok('42\n')
        if (a[0] === 'bash' && a[2] === 'wait') return ok('0\n')
        if (a[0] === 'bash') return ok('')
        if (a[1] === 'rev-parse' && a.includes('--git-dir')) return ok('/r/.git\n/r/.git\n')
        if (a[1] === 'rev-parse') return ok('', 1)
        if (a[1] === 'cat-file') return ok()
        if (a[1] === 'show') return ok('#!/bin/sh\n')
        if (a[1] === 'merge-base') return ok('abc\n')
        if (a[1] === 'status') return ok()
        if (a[1] === 'diff') {
          const threeDot = a.some(x => x.includes('...'))
          const changed = opts.branchEdited || (!threeDot && opts.mainMoved)
          return ok('', changed ? 1 : 0)
        }
        return ok()
      },
    },
  } as unknown as EngineInterface
}

test('a check script that only main changed gives no warning', async () => {
  expect(await runCheck(engine({ mainMoved: true, branchEdited: false }), '/r', 'main', 'pre-commit-check.sh')).toBeUndefined()
})

test('a check script that the branch changed still gives the warning', async () => {
  expect(await runCheck(engine({ mainMoved: true, branchEdited: true }), '/r', 'main', 'pre-commit-check.sh')).toContain('This branch changes')
})
