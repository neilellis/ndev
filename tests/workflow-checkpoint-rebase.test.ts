// Workflow tests: checkpoint after the branch moved to a new stack base. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { engine, start, tool } from './workflow-harness'

const REJECTED = ' ! [rejected]        HEAD -> issue-7 (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind'

test('checkpoint pushes with a lease when the rebase replaced every commit that only the remote branch holds', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushFails = REJECTED
  w.s.leaseOk = true
  w.s.upstream = 'eeee1'
  w.s.remoteOnly = ['dddd1']
  w.s.replaced = ['dddd1']
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.s.leases.length).toBe(1)
  expect(w.s.leases[0]).toContain('--force-with-lease=refs/heads/issue-7:eeee1')
  expect(r.text).toContain('dddd1')
})

test('checkpoint does not force a push when the remote branch holds a commit the rebase did not replace, and names it', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushFails = REJECTED
  w.s.leaseOk = true
  w.s.remoteOnly = ['dddd1', 'ffff2']
  w.s.replaced = ['dddd1']
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(w.s.leases).toEqual([])
  expect(r.text).toContain('ffff2 subject of ffff2')
  expect(r.text).not.toContain('dddd1 subject')
})
