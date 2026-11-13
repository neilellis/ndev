// Workflow tests: done, merges, retries of a commit and issue ownership. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { ROOT, RECORD, flow, held, engine, start, tool, command, turnEnds, finishing, inOrca, bodyFile, seven, twelve } from './workflow-harness'

test('done records the remember result', async ($, on) => {
  const w = engine(on, { wf: finishing() })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'wiki page updated' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('done')
  expect(w.state()?.hooks?.remember?.result).toBe('wiki page updated')
})

test('a formal_project does not skip the remember hook', async ($, on) => {
  const w = engine(on, { wf: finishing(), config: { projectLevel: 'formal_project' } })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'skipped: no time' })
  expect(r.isError).toBe(true)
  expect(w.state()?.state).toBe('finishing')
})

test('a return from blocked does not fire a hook again', async ($, on) => {
  const w = engine(on, { wf: { state: 'blocked', previous: 'reviewing', blocked: { message: 'm', at: 1, group: 'g' }, hooks: { review: { firedAt: 111 } } } })
  await start($, w)
  await tool($, 'unblocked', { message: 'answered' })
  expect(w.state()?.state).toBe('reviewing')
  expect(w.state()?.hooks?.review?.firedAt).toBe(111)
})

test('a human move into a stage fires its hook too', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await command($, 'skip')
  expect(w.state()?.state).toBe('reviewing')
  expect(w.state()?.hooks?.review?.firedAt).toBeDefined()
})

test('after a human skips the review, finishedChecks names the held commit and how to push it', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' } })
  await start($, w)
  w.s.sha = 'cccc'
  await command($, 'skip no time')
  expect(w.state()?.state).toBe('ci')
  const r = await tool($, 'finishedChecks')
  expect(r.isError).toBe(true)
  expect(r.text).toContain('checkpoint')
  expect(r.text).toContain('no files')
})

// ---- from the human's own messages: what they had to type, and now need not ----
test('each next step says that a question for the human goes through blocked', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('call blocked')
  expect(r.text).toContain('already allows')
})

test('the turn-end reminder says to wait in the foreground', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await turnEnds($)
  expect(w.prompts.at(-1)).toContain('background wait')
})

test('finishing asks that no chore is left for the human', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(r.text).toContain('followUp')
})

test('the smoke step asks for the preview URL in the report', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('preview URL in the report')
})

test('finishedDevelopment names a migration file that addMigration does not list', async ($, on) => {
  const w = engine(on, { names: ['supabase/migrations/20260101_add.sql', 'a.ts'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'finishedDevelopment', { prs: [12], message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('supabase/migrations/20260101_add.sql')
  expect(r.text).toContain('addMigration')
})

test('done refuses a migration file that nothing will run, and names it', async ($, on) => {
  const w = engine(on, { wf: finishing(), names: ['supabase/migrations/20260101_add.sql'] })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Nothing will run')
  expect(r.text).toContain('supabase/migrations/20260101_add.sql')
  expect(w.state()?.state).toBe('finishing')
})

test('done passes a migration file that addMigration lists', async ($, on) => {
  const path = 'supabase/migrations/20260101_add.sql'
  const w = engine(on, { wf: { ...finishing(), migrations: [{ name: 'add', path }] }, names: [path] })
  await start($, w)
  const r = await tool($, 'done', { message: 'finished', remembered: 'nothing: small' })
  expect(r.text).not.toContain('Nothing will run')
})

// ---- from the independent review ----
test('a retry after a failed pre-push commits the fix and pushes it', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-push'
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })).isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  w.s.failCheck = ''
  const r = await tool($, 'checkpoint', { message: 'fix', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(2)
  expect(w.pushes.length).toBe(1)
})

test('a retry with an unnamed fix in the tree pushes nothing and names the file', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-push'
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  w.s.failCheck = ''
  const r = await tool($, 'checkpoint', { message: 'again', files: ['b.ts'].slice(1) })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('a.ts')
  expect(w.pushes.length).toBe(0)
})

test('a retry after a failed push with a clean tree pushes the same commit', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.pushFails = 'rejected'
  await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })
  w.s.pushFails = ''
  w.s.staged = false
  w.s.dirty = []
  const r = await tool($, 'checkpoint', { message: 'one', files: [] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(1)
})

test('a refused commit leaves nothing staged', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.failCheck = 'pre-commit'
  expect((await tool($, 'checkpoint', { message: 'one', files: ['a.ts'] })).isError).toBe(true)
  expect(w.s.staged).toBe(false)
  expect(w.steps).toContain('reset')
})

test('started keeps a finished issue in the record, beside the new one', async ($, on) => {
  const w = engine(on, { wf: { issue: 9, state: 'done', rev: 5, prs: [] } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.issue).toBe(7)
  expect(w.state(9)?.state).toBe('done')
})

test('started on a second issue makes it active in this agent, and the first keeps its state until the agent goes back', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const r = await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #12')
  expect(r.text).toContain(`Other issues in this worktree: #7 ("developing"`)
  expect(w.state()?.state).toBe('developing')
  expect((await tool($, 'status')).text).toContain('Issue #12')
  expect(w.state(12)?.branch).toBe('issue-7')
  const back = await tool($, 'started', { issue: 7 })
  expect(back.text).toContain('State: developing. Issue #7')
  expect((await tool($, 'status')).text).toContain('Issue #7')
})

test('an agent that leaves an issue gives it up, so another agent can take it at once', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(w.state()?.owner).toBeUndefined()
  expect(w.state()?.lastSession).toBe('s1')
  expect(w.state(12)?.owner?.session).toBe('s1')
})

test('a session that Claude Code continued into this one keeps the workflow of the old session, with no takeOver', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'old', at: 0 } } })
  await start($, w)
  // The last line of the old transcript says: continued-in, continuedInSessionId s1.
  w.s.probe = argv => ({ exitCode: 0, stdout: argv.includes('old') ? 's1\n' : '' })
  const r = await tool($, 'blocked', { message: 'need the human' })
  expect(r.text).not.toContain('owns this workflow')
  expect(w.state()?.owner?.session).toBe('s1')
  expect(w.s.probes.join('\n')).toContain('continuedInSessionId')
})

test('a session that no transcript continued into this one is still refused, and the refusal names the check', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'old', at: 0 } } })
  await start($, w)
  w.s.probe = () => ({ exitCode: 0, stdout: 'someone-else\n' })
  const r = await tool($, 'blocked', { message: 'need the human' })
  expect(r.text).toContain('owns this workflow')
  expect(r.text).toContain('continued into')
  expect(w.state()?.owner?.session).toBe('old')
})

test('an issue that another live agent owns in this worktree stays refused', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'other', at: 0 } } })
  await start($, w)
  expect((await tool($, 'started', { issue: 7 })).text).toContain('owns issue #7')
  expect(w.state()?.owner?.session).toBe('other')
})

test('a session that restarts finds the issue it owned among several', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(seven({ owner: { session: 'other', at: 0 } }), twelve({ state: 'ci' })) } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('PR #12')
})

test('a record with several issues and none of this agent\'s shows no workflow, and started picks one', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(seven({ owner: undefined }), twelve({ owner: undefined })) } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('No workflow in this session')
  expect((await tool($, 'started', { issue: 12 })).text).toContain('Issue #12')
})

test('a file with the old workflow key is read, and goes on from its revision', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: JSON.stringify({ version: 2, resources: {}, workflow: flow({ rev: 3 }) }) } })
  await start($, w)
  expect((await tool($, 'started', { issue: 7 })).isError).toBe(false)
  expect(w.state()?.rev).toBeGreaterThan(3)
  expect(JSON.parse(w.files.get(RECORD)!).workflow).toBeUndefined()
})

test('a second issue on an open PR adds its Closes line and keeps the first', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(w.state(12)?.prs).toEqual([12])
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('Closes #7')
  expect(body).toContain('Closes #12')
})

test('finishedPlan keeps the plan and the Closes line of each other issue on the PR', async ($, on) => {
  const plan = 'The plan.\n\nTest entry point: x\n'
  const others = '<!-- ndev:plan:7 -->\nPlan of seven.\nCloses #7\n<!-- /ndev:plan:7 -->\n\nCloses #31\n'
  const w = engine(on, { wf: null, pr: { body: others }, files: { [RECORD]: held(seven({ state: 'developing', owner: undefined, lastSession: 'other' }), twelve({ state: 'planning' })), [`${ROOT}/plan.md`]: plan }, config: { mode: 'heavy' } })
  await start($, w)
  await tool($, 'started', { issue: 12 })
  const r = await tool($, 'finishedPlan', { markdown_file: 'plan.md' })
  expect(r.isError).toBe(false)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('Plan of seven.')
  expect(body).toContain('The plan.')
  expect(body).toContain('Closes #7')
  expect(body).toContain('Closes #12')
  expect(body).toContain('Closes #31')
})

test('a second finishedPlan of one issue replaces its own plan', async ($, on) => {
  const old = '<!-- ndev:plan:7 -->\nOld plan.\nCloses #7\n<!-- /ndev:plan:7 -->\n'
  const w = engine(on, { wf: { state: 'planning' }, pr: { body: old }, files: { [`${ROOT}/plan.md`]: 'New plan.\n\nTest entry point: x\n' }, config: { mode: 'heavy' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  expect((await tool($, 'finishedPlan', { markdown_file: 'plan.md' })).isError).toBe(false)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain('New plan.')
  expect(body).not.toContain('Old plan.')
  expect(body.match(/Closes #7/g)?.length).toBe(1)
})

test('done does not merge a PR while another issue on it is in development', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const record = { version: 2, resources: {}, workflows: { 7: seven({ state: 'developed' }), 12: twelve({ state: 'developing', owner: undefined }) }, prs: { 12: flow({ pr: 12, issues: [7], ...finishing({ hooks: remembered }) }) } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: JSON.stringify(record) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual([])
  expect(r.text).toContain('#12')
})

test('done merges a PR once for all its issues, and marks each of them merged', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: held(seven(finishing({ hooks: remembered })), twelve(finishing({ hooks: remembered, owner: undefined }))) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.isError).toBe(false)
  expect(w.merges).toEqual(['12'])
  expect(w.prRecord(12)!.merged).toBe(true)
  expect(w.issueRecord(7)!.merged).toBe(true)
  expect(w.issueRecord(12)!.merged).toBe(true)
})

test('done leaves the merge to the skill when another issue on the PR has a migration', async ($, on) => {
  const remembered = { remember: { firedAt: 1, result: 'wiki' } }
  const record = { version: 2, resources: {}, workflows: { 7: seven({ state: 'developed', migrations: [{ name: 'add', path: 'supabase/migrations/1_add.sql' }], owner: undefined }), 12: twelve({ state: 'developed' }) }, prs: { 12: flow({ pr: 12, issues: [7, 12], ...finishing({ hooks: remembered }) }) } }
  const w = engine(on, { wf: null, config: { projectLevel: 'poc' }, files: { [RECORD]: JSON.stringify(record) } })
  await start($, w)
  const r = await tool($, 'done', { pr: 12, message: 'm' })
  expect(r.text).toContain('ndev:merge')
  expect(w.merges).toEqual([])
})

test('Orca shows the active issue each time the agent changes issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub', orca: { name: '7-add-sub', issue: 7, status: 'in-progress', comment: 'x', attention: false } } })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect(JSON.stringify(w.orcaCalls.at(-1))).toContain('12')
  await tool($, 'started', { issue: 7 })
  expect(JSON.stringify(w.orcaCalls.at(-1))).toContain('"7"')
})

test('two blocked issues in one worktree have separate notifications', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'blocked', { message: 'first' })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  await tool($, 'blocked', { message: 'second' })
  expect(w.state()?.blocked?.group).not.toBe(w.state(12)?.blocked?.group)
})

test('with setup skipped and no PR, the tools refuse and name started, which opens it', async ($, on) => {
  const w = engine(on, { wf: { state: 'setup', prs: [] } })
  await start($, w)
  await command($, 'skip no scripts yet')
  expect(w.prompts.at(-1)).toContain('call started')
  for (const [name, args] of [['finishedDevelopment', { prs: [], files: [] }], ['checkpoint', { message: 'm', files: ['a.ts'] }]] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Call started')
  }
  expect(w.commits.length).toBe(0)
  expect(await command($, 'goto done')).toContain('has no PR')
  expect((await tool($, 'started', { issue: 7, shortName: 'add-sub' })).isError).toBe(false)
  expect(w.state()?.prs).toEqual([12])
})

test('done refuses a workflow with no PR, which a human skip can leave', async ($, on) => {
  const w = engine(on, { wf: { ...finishing(), prs: [] } })
  await start($, w)
  const r = await tool($, 'done', { message: 'm', remembered: 'nothing: x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Call started')
  expect(w.state()?.state).toBe('finishing')
})

test('a record that holds a workflow is a good record for the stacks and the session start', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(w.toasts.join(' ')).not.toContain('unknown top-level key')
})

test('started takes the base from GitHub when the local origin/HEAD is stale', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.originHead = 'origin/initial-site'
  w.s.branch = 'fix/new-work'
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.state()?.base).toBe('main')
})

test('started refuses and records nothing when GitHub does not say the default branch, and says why', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.defaultBranchFails = 'HTTP 502 from api.github.com'
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('HTTP 502 from api.github.com')
  expect(w.state()).toBeUndefined()
})
