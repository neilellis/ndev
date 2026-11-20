import { expect, test } from './sdk-testing'
import { command, engine, start, tool } from './workflow-harness'

for (const name of ['command', 'checkpoint', 'waitForSeconds', 'epicStatus']) {
  test(`${name} behind a held turn answers after more than a hook budget of process pauses`, { timeoutMs: 60_000 }, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.staged = true
    w.s.sleepAdvances = true
    let release!: () => void
    w.s.checkHold = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { w.s.onCheck = resolve })
    const first = tool($, 'checkpoint', { message: 'first', files: ['a.ts'] })
    await entered
    const began = w.s.now
    let pauses = 0
    w.s.onSleep = seconds => {
      if (seconds !== 0.2) return
      pauses += 1
      if (pauses === 60) release()
    }
    const watchdog = setTimeout(release, 15_000)
    try {
      const response = name === 'command' ? await command($, 'status') : (await tool($, name, name === 'checkpoint' ? { message: 'second', files: ['a.ts'] } : { secs: 1 })).text
      expect(pauses).toBeGreaterThanOrEqual(60)
      expect(w.s.now - began).toBeGreaterThanOrEqual(12_000)
      expect(response).not.toContain('no tool.call hook')
      expect(response).not.toContain('failed')
      expect(response).toMatch(name === 'epicStatus' ? /epic/i : /developing/)
      expect((await first).isError).toBe(false)
    } finally {
      clearTimeout(watchdog)
      release()
      await first
    }
  })
}

test('a command names the command and the process failure when waiting for a turn fails', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staged = true
  let release!: () => void
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { w.s.onCheck = resolve })
  const first = tool($, 'checkpoint', { message: 'first', files: ['a.ts'] })
  await entered
  w.s.sleepFails = 'sleep: queue pause unavailable'
  try {
    expect(await command($, 'status')).toContain('/flow status failed: no implementation for process.run')
  } finally {
    w.s.sleepFails = ''
    release()
    await first
  }
})

test('simultaneous commands recheck the queue before taking a turn', { timeoutMs: 60_000 }, async ($, on) => {
  const w = engine(on)
  await start($, w)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  w.s.onRead = path => path.endsWith('/kb/workflow.md') ? held : undefined
  let pauses = 0
  w.s.onSleep = seconds => {
    if (seconds === 0.2 && ++pauses === 60) release()
  }
  const watchdog = setTimeout(release, 15_000)
  const first = command($, 'guide')
  const second = command($, 'status')
  try {
    const [guide, status] = await Promise.all([first, second])
    expect(guide).toContain('# The guide')
    expect(status).toContain('developing')
    expect(pauses).toBeGreaterThanOrEqual(60)
  } finally {
    clearTimeout(watchdog)
    release()
    await Promise.all([first, second])
  }
})

test('a wait does not start a new turn when a stale save consumed its deadline', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 1
  w.s.staleSaveMs = 2000
  const before = w.s.saves
  const result = await tool($, 'waitForSeconds', { secs: 1, timeout: 1 })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('did not start its wait')
  expect(result.text).toContain('timeout of 1 s')
  expect(result.text).toContain('Repair: call it again when they end')
  expect(w.s.saves - before).toBe(1)
  expect(w.state()?.state).toBe('developing')
})
