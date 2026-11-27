// Workflow tests: a workflow tool call and the host's time budget for one hook. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { engine, settle, start, tool } from './workflow-harness'

const realMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Regression (a large monorepo where a check script runs for minutes): checkpoint ran past the ten seconds
// of its hook's own time twice, before the commit. Workflow tool calls take turns, and a hook's time runs on
// while it awaits the turn of another call, but not while a process of its own runs. So a call behind a long
// check was dropped after ten seconds. The test kit counts that time and does not drop the hook, so the proof
// is that the call behind pauses with sleep processes, which cost it nothing, until its turn comes.
test('a tool call behind a checkpoint that runs a long check waits with pauses that cost its hook no time', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staged = true
  w.s.sleepAdvances = true
  w.s.sleepYields = true
  let release!: () => void
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const first = tool($, 'checkpoint', { message: 'change', files: ['a.ts'] })
  await settle()
  const before = w.s.now
  const second = tool($, 'checkpoint', { message: 'more', files: ['a.ts'] })
  await realMs(200)
  // Each pause is a sleep process of 0.2 s, and the fake clock moves by that much.
  expect(w.s.now - before).toBeGreaterThanOrEqual(400)
  release()
  expect((await first).isError).toBe(false)
  expect((await second).text).toContain('State: developing')
})

// When a hook is lost all the same, the answer in its place says what the call was doing. The test kit does not
// drop a hook, so here the hook fails outside its own error handling, which takes the same route.
test('the answer for a lost call that waited for its turn names the call that held the turn, and its step', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staged = true
  w.s.sleepYields = true
  let release!: () => void
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const first = tool($, 'checkpoint', { message: 'change', files: ['a.ts'] })
  await settle()
  w.s.sleepFails = 'sleep: the pause broke'
  const r = await tool($, 'status')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('workflow status gave no answer')
  expect(r.text).toMatch(/It was waiting for its turn behind checkpoint, in the step "(fast-checks|pre-commit-check)\.sh"/)
  w.s.sleepFails = ''
  release()
  expect((await first).isError).toBe(false)
})

test('the answer for a lost call that had its turn says that it was running', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staged = true
  let release!: () => void
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'checkpoint', { message: 'change', files: ['a.ts'] })
  await settle()
  // The hook reads the clock in its turn, and again inside its own error handling.
  Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
  release()
  const r = await call
  expect(r.isError).toBe(true)
  expect(r.text).toContain('workflow checkpoint gave no answer')
  expect(r.text).toContain('It had its turn and was running')
})
