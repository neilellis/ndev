// Workflow tests: Hack mode: the hack, hardening and its refusals. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { engine, start, tool, command, HACK } from './workflow-harness'

test('in the hack, checkpoint commits with no push and no base check, and a failed fast check only reports', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'developing', baseCheck: undefined } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'fast-checks.sh'
  const r = await tool($, 'checkpoint', { message: 'try it', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.pushes).toHaveLength(0)
  expect(r.text).toContain('fast-checks.sh exited 3')
  expect(w.steps.some(x => x.includes('pre-commit-check'))).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('in the hack, checkpoint with no files does not push the hacked commits', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'developing' } })
  await start($, w)
  w.s.upstream = 'cccc0000'
  const r = await tool($, 'checkpoint', { message: 'push it' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedHacking')
  expect(w.pushes).toHaveLength(0)
})

test('in hardening, a failed pre-commit check stops the commit, and a commit is still not pushed', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'hardening' } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.failCheck = 'pre-commit-check'
  const refused = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(refused.isError).toBe(true)
  expect(w.commits).toEqual([])
  w.s.failCheck = ''
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.pushes).toHaveLength(0)
  expect(w.state()?.state).toBe('hardening')
})

test('finishedHacking moves the hack to hardening and names the hardening steps', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'finishedHacking')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('hardening')
  expect(r.text).toContain('fail on the base')
})

test('finishedDevelopment refuses a hack that has not been hardened, and names finishedHacking', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedHacking')
  expect(w.commits).toEqual([])
})

test('finishedDevelopment of a hack needs the hardening evidence, runs pre-push-check.sh and gates.sh, and puts the evidence on the PR', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'hardening' } })
  await start($, w)
  const bare = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(bare.isError).toBe(true)
  expect(bare.text).toContain('hardening')
  expect(w.commits).toEqual([])
  const evidence = 'a.test.ts fails on the base: expected 2, got 1. It passes on HEAD.'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], hardening: evidence })
  expect(r.isError).toBe(false)
  expect(w.steps.some(x => x.startsWith('pre-push-check.sh'))).toBe(true)
  expect(w.steps.some(x => x.startsWith('gates.sh'))).toBe(true)
  expect(w.gh.some(l => l.includes(' comment ') && l.includes('expected 2, got 1'))).toBe(true)
  expect(w.pushes).toHaveLength(0)
  expect(w.prRecord(12)?.state).toBe('reviewing')
})

test('a failed pre-push check stops the finishedDevelopment of a hack, and the commit stays here', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'hardening' } })
  await start($, w)
  w.s.failCheck = 'pre-push-check'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'], hardening: 'tests' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('pre-push-check.sh exited 3')
  expect(w.pushes).toHaveLength(0)
  expect(w.state()?.state).toBe('hardening')
})

test('the smoke test of a hack cannot be skipped by the agent', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'smoke' } })
  await start($, w)
  const r = await tool($, 'finishedSmoke', { skipped: 'nothing to see' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow skip')
})

test('hack mode is interactive only: started, create and setSteering refuse it with auto steering', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'auto' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login', mode: 'hack' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('interactive')
  expect(r.text).toContain('/flow steering interactive')
  expect(w.state()).toBeUndefined()
  const made = await tool($, 'create', { shortName: 'new-thing', description: 'New thing', mode: 'hack' })
  expect(made.isError).toBe(true)
  expect(made.text).toContain('interactive')
})

test('an agent cannot set a hack to auto steering', async ($, on) => {
  const w = engine(on, { ...HACK, wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'setSteering', { steering: 'auto', reason: 'no human' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow mode light')
  expect(w.state()?.steering).toBeUndefined()
})

test('/flow refuses hack mode on an auto issue, and auto steering on a hack issue', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'auto' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  expect(await command($, 'mode hack 7')).toContain('interactive')
  expect(w.state()?.mode).toBeUndefined()
  await command($, 'steering interactive')
  expect(await command($, 'mode hack 7')).toContain('issue #7')
  expect(w.state()?.mode).toBe('hack')
  expect(await command($, 'steering auto')).toContain('hack')
  expect(w.state()?.steering).toBe('interactive')
})
