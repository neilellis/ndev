// Workflow tests: The /flow commands and /unblock. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { CHECKS, engine, start, tool, command, unblock } from './workflow-harness'

// ---- /flow ----
test('/flow status shows the state and the next step', async ($, on) => {
  engine(on)
  await start($)
  const out = await command($, 'status')
  expect(out).toContain('in the state "developing"')
  expect(out).toContain('Next:')
})

test('a record from before addMigration has no list, and status still answers', async ($, on) => {
  engine(on, { wf: { migrations: undefined } })
  await start($)
  const out = await command($, 'status')
  expect(out).not.toContain('failed')
  expect(out).toContain('in the state "developing"')
})

test('/flow guide shows the guide, with or without a workflow, and changes nothing', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect(await command($, 'guide')).toContain('# The guide')
  expect(w.state()).toBeUndefined()
  expect(w.gh).toEqual([])
})

test('/flow guide names the file and the repair when the guide is missing', async ($, on) => {
  engine(on, { guide: false })
  await start($)
  const out = await command($, 'guide')
  expect(out).toContain('/kb/workflow.md')
  expect(out).toContain('claude plugin update')
})

test('/flow with an unknown word lists the commands', async ($, on) => {
  engine(on)
  await start($)
  expect(await command($, 'bogus')).toContain('/flow skip')
})

test('/flow skip moves on, tells the agent and records it on the PR', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const out = await command($, 'skip the review is not needed')
  expect(out).toContain('from "developing" to "reviewing"')
  expect(w.state()?.state).toBe('reviewing')
  expect(w.prompts[0]).toContain('in the state "reviewing"')
  expect(w.gh.some(c => c.includes('comment 12') && c.includes('the review is not needed'))).toBe(true)
})

test('/flow skip of ci lets done pass on red checks, for that commit only', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'flaky', conclusion: 'failure' }) })
  await start($, w)
  await command($, 'skip flaky suite')
  expect(w.state()?.state).toBe('finishing')
  expect((await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })).isError).toBe(false)
})

test('/flow skip of ci gives no pass to a later commit', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'flaky', conclusion: 'failure' }) })
  await start($, w)
  await command($, 'skip flaky suite')
  w.s.sha = 'later'
  w.s.upstream = 'later'
  w.s.pr = { ...w.s.pr, head: { sha: 'later', ref: 'issue-7' } }
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Red checks')
})

test('/flow skip refuses when blocked and names unblock', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'help' })
  expect(await command($, 'skip')).toContain('/flow unblock')
  expect(w.state()?.state).toBe('blocked')
})

test('/flow unblock withdraws the alert and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'help' })
  await command($, 'unblock use Postgres')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.prompts[0]).toContain('use Postgres')
})

test('/unblock gives the answer to the agent, withdraws the alert and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'which database?' })
  const text = await unblock($, 'use Postgres')
  expect(text).toContain('back in the state "developing"')
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.prompts[0]).toContain('use Postgres')
})

test('/unblock with no message changes nothing and says the message is needed', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await tool($, 'blocked', { message: 'which database?' })
  for (const args of ['', '   ']) {
    const text = await unblock($, args)
    expect(text).toContain('/unblock <message>')
    expect(text).toContain('which database?')
  }
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
  expect(w.prompts).toEqual([])
})

test('/unblock when nothing is blocked says so and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(await unblock($, 'use Postgres')).toContain('is not blocked')
  expect(w.state()?.state).toBe('developing')
  expect(w.prompts).toEqual([])
})

// ---- the wait tools ----
// On a loaded computer each slice of a pause costs the hook some of its own ten seconds. Past them the host
// drops the hook, and the agent reads "no tool.call hook answered this call". The test kit counts that time
// and does not drop the hook, so the proof is that the wait ends inside the pause, before the time is spent.
// A large record makes each read of it slow, and that time is the hook's own. The pauses grow to make the time
// last, so how many checks run first depends on how busy the computer is.
test('a wait whose own time runs low during a long pause stops inside the pause, and names the cause and the repair', { timeoutMs: 180_000 }, async ($, on) => {
  const w = engine(on, { wf: { ballast: Array.from({ length: 3_000_000 }, (_, i) => ({ n: i, at: 0 })) } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 1100 })
  expect(r.isError).toBe(true)
  expect(r.text).toMatch(/waitFor stopped its wait for `false` to exit 0 after \d+ attempts/)
  expect(r.text).toContain("the host's time budget for one hook is nearly spent")
  expect(r.text).toContain('ms are left of 10000 ms')
  expect(r.text).toContain('Repair: call waitFor again')
  expect(w.state()?.state).toBe('developing')
})

// Without an answer the agent reads only "no tool.call hook answered this call", as it does when a hook runs past its budget.
test('a workflow tool whose hook the host drops still answers, with the tool, the cause and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The hook reads the clock before its own error handling starts, and again inside it.
  Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
  const r = await tool($, 'waitFor', { shell_command: 'false' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('workflow waitFor gave no answer')
  expect(r.text).toContain('its hook failed outside its own error handling')
  expect(r.text).toContain('clock.now')
  expect(r.text).toContain('Repair: call status and read the state, then call waitFor again')
})
