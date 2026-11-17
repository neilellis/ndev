// Workflow tests: followUp from the PR stage, the smoke stage, the map and the live file. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import type { Workflow } from '../hooks/workflow/tools'
import { ROOT, SHA, pull, registeredTools, engine, start, tool, command, finishing, liveFile, live } from './workflow-harness'

test('followUp this_agent from the PR stage sends the PR back, and the agent goes on the new issue', async ($, on) => {
  const w = engine(on, { wf: finishing(), pr: pull() })
    await start($, w)
    const r = await tool($, 'followUp', { mode: 'this_agent', message: 'Sub work' })
    expect(r.text).toContain('This PR now closes')
    expect(r.isError).toBe(false)
    const n = Number(/issues\/(\d+)/.exec(r.text)![1])
    expect(w.prRecord(12)!.state).toBe('developing')
    expect(w.prRecord(12)!.issues).toContain(n)
    expect(w.issueRecord(n)!.state).toBe('developing')
    expect(w.issueRecord(n)!.prs).toEqual([12])
    expect(((await tool($, 'status')).text)).toContain(`Issue #${n}`)
})

test('waitForIssue takes several issues and ends when all of them reach the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
    await start($, w)
    w.s.sleepAdvances = true
    w.s.issueReadsFor = { 9: [{ state: 'closed' }, { state: 'closed' }], 10: [{ state: 'open' }, { state: 'closed' }] }
    const r = await tool($, 'waitForIssue', { waitOn: [9, 10], state: 'closed', period: 60 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('#9')
    expect(r.text).toContain('#10')
    expect(w.s.issueReadsFor[10]).toHaveLength(0)
    expect((await tool($, 'waitForIssue', { waitOn: [], state: 'closed' })).isError).toBe(true)
    expect((await tool($, 'waitForIssue', { waitOn: 9, state: 'closed' })).isError).toBe(true)
})

test('no tool schema lists a name twice under required, which would drop the tool from the model', async ($, on) => {
  const w = engine(on, { wf: null })
    await start($, w)
    const seen = registeredTools as { name: string; inputSchema: { required?: string[] } }[]
    expect(seen.length).toBeGreaterThan(20)
    for (const s of seen) expect(new Set(s.inputSchema.required ?? []).size).toBe((s.inputSchema.required ?? []).length)
    for (const s of seen) for (const r of s.inputSchema.required ?? []) expect(Object.keys((s.inputSchema as unknown as { properties: object }).properties)).toContain(r)
})

for (const types of [['docs'], ['web', 'backend']]) {
  test(`finishedSmoke refuses skipped when the change types hold ${types[0]}, and names the types and the repair`, async ($, on) => {
    const w = engine(on, { wf: { state: 'smoke', changeTypes: types } })
    await start($, w)
    const r = await tool($, 'finishedSmoke', { skipped: 'no preview' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(types[0]!)
    expect(r.text).toContain('/flow skip')
    expect(w.state()?.state).toBe('smoke')
  })
}

test('finishedSmoke still takes skipped when the types hold no web and no docs', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', changeTypes: ['backend'] } })
  await start($, w)
  expect((await tool($, 'finishedSmoke', { skipped: 'nothing to see' })).isError).toBe(false)
  expect(w.state()?.state).toBe('finishing')
})

test('a human /flow skip leaves a required smoke stage, and a later commit of documents does not go back', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', changeTypes: ['docs'], evidence: { checks: { sha: SHA, text: 'green' } } }, names: ['README.md'] })
  await start($, w)
  await command($, 'skip no preview here')
  expect(w.state()?.state).toBe('finishing')
  expect(w.state()?.evidence.smoke?.text).toContain('skipped by the human')
  w.s.dirty = [' M README.md']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(w.state()?.state).toBe('finishing')
})

test('documents only now go to the smoke stage after the checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci', changeTypes: ['docs'] }, names: ['README.md'] })
  await start($, w)
  const r = await tool($, 'finishedChecks')
  expect(w.state()?.state).toBe('smoke')
  expect(r.text).toContain('each changed document')
})

test('a commit of documents in finishing sends a change with no smoke test to the smoke stage', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', changeTypes: ['backend'], evidence: { checks: { sha: SHA, text: 'green' } } }, names: ['README.md'] })
  await start($, w)
  w.s.dirty = [' M README.md']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'docs', files: ['README.md'] })
  expect(w.state()?.state).toBe('smoke')
})

test('a push writes the change map to the PR body before git push, for the sha it pushes', async ($, on) => {
  const w = engine(on, { wf: { changeTypes: ['backend'] }, names: ['app/page.tsx', 'README.md'] })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.pushFails = 'rejected'
  expect((await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], changeTypes: ['database'] })).isError).toBe(true)
  expect(w.pushes.length).toBe(0)
  expect(w.gh.some(line => line.includes('pr-edit 12'))).toBe(true)
  const body = w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!
  expect(body.startsWith('Closes #7\n\n<!-- ndev:change-map ')).toBe(true)
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(body)![1]!)
  expect(map.sha).toBe(w.s.sha)
  expect(map.issues['7'].changeTypes).toEqual(['web', 'backend', 'database', 'docs'])
  expect(map.files).toEqual({ 'app/page.tsx': ['web'], 'README.md': ['docs'] })
})

test('an issue that this PR carries for a followUp is in the map', async ($, on) => {
  const w = engine(on, { wf: { followUps: [{ issue: 9, mode: 'this_agent' }, { issue: 10, mode: 'issue_only' }] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  const map = JSON.parse(/^<!-- ndev:change-map (.*) -->$/m.exec(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)!)![1]!)
  expect(Object.keys(map.issues)).toEqual(['7', '9'])
})

test('a failed write of the map does not stop the push, and the note says that CI runs everything', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.prReadsFor = { 12: ['HTTP 403: rate limit'] }
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(r.isError).toBe(false)
  expect(w.pushes.length).toBe(1)
  expect(r.text).toContain('CI runs everything')
})

test('a diff that cannot be read writes no map, and the note names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  w.s.diffFails = 'bad revision'
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.pushes.length).toBe(1)
  expect(w.gh.some(line => line.includes('pr-edit'))).toBe(false)
  expect(r.text).toContain('CI runs everything')
  expect(r.text).toContain('git fetch origin main')
})

test('finishedReview writes the map before its push', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing' }, names: ['a.ts'] })
  await start($, w)
  w.s.sha = 'cccc1'
  await tool($, 'finishedReview', { review: 'clean', deadcode: 'clean', remembered: 'nothing: small' })
  expect(w.pushes.length).toBe(1)
  expect(w.files.get(`${ROOT}/.git/worktrees/x/ndev-pr-body.md`)).toContain('"sha":"cccc1"')
})

test('a direct commit to the base branch has no PR, so no map', async ($, on) => {
  const w = engine(on, { wf: { direct: true, prs: [] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  w.s.staged = true
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'] })
  expect(w.gh.some(line => line.includes('pr-edit'))).toBe(false)
})

test('a poll writes what came back to the live file, with no write to the record', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: [
    { state: 'open', merged: false, draft: false, mergeable: false, mergeable_state: 'blocked', head: { sha: 'a1b2c3d4e5f6' } },
    { state: 'open', merged: false, draft: true, mergeable: false, mergeable_state: 'draft', head: { sha: 'a1b2c3d4e5f6' } },
    { state: 'closed', merged: true, head: { sha: 'a1b2c3d4e5f6' } },
  ] }
  const before = w.s.saves
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  // One to enter the wait and one to leave it, however many checks ran.
  expect(w.s.saves - before).toBe(2)
  const live = liveFile(w, 'issue-7')
  expect(live?.wait?.tries).toBe(3)
  expect(live?.wait?.seen).toEqual({ state: 'merged', draft: 'no', mergeable: 'unknown', head: 'a1b2c3d4' })
  expect(live?.calls?.at(-1)).toMatchObject({ tool: 'waitForPR', outcome: 'ok', args: expect.objectContaining({ pr: '44', state: 'merged' }) })
})

test('the wait in the record holds the period and the arguments, with no secret', async ($, on) => {
  const w = engine(on)
  await start($, w)
  let seen: Workflow['waiting']
  w.s.probe = async () => {
    seen = w.state()?.waiting
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'API_TOKEN=hunter2 curl https://x.io/a?k=v', period: 30, timeout: 90 })
  expect(r.isError).toBe(false)
  expect(seen).toMatchObject({ tool: 'waitFor', period: 30, most: 4, timeoutS: 90 })
  expect(JSON.stringify(seen)).not.toContain('hunter2')
  expect(JSON.stringify(seen)).not.toContain('k=v')
})

test('a failed write of the live file costs one toast, and the wait goes on', async ($, on) => {
  const w = engine(on, { pr: { state: 'open', merged: false } })
  await start($, w)
  w.s.sleepAdvances = true
  w.s.prReadsFor = { 44: [{ state: 'open', merged: false }, { state: 'closed', merged: true }] }
  w.s.failWrite = (path: string) => path.includes('ndev-live-')
  const r = await tool($, 'waitForPR', { pr: 44, state: 'merged', period: 60 })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
  expect(w.toasts.filter(t => t.includes('will not show the live state of issue-7'))).toHaveLength(1)
})

test('a refused call shows in the live file with its reason and its arguments', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'finishedSmoke', { report: 'looked fine' })
  expect(r.isError).toBe(true)
  const call = liveFile(w, 'issue-7')?.calls?.at(-1)
  expect(call).toMatchObject({ tool: 'finishedSmoke', outcome: 'refused', args: expect.objectContaining({ report: 'looked fine' }) })
  expect(call?.note).toContain('not valid')
})

test('a project with the workflow off writes no live file', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  await tool($, 'comment', { issue: 7, message: 'hello' })
  expect(liveFile(w, 'issue-7')).toBeUndefined()
})

// ---- the mode and the steering of one issue ----
test('started takes the mode that the agent chooses, and the record of that issue keeps it', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login', mode: 'heavy' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Mode: heavy')
  expect(w.state()?.state).toBe('planning')
  expect(w.state()?.mode).toBe('heavy')
})

test('with no choice, an issue follows the worktree and the record stores nothing', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  expect(r.text).toContain('Mode: light')
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.mode).toBeUndefined()
})

test('the agent chooses the mode only at the start, and the refusal names the command for the human', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'fix-login' })
  const r = await tool($, 'started', { issue: 7, mode: 'heavy' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow mode heavy 7')
  expect(w.state()?.mode).toBeUndefined()
})

test('started refuses a mode that does not exist, and offers the agent no steering', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'fix-login', mode: 'medium' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('"medium"')
  const spec = (registeredTools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find(t => t.name.endsWith('started'))!
  expect(Object.keys(spec.inputSchema.properties)).toContain('mode')
  expect(Object.keys(spec.inputSchema.properties)).not.toContain('steering')
})

test('create passes the chosen mode to the workflow of the new issue', async ($, on) => {
  const w = engine(on, { wf: null, config: { mode: 'light' } })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'New thing\nbody', mode: 'heavy' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Mode: heavy')
})
