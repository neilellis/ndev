// Workflow tests: a push whose pre-push hook runs for minutes (issue #317). The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { engine, start, tool } from './workflow-harness'

const HOOK = '/main/.git/hooks/pre-push'
const HOOK_LOG = '/tmp/pre-push-guards.abc/checks.log'

test('checkpoint waits for a pre-push hook that runs past 300 s and within the default guard.timeoutSeconds', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushMs = 20 * 60_000
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.s.upstream).toBe(w.s.sha)
})

test('the push limit follows guard.timeoutSeconds, and a push stopped past it names the hook, its limit and its log', async ($, on) => {
  const w = engine(on, { files: { [HOOK]: '#!/bin/sh\n' } })
  await start($, w)
  w.s.guardTimeout = '600'
  w.s.hookOutput = `INFO: running scripts/whole-tree-checks.sh --base abc (log: ${HOOK_LOG})\n`
  w.s.pushMs = 16 * 60_000
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(HOOK)
  expect(r.text).toContain('guard.timeoutSeconds 600')
  expect(r.text).toContain('ndev-git-push.log')
  expect(w.s.checkStops).toContain('4242')
})

test('checkpoint refuses a guard.timeoutSeconds that is not a whole number and names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.guardTimeout = 'soon'
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain("guard.timeoutSeconds is 'soon'")
  expect(r.text).toContain('config guard.timeoutSeconds 2700')
})

test('a push with a lease after a rebase waits for a pre-push hook that runs past 300 s', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushFails = ' ! [rejected]        HEAD -> issue-7 (non-fast-forward)'
  w.s.leaseOk = true
  w.s.upstream = 'eeee1'
  w.s.remoteOnly = ['dddd1']
  w.s.replaced = ['dddd1']
  w.s.pushMs = 20 * 60_000
  const r = await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.s.leases.length).toBe(1)
})

test('started pushes a branch that is ahead of its remote with the limit of the pre-push hook, and names the hook when stopped', { timeoutMs: 30_000 }, async ($, on) => {
  const w = engine(on, { wf: null, files: { [HOOK]: '#!/bin/sh\n' } })
  await start($, w)
  w.s.ahead = '1'
  w.s.noOpenPr = true
  w.s.upstream = 'eeee1'
  w.s.guardTimeout = '600'
  w.s.pushMs = 16 * 60_000
  const stopped = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(stopped.isError).toBe(true)
  expect(stopped.text).toContain(HOOK)
  expect(stopped.text).toContain('guard.timeoutSeconds 600')
  w.s.pushMs = 9 * 60_000
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.prs).toEqual([13])
})
