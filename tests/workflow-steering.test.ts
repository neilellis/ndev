// Workflow tests: Steering and mode, and the copy editor. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { strictest } from '../hooks/workflow/tools'
import { ROOT, RECORD, flow, held, engine, settle, start, tool, command, hookCall, seven, twelve, toReview, PROSE, NOT_PROSE, EDITING, live, INTERVIEW_FILE, human } from './workflow-harness'

test('/flow steering sets one issue, and that issue then follows it over the worktree', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'auto' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  const said = await command($, 'steering interactive')
  expect(said).toContain('issue #7')
  expect(w.state()?.steering).toBe('interactive')
  expect((await tool($, 'status', {})).text).toContain('Report this checkpoint')
})

test('/flow mode names the issue, refuses a bad value, and shows the setting with no value', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  expect(await command($, 'mode medium')).toContain('"medium"')
  expect(await command($, 'mode heavy 7')).toContain('issue #7')
  expect(w.state()?.mode).toBe('heavy')
  expect(await command($, 'mode')).toContain('heavy')
  expect(await command($, 'mode light 99')).toContain('#99')
})

test('a PR follows the strictest of its issues: heavy over light, interactive over auto', () => {
  expect(strictest([{ mode: 'light', steering: 'auto' }, { mode: 'heavy', steering: 'interactive' }])).toEqual({ mode: 'heavy', steering: 'interactive' })
  expect(strictest([{ mode: 'light' }, { steering: 'auto' }])).toEqual({ mode: 'light', steering: 'auto' })
  expect(strictest([{}, {}])).toEqual({})
})

test('the PR record takes the settings of its issues, and /flow mode then sets the PR', async ($, on) => {
  const w = engine(on, { wf: flow({ mode: 'heavy', steering: 'auto' }) })
  await start($, w)
  w.s.dirty = []
  await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('auto')
  expect(await command($, 'mode light')).toContain('PR #12')
  expect(w.prRecord(12)?.mode).toBe('light')
})

test('a PR of two issues is heavy and interactive when one issue is heavy and the other is interactive', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light', steering: 'auto' }), twelve({ mode: 'heavy', steering: 'interactive' })))
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('interactive')
  expect(w.issueRecord(7)?.mode).toBe('light')
})

// ---- found by the independent review ----
test('finishedDevelopment follows the strictest issue, also when the active issue is the light one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light' }), twelve({ mode: 'heavy' })))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.spawns).toHaveLength(2)
})

test('gates.sh runs for the heavy issue of a PR, not only when the lead is heavy', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ mode: 'light' }), twelve({ mode: 'heavy' })))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  w.s.failCheck = 'gates'
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('for #12')
})

test('the strictest of a PR counts an issue that inherits its settings', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, config: { mode: 'heavy', steering: 'interactive' } })
  w.files.set(RECORD, held(seven({ mode: 'light', steering: 'auto' }), twelve()))
  await start($, w)
  const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(r.isError).toBe(false)
  expect(w.prRecord(12)?.mode).toBe('heavy')
  expect(w.prRecord(12)?.steering).toBe('interactive')
})

test('a PR whose issues have no settings of their own stores none, so it follows the worktree', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
  await start($, w)
  await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
  expect(w.prRecord(12)?.mode).toBeUndefined()
  expect(w.prRecord(12)?.steering).toBeUndefined()
})

test('the end of a wait follows the steering of the issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', steering: 'auto' }, config: { steering: 'interactive' } })
  await start($, w)
  w.s.sleepAdvances = true
  const r = await tool($, 'waitForSeconds', { secs: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Continue without waiting')
  expect(r.text).not.toContain('Report this checkpoint')
})

// A session in a worktree cannot change its folder to the main checkout, so started claims the new
// worktree from the main checkout for it, and the merged PR gets nothing new.
for (const owner of [undefined, { session: 'other', at: 0 }]) {
  test(`started in a worktree whose PR has merged claims a new worktree from the main checkout (${owner ? 'another session' : 'this session'})`, async ($, on) => {
    const w = engine(on, { wf: { state: 'done', ...(owner ? { owner } : {}) }, pr: { state: 'closed', merged: true } })
    await start($, w)
    const r = await tool($, 'started', { issue: 9, shortName: 'new-thing' })
    expect(r.text).not.toContain('Refused')
    expect(r.isError).toBe(false)
    expect(w.s.claims).toEqual(['/main 9 origin/main'])
    expect(r.text).toContain('/claimed/issue-7')
    expect(w.issueRecord(9)).toBeUndefined()
  })
}

test('followUp this_agent refuses when the PR has merged, and files no issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' }, pr: { state: 'closed', merged: true } })
  await start($, w)
  const r = await tool($, 'followUp', { mode: 'this_agent', message: 'A new thing' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('PR #12')
  expect(r.text).toContain('issue_only')
  expect(w.gh.some(line => line.includes('issue-new'))).toBe(false)
})

for (const args of ['skip because', 'goto reviewing because']) {
  test(`/flow ${args} refuses on one issue of a shared PR`, async ($, on) => {
    const w = engine(on, { wf: { state: 'developing' } })
    w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    await tool($, 'started', { issue: 7 })
    const said = await command($, args)
    expect(said).toContain('#12')
    expect(said).toContain('finishedDevelopment')
    expect(w.issueRecord(7)?.state).toBe('developing')
  })
}

test('/flow skip still moves one issue alone on its PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await command($, 'skip because')
  expect(w.state()?.state).toBe('reviewing')
})

test('/flow goto back to planning stays allowed on a shared PR', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await command($, 'goto planning because')
  expect(w.issueRecord(7)?.state).toBe('planning')
})

test('a raw git push is refused in a worktree of several records when this session owns none', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven(other), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).toContain('checkpoint')
})

test('a raw git push passes when each record of the worktree is done', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { state: 'done', owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven(other), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).not.toContain('checkpoint')
})

test('a raw git push is refused when one record is done and another is open, and this session owns neither', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  const other = { owner: { session: 'other', at: 0 } }
  w.files.set(RECORD, held(seven({ ...other, state: 'done' }), twelve(other)))
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'git push origin HEAD' })
  expect(JSON.stringify(r)).toContain('issue #12')
})

test('the map names each issue on the PR before the PR record exists, with the types of all of them', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven({ changeTypes: ['database'] }), twelve()))
  await start($, w)
  await tool($, 'started', { issue: 12 })
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { issue: 12, message: 'm', files: ['a.ts'] })
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!)![1]!)
  expect(Object.keys(map.issues)).toEqual(['7', '12'])
  expect(map.issues['12'].changeTypes).toContain('database')
})

test('a change with prose for users starts the copy editor beside the code review, on those files only', async ($, on) => {
  const w = engine(on, { names: [...PROSE, ...NOT_PROSE] })
  const r = await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer', 'ndev:copy-editor'])
  const prompt = w.spawns[1]!.prompt
  for (const p of PROSE) expect(prompt).toContain(p)
  for (const p of NOT_PROSE) expect(prompt).not.toContain(p)
  expect(w.spawns[1]!.cwd).toBe(ROOT)
  expect(r.text).toContain('copy editor')
  expect(w.state()?.reviewCopy).toBeDefined()
})

test('a change with no prose for users starts no copy editor', async ($, on) => {
  const w = engine(on, { names: NOT_PROSE })
  const r = await toReview($, w)
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
  expect(r.text).not.toContain('copy editor')
})

test('the answer of the copy editor reaches the main agent in its own words, and the record keeps it', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', prs: [12], hooks: { review: { firedAt: 1, agentId: 'reviewer-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  await start($, w)
  await $.turn.complete({ agentId: 'copy-1', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\n1. A slogan.' } as never)
  await settle()
  expect(w.state()?.reviewCopy?.answer).toContain('A slogan')
  expect(w.prompts.join('\n')).toContain('The copy edit of')
  expect(w.prompts.join('\n')).toContain('A slogan')
})

test('a copy editor that did not start is named, and the repair names the files', async ($, on) => {
  const w = engine(on, { names: PROSE })
  w.s.spawnDeny = 'no such agent'
  const r = await toReview($, w)
  expect(r.text).toContain('The copy editor did not start: no such agent')
  expect(r.text).toContain('ndev:copy-editor')
  expect(r.text).toContain(PROSE[0]!)
})

test('a list of changed files that fails tells the agent why the copy editor did not start', async ($, on) => {
  const w = engine(on, { names: PROSE })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.copyDiffFails = 'bad revision'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.text).toContain('The copy editor did not start')
  expect(r.text).toContain('exited 128')
  expect(r.text).toContain('bad revision')
})

test('a resume starts only the copy editor when only its answer was lost', async ($, on) => {
  const w = engine(on, { names: PROSE, wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1', answer: 'code is fine' } }, reviewCopy: { agentId: 'gone' } } as never })
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:copy-editor'])
  expect(said).toContain('code is fine')
})

test('a resume starts only the code review when the copy editor still runs', async ($, on) => {
  const w = engine(on, { names: PROSE, wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'gone' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  w.s.agents = [live('copy-1')] as never
  await start($, w)
  const said = (await tool($, 'started', { issue: 7 })).text
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
  expect(w.state()?.reviewCopy?.agentId).toBe('copy-1')
  expect(said).toContain('copy-1')
})

test('a resume takes a reviewer that has ended, with no answer, as lost', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } } } as never })
  w.s.agents = [live('r-1', 'completed')] as never
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect(w.spawns.map(s => s.subagentType)).toEqual(['ndev:diff-reviewer'])
})

test('a copy editor that did not start stays on the record, and a resume tries it again', async ($, on) => {
  const w = engine(on, { names: PROSE })
  w.s.spawnDeny = 'no such agent'
  await toReview($, w)
  expect((w.state()?.reviewCopy as { failed?: string }).failed).toContain('no such agent')
  const tries = w.spawns.filter(s => s.subagentType === 'ndev:copy-editor').length
  w.s.spawnDeny = ''
  await tool($, 'started', { issue: 7 })
  expect(w.spawns.filter(s => s.subagentType === 'ndev:copy-editor').length).toBe(tries + 1)
  expect((w.state()?.reviewCopy as { failed?: string }).failed).toBeUndefined()
})

test('an answer survives a stale write', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
  await start($, w)
  w.s.staleSaves = 1
  await $.turn.complete({ agentId: 'copy-1', answer: 'VALE: ran, 0 alerts\nFINDINGS: 1\nA slogan.' } as never)
  await settle()
  expect(w.state()?.reviewCopy?.answer).toContain('A slogan')
  expect(w.prompts.join('\n')).toContain('A slogan')
})

test('an answer that cannot be saved still reaches the main agent, which is told', async ($, on) => {
  const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } } } as never })
  await start($, w)
  w.s.staleSaves = 99
  await $.turn.complete({ agentId: 'r-1', answer: 'A real fault.' } as never)
  await settle()
  w.s.staleSaves = 0
  const told = w.prompts.join('\n')
  expect(told).toContain('A real fault.')
  expect(told).toContain('was not saved')
  expect(told).toContain('exited 5')
})

for (const [name, ending] of [['an empty answer', { answer: '  ' }], ['an error', { reason: 'error', answer: 'part of a rep' }]] as const) {
  test(`a reviewer that ends with ${name} is named as a failure, and does not count as an answer`, async ($, on) => {
    const w = engine(on, { wf: { ...EDITING, hooks: { review: { firedAt: 1, agentId: 'r-1' } }, reviewCopy: { agentId: 'copy-1' } } as never })
    await start($, w)
    await $.turn.complete({ agentId: 'copy-1', ...ending } as never)
    await settle()
    expect(w.state()?.reviewCopy?.answer).toBeUndefined()
    const told = w.prompts.join('\n')
    expect(told).toContain('The copy editor')
    expect(told).toContain('failed')
    expect(told).toContain('ndev:copy-editor')
  })
}

test('started asks first under interactive steering, and goes past the interview under auto', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'heavy', steering: 'interactive' } })
  await human($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  expect(w.state()?.prs).toEqual([12])
  expect(r.text).toContain('ndev:interview')
  expect(w.files.get(`/main/.git/info/exclude`)).toContain('.neil-dev.issue-*.json')
})

test('the answers and the record share the issue file, and neither writer loses the other', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light', steering: 'interactive' } })
  await human($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('interviewing')
  const r = await tool($, 'interview')
  expect(r.isError).toBe(false)
  const held = JSON.parse(w.files.get(INTERVIEW_FILE)!)
  expect(held.closed?.asked).toBe(false)
  expect(held.rounds).toEqual([])
  expect(held.workflow.state).toBe('developing')
  expect(w.state()?.state).toBe('developing')
})
