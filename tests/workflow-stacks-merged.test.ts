// Workflow tests: done and the stacks and dev servers, labels, and a PR that a human merged during ci. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, RECORD, flow, held, engine, start, tool, finishing, MERGED_PR, finished, DONE } from './workflow-harness'

test('done stops the stacks and the dev servers of the worktree, and leaves the worktree to Orca', async ($, on) => {
  const w = engine(on, finished())
  await start($, w)
  const r = await tool($, 'done', DONE)
  expect(r.isError).toBe(false)
  expect(w.steps).toContain(`worktree-env.sh stop-all --background --on-end stop-and-delete --worktree ${ROOT}`)
})

test('done keeps to the policy of the project for stacks', async ($, on) => {
  const w = engine(on, finished({ config: { worktreeStacks: { onSessionEnd: 'keep-running' } } }))
  await start($, w)
  await tool($, 'done', DONE)
  expect(w.steps).toContain(`worktree-env.sh stop-all --background --on-end keep-running --worktree ${ROOT}`)
})

test('done stops nothing while another issue in the worktree is unfinished', async ($, on) => {
  const w = engine(on, finished({ files: { [RECORD]: held(flow(finishing()), flow({ issue: 8, prs: [13], state: 'developing' })) } }))
  await start($, w)
  const r = await tool($, 'done', { ...DONE, pr: 12 })
  expect(r.isError).toBe(false)
  expect(w.steps.some(l => l.includes('stop-all'))).toBe(false)
})

test('a stop that fails does not undo done, and names the repair', async ($, on) => {
  const w = engine(on, finished())
  await start($, w)
  w.s.stopFails = 'record is version 1'
  const r = await tool($, 'done', DONE)
  expect(r.isError).toBe(false)
  expect(r.text).toContain('record is version 1')
  expect(r.text).toContain(`stop-all --worktree ${ROOT}`)
  expect(w.state()?.state).toBe('done')
})

// ---- the incomprehensible label ----
test('started names the incomprehensible label', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-thing' })
  expect(r.text).toContain('incomprehensible')
})

// fcc-proto PR #660: a human merged the PR while the workflow stood in ci, and the agent then pushed a merge of
// main through checkpoint. finishedChecks refused for the head that a merged PR can never take, and done refused
// in ci, so the record could not end.
test('in ci, a PR that a human merged ends through done, and finishedChecks names done', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { ...MERGED_PR, head: { sha: 'f'.repeat(40), ref: 'issue-7' } } })
  await start($, w)
  const c = await tool($, 'finishedChecks', {})
  expect(c.isError).toBe(true)
  expect(c.text).toContain('PR #12 is merged')
  expect(c.text).toContain('call done')
  expect(c.text).not.toContain('Push it')
  const r = await tool($, 'done', { message: 'merged by the human', remembered: 'nothing: merged by hand' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('PR #12 is already merged')
  expect(r.text).toContain('not the merged head')
})

test('done after a human merge refuses while HEAD holds commits that the merged PR does not, and names how to save them', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { ...MERGED_PR, head: { sha: 'f'.repeat(40), ref: 'issue-7' } } })
  await start($, w)
  w.s.unmerged = '2'
  const r = await tool($, 'done', { message: 'merged by the human', remembered: 'nothing: merged by hand' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('2 commits')
  expect(r.text).toContain('ffffffff')
  expect(r.text).toContain('followUp')
  expect(r.text).toContain('git push origin HEAD:refs/heads/issue-7-rest')
  expect(w.state()?.state).toBe('reviewing')
  expect(w.state()?.merged).toBeFalsy()
})

test('in ci, checkpoint refuses to commit or push to the branch of a merged PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'merge main', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('call done')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
})

test('in finishing, checkpoint refuses to commit or push to the branch of a merged PR, and names done', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing' }, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('call done')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('finishing')
})

test('in developing, checkpoint refuses to commit or push to the branch of a merged PR, and names the goto that leads to done', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', baseChecked: true } as never, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('with its issue closed, call done')
  expect(r.text).toContain('/flow goto reviewing')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('in developing, checkpoint refuses when the read of its PR fails, names the PR, and commits nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', baseChecked: true } as never })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.prReadsFor = { 12: ['HTTP 403: rate limit'] }
  const r = await tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('could not read PR #12')
  expect(r.text).toContain('rate limit')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
})

test('in developed, checkpoint refuses for a merged PR and names the goto, because done is not legal there', async ($, on) => {
  const w = engine(on, { wf: { state: 'developed' }, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12 is merged')
  expect(r.text).toContain('Repair: ask the human to run /flow goto reviewing, then call done')
  expect(w.commits.length).toBe(0)
  expect(w.state()?.state).toBe('developed')
})

test('in blocked, checkpoint refuses for its state before it reads the PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'blocked', previous: 'developing' } as never, pr: MERGED_PR })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).not.toContain('PR #12 is merged')
  expect(w.commits.length).toBe(0)
})
