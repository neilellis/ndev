// Workflow tests: started, the first commits, done, an issue closed or merged outside the workflow, and the turn-end reminders. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { ROOT, CHECKS, engine, settle, start, tool, command, turnEnds, finishing, alreadyFixed } from './workflow-harness'

// ---- started ----
test('started opens the workflow and answers with the next step', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.prs).toEqual([12])
  expect(r.text).toContain('State: developing')
})

test('started loads the skill of the mode into its answer, with the plugin path filled in', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.text).toContain('# The work-light method')
  expect(r.text).toMatch(/Run `\/\S*\/scripts\/x\.sh`\./)
  expect(r.text).toMatch(/relative paths start at \/\S*\/skills\/work-light\./)
  expect(r.text).not.toContain('the listing')
  expect(r.text).not.toContain('CLAUDE_PLUGIN_ROOT')
  expect(r.text).not.toContain('work-heavy method')
})

test('started loads the heavy skill for a heavy issue, and the board skills never', async ($, on) => {
  const w = engine(on, { wf: null, config: { steering: 'auto' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub', mode: 'heavy' })
  expect(r.text).toContain('# The work-heavy method')
  expect(r.text).not.toContain('work-heavy-auto')
  expect(r.text).not.toContain('work-light method')
})

test('started loads a skill once in a session, and again after a compaction', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const again = await tool($, 'started', { issue: 7 })
  expect(again.isError).toBe(false)
  expect(again.text).not.toContain('# The work-light method')
  await $.session.compact({ instructions: 'keep it', messages: [{ role: 'user', text: 'the talk', toolUses: [] }] } as never)
  const after = await tool($, 'started', { issue: 7 })
  expect(after.text).toContain('# The work-light method')
})

test('started names the repair when it cannot read the skill, and the workflow still starts', async ($, on) => {
  const w = engine(on, { wf: null, skillFiles: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(r.text).toMatch(/\/skills\/work-light\/SKILL\.md has no text/)
  expect(r.text).toContain('Skill tool')
  expect(r.text).toContain('ndev:work-light')
})

test('started goes to setup when a check script is missing, and names them', async ($, on) => {
  const w = engine(on, { wf: null, scripts: false })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.state()?.state).toBe('setup')
  expect(r.text).toContain('pre-commit-check.sh')
})

test('started refuses in a project that turned the workflow off', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow on project')
  expect(w.state()).toBeUndefined()
})

test('a tool called with no workflow refuses and names started', async ($, on) => {
  engine(on, { wf: null })
  await start($)
  const r = await tool($, 'checkpoint', { message: 'x', files: ['a'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Call started')
})

test('a helper cannot move the workflow', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'blocked', { message: 'stop', agentId: 'helper-1' })
  expect(r.isError).toBe(true)
  expect(w.state()?.state).toBe('developing')
})

// ---- commit and push ----
test('finishedDevelopment commits the named files and moves on', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = []
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('reviewing')
})

// #656 in fcc-proto: a turn-end reminder saved the issue record while the checks of finishedDevelopment ran,
// and the save after the checks failed with "set-workflow exited 5 ... at revision 58, and this writer expected 57".
test('finishedDevelopment commits once and moves on when another writer saves the record while its checks run', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  let release = () => {}
  w.s.checkHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  await settle()
  // Another session or hook saves the record during the checks, as set-workflow does: one revision more.
  const at = `${ROOT}/.neil-dev.issue-7.json`
  const file = JSON.parse(w.files.get(at)!) as { workflow: Record<string, unknown> }
  w.files.set(at, JSON.stringify({ ...file, workflow: { ...file.workflow, rev: Number(file.workflow.rev ?? 0) + 1, otherWriter: 'kept' } }))
  release()
  const r = await call
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
  expect(w.commits).toHaveLength(1)
  expect(w.state()?.state).toBe('reviewing')
  expect(w.issueRecord(7)?.otherWriter).toBe('kept')
})

test('finishedDevelopment names its retries when another writer changes the record each time', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staleSaves = 99
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the thing', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 5')
  expect(r.text).toContain('finishedDevelopment read the record again 3 times')
  expect(r.text).toContain('Ndev-Op')
})

test('finishedDevelopment takes a new file in an untracked folder when the file is named', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/page.tsx'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
})

for (const [name, args] of [['checkpoint', {}], ['finishedDevelopment', { prs: [12] }]] as const) {
  test(`${name} commits a named file whose deletion git rm already staged`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.dirty = ['D  sql/old.test.sql', ' M a.ts']
    w.s.removed = ['sql/old.test.sql']
    const r = await tool($, name, { ...args, message: 'Drop the old test', files: ['sql/old.test.sql', 'a.ts'] })
    expect(r.text).not.toContain('pathspec')
    expect(r.isError).toBe(false)
    expect(w.commits.length).toBe(1)
  })
}

for (const [name, args] of [['checkpoint', {}], ['finishedDevelopment', { prs: [12] }]] as const) {
  test(`${name} commits a staged rename and a staged deletion when both old paths are named`, async ($, on) => {
    const w = engine(on)
    await start($, w)
    w.s.dirty = ['D  src/report-inputs.ts', 'RM test/report-inputs.test.ts -> test/report-block.test.ts']
    w.s.removed = ['src/report-inputs.ts']
    w.s.renamedFrom = ['test/report-inputs.test.ts']
    const r = await tool($, name, { ...args, message: 'Rename the test', files: ['src/report-inputs.ts', 'test/report-inputs.test.ts', 'test/report-block.test.ts'] })
    expect(r.text).not.toContain('pathspec')
    expect(r.isError).toBe(false)
    expect(w.commits.length).toBe(1)
  })
}

test('finishedDevelopment refuses the one unnamed file of an untracked folder, and names that file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx', 'apps/new/secret.txt']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/page.tsx'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('these changed files are not named: apps/new/secret.txt.')
  expect(w.commits.length).toBe(0)
})

test('finishedDevelopment still takes an untracked folder when the folder is named', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.untracked = ['apps/new/page.tsx', 'apps/new/layout.tsx']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add the page', files: ['apps/new/'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
})

test('a failed check script stops the commit and names script, exit code and output', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-commit-check'
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('pre-commit-check.sh exited 3')
  expect(r.text).toContain('lint: broken line')
  expect(w.commits.length).toBe(0)
  expect(w.pushes.length).toBe(0)
  expect(w.state()?.state).toBe('developing')
})

test('a tool refuses while a helper still runs, because its edits could enter the commit', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.agents = [{ id: 'a1', status: 'running' }]
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(w.commits.length).toBe(0)
})

// ---- ready ----
test('finishedReview marks a draft PR ready with its one GraphQL mutation', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, pr: { draft: true } })
  await start($, w)
  const r = await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('ci')
  expect(w.ready.length).toBe(1)
  expect(w.ready[0]).toContain('pr-ready 12')
})

test('finishedReview makes no GraphQL call for a PR that is already ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(w.ready.length).toBe(0)
})

test('done refuses with a dirty tree and lists every problem', async ($, on) => {
  const w = engine(on, { wf: finishing(), checks: CHECKS({ name: 'ci', conclusion: 'failure' }) })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('Red checks on HEAD: ci (failure)')
  expect(w.state()?.state).toBe('finishing')
})

test('done passes when the tree, the checks and the evidence are clean', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
})

test('done refuses stale evidence', async ($, on) => {
  const w = engine(on, { wf: finishing({ evidence: { checks: { sha: 'old', text: 'green' } } }) })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedChecks has no record for HEAD')
  expect(w.state()?.state).toBe('finishing')
})

test('done at small_project leaves the merge to the human', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'small_project' } })
  await start($, w)
  await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(w.state()?.state).toBe('done')
  expect(w.merges).toEqual([])
})

test('done at poc merges the PR', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'poc' } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'none: nothing durable' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual(['12'])
  expect(r.text).toContain('PR #12 is merged')
})

test('done in development ends the workflow of an issue that was closed with no change', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: [] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed on main by e22097f9', remembered: 'nothing: no change' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.doneMessage).toBe('already fixed on main by e22097f9')
  // Nothing waits for a human: Orca and the board show the issue as complete.
  expect(w.state()?.closedNoChange).toBe(true)
})

test('done in development refuses while the issue is open, and says why', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: [] })
  await start($, w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('issue #7 is open')
  expect(w.state()?.state).toBe('developing')
})

test('done in development refuses a branch that holds a change', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', draft: true }, names: ['a.ts'] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(r.text).toContain('finishedDevelopment')
  expect(w.state()?.state).toBe('developing')
})

// fcc-proto #465: PR #793 merged by hand with its issues closed, and done refused because the squashed branch
// still differs from main. A merged PR is the end of the work, whatever the branch holds.
test('done in development ends an issue whose PR merged outside the workflow', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: true }, names: ['a.ts'] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'merged by hand as b366d05e', remembered: 'nothing: merged by hand' })
  expect(r.text).not.toContain('Not done')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(r.text).toContain('PR #12 is already merged')
  expect(r.text).not.toContain('closed with no change')
})

test('done in development refuses while the draft PR is open, and names the repair', async ($, on) => {
  const w = engine(on, { pr: { draft: true }, names: [] })
  await start($, w)
  alreadyFixed(w)
  const r = await tool($, 'done', { message: 'already fixed', remembered: 'nothing: no change' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('gh pr close 12')
  expect(w.state()?.state).toBe('developing')
})

// ---- blocked ----
test('blocked raises the alert, and unblocked withdraws it and restores the state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const b = await tool($, 'blocked', { message: 'Which database?' })
  expect(b.isError).toBe(false)
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
  const u = await tool($, 'unblocked', { message: 'Postgres' })
  expect(u.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.alerts).toEqual(['raise', 'withdraw'])
})

// ---- like /goal: the turn end ----
test('a turn that ends before done gets the next step, with no GitHub call', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('in the state "developing"')
  expect(w.gh).toEqual([])
})

test('a turn end says nothing when blocked, done, typed over, aborted or a helper runs', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await turnEnds($, 'aborted')
  w.s.draft = 'I am typing'
  await turnEnds($)
  w.s.draft = ''
  w.s.agents = [{ id: 'a1', status: 'running' }]
  await turnEnds($)
  w.s.agents = []
  await tool($, 'blocked', { message: 'help' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
})

// The turn-end handlers before the reminder can take seconds on a loaded machine. A queued prompt (a
// plugin message) can start the next turn meanwhile, and the turn end of the old turn must not mark it
// as ended: the reminder of #485 said "interviewing" one turn late, after blocked had moved it.
test('a turn that starts while the earlier turn-end handlers run gets no stale reminder queued behind it', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const w = engine(on)
  await start($, w)
  w.s.duringTurnEnd = () => $.turn.start({ text: 'The ndev plugin sent a message', turnId: 't2' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(await command($, 'status')).toContain('quiet: the turn t2 started before the end of the turn t1 was checked')
})

// The host queues a prompt that comes while a turn runs, and gives it to the model only when that turn
// ends: the reminder of PR #444 said "reviewing" 44 minutes later, after finishedReview had moved it to ci.
test('a turn that starts while the turn-end reminder is built gets no stale reminder queued behind it', async ($, on) => {
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const w = engine(on)
  await start($, w)
  // A queued prompt (a review's answer) starts the next turn while the reminder reads the worktree.
  w.s.duringDiff = () => $.turn.start({ text: 'the review has ended', turnId: 't2' })
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(await command($, 'status')).toContain('a turn started before the reminder')
})

// The host holds a plugin's prompt until the session is idle. In analytics PR #2769 the reviews' answers started
// a turn just as the reminder went out, and that turn ran for two hours: blocked was called in it, and then
// the model read "reviewing". Nothing can take the prompt back, so the turn that it starts is cancelled.
test('a reminder that the host delivers after the state moved cancels its own turn before the model reads it', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  expect(w.prompts.length).toBe(1)
  // Another prompt got in first, and its turn blocks the workflow.
  await $.turn.start({ text: 'the review has ended', turnId: 't2' })
  await tool($, 'blocked', { message: 'help' })
  await $.turn.complete({ reason: 'answer', answer: 'text', durationMs: 1, isAborted: false, turnId: 't2' } as never)
  await settle()
  expect(w.prompts.length).toBe(1)
  await $.turn.start({ text: `The ndev plugin sent a message:\n${w.prompts[0]}`, turnId: 't3' })
  expect(aborted).toEqual(['t3'])
  const status = await command($, 'status')
  expect(status).toContain('named the state "developing"')
  expect(status).toContain('is now in the state "blocked"')
})

// In lens PR #315 a reminder for "reviewing" was queued on 11 Nov by a plugin process that kept no record of
// it, and the host delivered it 41 hours later, after a restart, when finishedReview had moved the PR to ci.
// The record of sent reminders did not hold it, so the turn was not cancelled. The words of the reminder name the state.
test('a reminder with no record of its sending is cancelled when the state it names no longer holds', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  expect(w.state()?.state).toBe('developing')
  const old = 'The workflow is not finished, so the turn does not end here. issue #7 is in the state "reviewing". Review: your last commit is not pushed yet. Do not end the turn before you call done or blocked.'
  await $.turn.start({ text: `The ndev plugin sent a message:\n${old}`, turnId: 't2' })
  expect(aborted).toEqual(['t2'])
  const status = await command($, 'status')
  expect(status).toContain('named the state "reviewing"')
  expect(status).toContain('is now in the state "developing"')
  // The same words with the state that holds start their turn.
  await $.turn.start({ text: `The ndev plugin sent a message:\n${old.replace('"reviewing"', '"developing"')}`, turnId: 't3' })
  expect(aborted).toEqual(['t2'])
})

test('a reminder that the host delivers while its state still holds starts its turn', async ($, on) => {
  const aborted: string[] = []
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const w = engine(on)
  await start($, w)
  await turnEnds($)
  await $.turn.start({ text: `The ndev plugin sent a message:\n${w.prompts[0]}`, turnId: 't2' })
  // A turn with other words is never cancelled, whatever the state.
  await tool($, 'blocked', { message: 'help' })
  await $.turn.start({ text: 'the human typed this', turnId: 't3' })
  expect(aborted).toEqual([])
})

test('three turn ends with no progress reach the human as a block', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (let i = 0; i < 4; i++) await turnEnds($)
  expect(w.prompts.length).toBe(3)
  expect(w.state()?.state).toBe('blocked')
  expect(w.alerts).toEqual(['raise'])
})

test('progress resets the count of reminders', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (let i = 0; i < 3; i++) await turnEnds($)
  w.s.sha = 'cccc'
  await turnEnds($)
  expect(w.state()?.state).toBe('developing')
  expect(w.prompts.length).toBe(4)
})
