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
    fs: { write: async () => {}, exists: async (p: string) => p.endsWith('.sh'), read: async () => (opts.mainMoved || opts.branchEdited ? '#!/bin/sh\nold\n' : '#!/bin/sh\n') },
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
        // The change-type read lists paths and exits 0, as real git does; only --quiet says changed by its exit code.
        if (a[1] === 'diff' && a.includes('--name-only')) return ok(opts.branchEdited ? 'scripts/ndev/workflow/pre-commit-check.sh\n' : '')
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

test('a check script that nobody changed gives no note', async () => {
  expect(await runCheck(engine({ mainMoved: false, branchEdited: false }), '/r', 'main', 'pre-commit-check.sh')).toBeUndefined()
})

test('a check script that only main changed does not blame the branch', async () => {
  const note = await runCheck(engine({ mainMoved: true, branchEdited: false }), '/r', 'main', 'pre-commit-check.sh')
  expect(note).not.toContain('This branch changes')
  expect(note).toContain('differs from the version on main')
})

test('a check script that the branch changed still gives the warning', async () => {
  expect(await runCheck(engine({ mainMoved: true, branchEdited: true }), '/r', 'main', 'pre-commit-check.sh')).toContain('This branch changes')
})
