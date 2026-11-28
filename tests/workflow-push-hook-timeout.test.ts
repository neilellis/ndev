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
