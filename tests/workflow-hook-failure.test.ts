import { expect, test } from './sdk-testing'
import { engine, liveFile, settle, start, tool } from './workflow-harness'

for (const [name, args, target, liveName] of [
  ['waitFor', { issue: 7, shell_command: 'false' }, 'issue #7', 'issue-7'],
  ['waitForPR', { issue: 7, pr: 31 }, 'issue #7', 'issue-7'],
  ['followUp', { issue: 7, mode: 'issue_only', message: 'Repair the hook', agentId: 'helper-1' }, 'issue #7', 'issue-7'],
  ['checkpoint', { pr: 12, message: 'Repair', files: ['a.ts'] }, 'PR #12', 'pr-12'],
] as const) {
  test(`${name} hook failure names its target and persists the cause for ${liveName}`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
    const result = await tool($, name, args)
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain(`workflow ${name} gave no answer`)
    expect(result.text).toContain(target)
    expect(result.text).toContain('throw')
    expect(result.text).toContain('clock.now')
    expect(result.text).toContain(`Repair: call status and read the state, then call ${name} again`)
    const calls = liveFile(w, liveName)?.calls ?? []
    expect(calls.some(call => call.tool === name && call.outcome === 'failed' && call.note?.includes('clock.now'))).toBe(true)
  })
}


test('a dropped running call closes its own live entry and leaves no running receipt', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staged = true
  let release!: () => void
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const pending = tool($, 'checkpoint', { issue: 7, message: 'change', files: ['a.ts'] })
  await settle()
  expect(liveFile(w, 'issue-7')?.calls?.some(call => call.tool === 'checkpoint' && call.outcome === 'running')).toBe(true)
  Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
  release()
  expect((await pending).isError).toBe(true)
  const calls = liveFile(w, 'issue-7')?.calls?.filter(call => call.tool === 'checkpoint') ?? []
  expect(calls.length).toBe(1)
  expect(calls[0]?.outcome).toBe('failed')
  expect(calls[0]?.note).toContain('clock.now')
})


test('a body failure without target arguments names and logs the bound issue', async ($, on) => {
  const w = engine(on)
  await start($, w)
  Object.defineProperty(w.s, 'now', { get: () => { throw new Error('the clock broke') } })
  const result = await $.tool.call({ tool: 'mcp__ndev__status' } as never) as { result: string; isError?: boolean }
  expect(result.isError).toBe(true)
  expect(result.result).toContain('issue #7')
  expect(result.result).toContain('kind=throw')
  expect(result.result).toContain('clock.now')
  expect(result.result).toContain('Repair: call status')
  expect(liveFile(w, 'issue-7')?.calls?.some(call => call.tool === 'status' && call.outcome === 'failed')).toBe(true)
})
