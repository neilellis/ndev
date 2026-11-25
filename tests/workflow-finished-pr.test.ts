import { expect, test } from './sdk-testing'
import { engine, start, tool } from './workflow-harness'

test('issue 26: started moves a conflicted finished PR to revising without an idle owner', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const w = engine(on, { wf: { state: 'done', owner: undefined }, pr: { mergeable: false } })
  await start($, w)
  await $.turn.start({ text: 'Resume the finished PR', turnId: 'resume-26' })
  const result = await tool($, 'started', { issue: 7 })
  expect(result.isError).toBe(false)
  expect(w.state()?.state).toBe('revising')
  expect(w.state()?.history.some(entry => entry.tool === 'started' && entry.from === 'done' && entry.to === 'revising')).toBe(true)
  expect(result.text).toContain('PR #12')
  expect(result.text).toContain('conflicts')
  expect(result.text).toContain('origin/main')
  expect(result.text).toContain('checkpoint')
})

for (const mergeable of [null, true]) {
  test(`issue 26: started keeps a finished PR done when mergeability is ${mergeable}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'done', owner: undefined }, pr: { mergeable } })
    await start($, w)
    const result = await tool($, 'started', { issue: 7 })
    expect(result.isError).toBe(false)
    expect(w.state()?.state).toBe('done')
    expect(w.state()?.history.some(entry => entry.from === 'done' && entry.to === 'revising')).toBe(false)
  })
}
