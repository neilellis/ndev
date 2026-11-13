// Workflow tests: waitForState, create, several issues on one PR and migrations. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from 'claude-code/testing'
import { ROOT, RECORD, REPO, flow, onPr, held, pull, registeredTools, engine, settle, start, STATE_TOOLS, tool, finishing, bodyFile, seven, twelve, OTHER, RECORD_BASE, putIssue, startForState, mine } from './workflow-harness'

test('waitForState holds until an issue in another worktree reaches the state, with no GitHub call, and the state goes back', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'developing' })
  const before = w.gh.length
  let release = () => {}
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const held = tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  putIssue(w, 9, { state: 'ci' })
  release()
  const r = await held
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #9')
  expect(r.text).toContain('state "ci"')
  expect(w.gh.length).toBe(before)
  expect(w.state()?.state).toBe('developing')
})

test('waitForState does not hold for a state that the issue is already past or passed through during the wait', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'smoke' })
  const past = await tool($, 'waitForState', { issue_id: 9, state: 'reviewing', period: 60 })
  expect(past.isError).toBe(false)
  expect(past.text).toContain('past "reviewing"')
  putIssue(w, 9, { state: 'developing', history: [{ at: w.s.now, tool: 'blocked', from: 'developing', to: 'blocked' }, { at: w.s.now, tool: 'unblocked', from: 'blocked', to: 'developing' }] })
  const through = await tool($, 'waitForState', { issue_id: 9, state: 'blocked', period: 60 })
  expect(through.isError).toBe(false)
  expect(through.text).toContain('during this wait')
})

test('waitForState follows an issue into its PR record, and reads a blocked issue as still at its stage', async ($, on) => {
  const w = await startForState($, on)
  w.files.set(`${OTHER}/.neil-dev.issue-9.json`, JSON.stringify({ version: 1, issue: 9, workflow: { ...RECORD_BASE, issue: 9, prs: [44], state: 'developed' }, prs: { 44: { ...RECORD_BASE, issue: 9, issues: [9], pr: 44, prs: [44], state: 'ci' } } }))
  const r = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('PR #44')
  putIssue(w, 10, { state: 'blocked', previous: 'developing' })
  const held = await tool($, 'waitForState', { issue_id: 10, state: 'reviewing', period: 60, attempts: 2 })
  expect(held.isError).toBe(true)
  expect(held.text).toContain('gave up')
})

test('waitForState ends for an issue held at the state or past it, and holds for a sign-off that has not yet reached it', async ($, on) => {
  const w = await startForState($, on)
  const reached = [{ at: 1, tool: 'finishedReview', from: 'reviewing', to: 'ci' }]
  w.s.now += 10_000
  putIssue(w, 9, { state: 'blocked', previous: 'ci', history: reached })
  const atState = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 2 })
  expect(atState.isError).toBe(false)
  expect(atState.text).toContain('held in "blocked"')
  putIssue(w, 10, { state: 'wait', previous: 'revising', history: reached })
  const past = await tool($, 'waitForState', { issue_id: 10, state: 'reviewing', period: 60, attempts: 2 })
  expect(past.isError).toBe(false)
  expect(past.text).toContain('past "reviewing"')
  putIssue(w, 11, { state: 'blocked', previous: 'developing', history: [{ at: 1, tool: 'finishedPlan', from: 'planning', to: 'blocked' }] })
  const signOff = await tool($, 'waitForState', { issue_id: 11, state: 'developing', period: 60, attempts: 2 })
  expect(signOff.isError).toBe(true)
  expect(signOff.text).toContain('gave up')
})

test('waitForState ends at once when the issue is done or off and did not reach the state, and says so', async ($, on) => {
  const w = await startForState($, on)
  putIssue(w, 9, { state: 'done' })
  const done = await tool($, 'waitForState', { issue_id: 9, state: 'revising', period: 60 })
  expect(done.text).toContain('did not reach the state "revising"')
  putIssue(w, 10, { state: 'developing', off: true })
  const off = await tool($, 'waitForState', { issue_id: 10, state: 'ci', period: 60 })
  expect(off.text).toContain('workflow off')
})

test('waitForState goes on for an issue with no record, names a file it cannot read, and names the exit code of a failed worktree list', async ($, on) => {
  const w = await startForState($, on)
  const none = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 2 })
  expect(none.isError).toBe(true)
  expect(none.text).toContain('has no workflow record')
  expect(none.text).toContain(OTHER)
  w.files.set(`${OTHER}/.neil-dev.worktree.json`, 'not json')
  const unread = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 1 })
  expect(unread.isError).toBe(true)
  expect(unread.text).toContain('Not read')
  w.s.worktreeListFails = 'not a git repository'
  const failed = await tool($, 'waitForState', { issue_id: 9, state: 'ci', period: 60, attempts: 1 })
  expect(failed.isError).toBe(true)
  expect(failed.text).toContain('exit code 128: not a git repository')
})

test('waitForState refuses a state that is not a workflow state, a missing issue, and the issue that this agent is on', async ($, on) => {
  const w = await startForState($, on)
  const bad = await tool($, 'waitForState', { issue_id: 9, state: 'green' })
  expect(bad.isError).toBe(true)
  expect(bad.text).toContain('finishing')
  expect((await tool($, 'waitForState', { state: 'ci' })).text).toContain('issue_id')
  const own = await tool($, 'waitForState', { issue_id: 7, state: 'ci' })
  expect(own.isError).toBe(true)
  expect(own.text).toContain('this agent is on it')
  expect(w.state()?.state).toBe('developing')
  const specs = registeredTools as { name: string; inputSchema: { required: string[]; properties: Record<string, { enum?: string[] }> } }[]
  const schema = specs.find(x => x.name === 'waitForState')!.inputSchema
  expect(schema.required).toEqual(expect.arrayContaining(['issue_id', 'state']))
  expect(schema.properties.state!.enum).toContain('wait')
})

test('a wait past half its attempts tells the human once, and withdraws the notice when it ends', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  const seen: string[][] = []
  let left = 5
  w.s.probe = () => {
    seen.push([...w.alerts])
    return { exitCode: --left === 0 ? 0 : 1 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 5, attempts: 6 })
  expect(r.isError).toBe(false)
  // Checks 1 to 3 are half of 6. The notice comes after check 4.
  expect(seen.map(a => a.length)).toEqual([0, 0, 0, 0, 1])
  expect(w.alerts).toEqual(['raise', 'withdraw'])
  expect(w.state()?.waiting).toBeUndefined()
})

test('a wait with no attempts counts half of its timeout', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  w.s.probe = () => ({ exitCode: 1 })
  const r = await tool($, 'waitFor', { shell_command: 'false', period: 10, timeout: 100 })
  expect(r.isError).toBe(true)
  expect(w.alerts).toEqual(['raise', 'withdraw'])
})

test('a short wait and waitForSeconds do not raise the notice', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  await tool($, 'waitForSeconds', { secs: 7 })
  let exits = [1, 0]
  w.s.probe = () => ({ exitCode: exits.shift() ?? 0 })
  await tool($, 'waitFor', { shell_command: 'x', period: 5, attempts: 10 })
  expect(w.alerts).toEqual([])
})

// ---- each call names its issue; create; comment ----
test('a state tool with no issue is refused, and nothing changes', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const before = w.state()?.rev
  const r = await tool($, 'finishedChecks', { issue: undefined })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('finishedChecks needs issue')
  expect(w.state()?.rev).toBe(before)
})

test('the schema of each state tool asks for what that stage names: the issue, the issues, or either the issue or the PR', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const specs = registeredTools as { name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }[]
  const spec = (name: string) => specs.find(s => s.name === name)!.inputSchema
  expect(spec('finishedPlan').required).toContain('issue')
  expect(spec('finishedDevelopment').required).toContain('issues')
  expect(spec('waitForPR').required).toEqual(expect.arrayContaining(['issue', 'pr', 'state']))
  for (const name of STATE_TOOLS.filter(n => !['finishedPlan', 'finishedDevelopment', 'waitForPR'].includes(n))) {
    expect(Object.keys(spec(name).properties)).toEqual(expect.arrayContaining(['issue', 'pr']))
    expect(spec(name).required).not.toContain('issue')
    expect(spec(name).required).not.toContain('pr')
  }
  expect(spec('waitForIssue').required).toContain('waitOn')
  expect((spec('waitForIssue').properties.waitOn as { type: string }).type).toBe('array')
})

test('a call that names an issue this agent is not on is refused and names the repair', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  const before = w.state(7)?.rev
  const r = await tool($, 'blocked', { issue: 7, message: 'stuck' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('on issue #12')
  expect(r.text).toContain('started')
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.rev).toBe(before)
})

test('a call that names an issue with no record says so', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await tool($, 'finishedChecks', { issue: 99 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#99')
})

test('status reads the named issue, and does not change the active one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  await tool($, 'started', { issue: 12, shortName: 'other-work' })
  expect((await tool($, 'status', { issue: 7 })).text).toContain('State: developing. Issue #7')
  expect((await tool($, 'status')).text).toContain('Issue #12')
})

test('create files the issue, starts its workflow and answers with the number', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'The title\n\nThe body.' })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('Issue #31')
  expect(w.state(31)?.shortName).toBe('new-thing')
  const made = w.gh.find(line => line.includes('issue-new'))!
  expect(made).toContain('The title')
  expect([...w.files.values()].some(text => text.includes('The body.'))).toBe(true)
})

test('create refuses a bad shortName or no description before it files anything', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect((await tool($, 'create', { shortName: 'Bad Name', description: 'T' })).isError).toBe(true)
  expect((await tool($, 'create', { shortName: 'new-thing', description: '' })).isError).toBe(true)
  expect(w.gh.filter(line => line.includes('issue-new'))).toEqual([])
})

test('create refuses in a project with the workflow off, before it files anything', async ($, on) => {
  const w = engine(on, { wf: null, config: { workflow: false } })
  await start($, w)
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'T' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('off for this project')
  expect(w.gh.filter(line => line.includes('issue-new'))).toEqual([])
})

test('create that files the issue and then cannot start names the issue and the repair', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  w.s.issueReadsFor = { 31: ['read failed'] }
  const r = await tool($, 'create', { shortName: 'new-thing', description: 'T' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('#31')
  expect(r.text).toContain('started')
  expect(r.text).toContain('new-thing')
  expect(r.text).toContain('read failed')
})

test('comment posts to the issue or the PR it names, marked as the tool\'s own', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  const toIssue = await tool($, 'comment', { issue: 9, message: 'On the issue.' })
  expect(toIssue.isError).toBe(false)
  expect(toIssue.text).toContain(`https://github.com/${REPO}/issues/9`)
  const onPr = await tool($, 'comment', { pr: 12, message: 'On the PR.' })
  expect(onPr.isError).toBe(false)
  expect(onPr.text).toContain(`https://github.com/${REPO}/pull/12`)
  const said = w.gh.filter(line => line.includes(' comment '))
  expect(said.length).toBe(2)
  expect(said[0]).toContain('comment 9')
  expect(said[0]).toContain('On the issue.')
  expect(said[0]).toContain('ndev')
  expect(said[1]).toContain('comment 12')
})

test('comment refuses without one target, or without a message', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  for (const args of [{ message: 'x' }, { issue: 9, pr: 12, message: 'x' }, { issue: 9 }, { pr: 0, message: 'x' }]) {
    expect((await tool($, 'comment', args)).isError).toBe(true)
  }
  expect(w.gh.filter(line => line.includes(' comment '))).toEqual([])
})

test('finishedDevelopment with all the issues of a PR starts one review, of the PR, and names each issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    const r = await tool($, 'finishedDevelopment', { issues: [7, 12], prs: [12], files: [] })
    expect(r.isError).toBe(false)
    expect(w.issueRecord(7)!.state).toBe('developed')
    expect(w.issueRecord(12)!.state).toBe('developed')
    const pr = w.prRecord(12)! as Record<string, unknown>
    expect(pr.state).toBe('reviewing')
    expect(pr.issues).toEqual([7, 12])
    expect(r.text).toContain('pr 12')
    expect(w.spawns).toHaveLength(1)
    expect(String((w.spawns[0] as { prompt: string }).prompt)).toContain('#7')
    expect(String((w.spawns[0] as { prompt: string }).prompt)).toContain('#12')
})

test('an issue that finishes before another on its PR waits, and the last one to finish starts the review', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(), twelve()))
    await start($, w)
    const first = await tool($, 'finishedDevelopment', { issues: [7], prs: [12], files: [] })
    expect(first.isError).toBe(false)
    expect(first.text).toContain('#12')
    expect(w.issueRecord(7)!.state).toBe('developed')
    expect(w.prRecord(12)).toBeUndefined()
    expect(w.spawns).toHaveLength(0)
    expect((await tool($, 'started', { issue: 12 })).isError).toBe(false)
    const last = await tool($, 'finishedDevelopment', { issues: [12], prs: [12], files: [] })
    expect(last.isError).toBe(false)
    expect(w.prRecord(12)!.state).toBe('reviewing')
    expect(w.prRecord(12)!.issues).toEqual([7, 12])
    expect(w.spawns).toHaveLength(1)
})

test('finishedDevelopment refuses an issue that this worktree does not hold, and an empty list', async ($, on) => {
  engine(on, { wf: { state: 'developing' } })
    await start($)
    expect((await tool($, 'finishedDevelopment', { issues: [7, 99], prs: [12], files: [] })).text).toContain('#99')
    expect((await tool($, 'finishedDevelopment', { issues: [], prs: [12], files: [] })).isError).toBe(true)
})

test('from the merge point on, a stage tool that names only the issue is told to give the PR', async ($, on) => {
  engine(on, { wf: { state: 'ci' }, pr: pull() })
    await start($)
    const r = await tool($, 'finishedChecks', { issue: 7 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('pr 12')
    expect((await tool($, 'finishedChecks', { pr: 12 })).text).not.toContain('give pr')
})

test('a PR with no workflow yet is refused by number', async ($, on) => {
  engine(on, { wf: { state: 'developing' } })
    await start($)
    const r = await tool($, 'finishedChecks', { pr: 44 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('PR #44')
})

for (const stage of ['ci', 'smoke', 'finishing', 'done']) {
  test(`a new issue joins a PR in ${stage}, which goes back to its developers with no evidence`, async ($, on) => {
    const w = engine(on, { wf: finishing({ state: stage, hooks: { review: { firedAt: 1, agentId: 'a', answer: 'old' } } }), pr: pull() })
      await start($, w)
      w.s.issueReadsFor = { 31: [{ state: 'open', title: 'More' }] }
      const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
      expect(r.isError).toBe(false)
      expect(r.text).toContain('PR #12')
      const pr = w.prRecord(12)! as Record<string, unknown> & { hooks?: { review?: unknown } }
      expect(pr.state).toBe('developing')
      expect(pr.evidence).toEqual({})
      expect(pr.hooks?.review).toBeUndefined()
      expect(pr.issues).toEqual([7, 31])
      expect(w.issueRecord(31)!.prs).toEqual([12])
      expect(w.issueRecord(31)!.state).toBe('developing')
      expect(w.files.get(bodyFile(w))).toContain('Closes #31')
  })
}

test('a PR that has merged takes no new issue: it goes to a new worktree, and the answer names the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', merged: true }, pr: pull({ state: 'closed', merged: true }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('PR #12 of /proj is merged')
    expect(w.s.claims).toEqual(['/main 31 origin/main'])
    expect(w.issueRecord(31)).toBeUndefined()
})

test('a PR that was closed with no merge takes no new issue: it goes to a new worktree, and the answer names the state', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: pull({ state: 'closed' }) })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('PR #12 of /proj is closed')
    expect(w.s.claims).toEqual(['/main 31 origin/main'])
})

test('an issue that opens the PR shares it with the issue it joined, which had none', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning', prs: [] }, pr: pull() })
    await start($, w)
    w.s.issueReadsFor = { 31: [{ state: 'open', title: 'More' }] }
    expect((await tool($, 'started', { issue: 31, shortName: 'more-work' })).isError).toBe(false)
    const shared = w.issueRecord(31)!.prs
    expect(shared).toHaveLength(1)
    expect(w.issueRecord(7)!.prs).toEqual(shared)
})

test('a new session does not join the issue of another live agent', async ($, on) => {
  const w = engine(on, { wf: { owner: { session: 'other', at: 0 } } })
    await start($, w)
    const r = await tool($, 'started', { issue: 31, shortName: 'more-work' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('other')
    expect(w.issueRecord(31)).toBeUndefined()
})

test('a resumed session binds to the unfinished issue it released last', async ($, on) => {
  const w = engine(on, { wf: null })
  const released = (issue: number, at: number, state = 'developing') => flow({ issue, state, owner: undefined, lastSession: 's1', releasedAt: at })
  w.files.set(RECORD, held(released(7, 100, 'done'), released(9, 50), released(11, 80)))
    await start($, w)
    expect((await tool($, 'status')).text).toContain('Issue #11')
})

test('a checkpoint on an issue holds its commit while another issue on the PR holds one too', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(mine({ state: 'developed' })), twelve(mine())))
    await start($, w)
    await tool($, 'started', { issue: 12 })
    const before = w.pushes.length
    w.s.dirty = [' M x.ts']
    w.s.staged = true
    const r = await tool($, 'checkpoint', { issue: 12, message: 'm', files: ['x.ts'] })
    expect(r.isError).toBe(false)
    expect(w.pushes.length).toBe(before)
    expect(r.text).toContain('#7')
})

test('addMigration lists the migrations of each issue on the PR, and not only of the caller', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, held(seven(mine()), twelve({ migrations: [{ name: 'other_one', path: 'supabase/migrations/1_other_one.sql' }] })))
  w.files.set(`${ROOT}/supabase/config.toml`, '')
    await start($, w)
    expect((await tool($, 'addMigration', { name: 'mine_one' })).isError).toBe(false)
    const body = w.files.get(bodyFile(w))!
    expect(body).toContain('1_other_one.sql')
    expect(body).toContain('mine_one')
})

test('addMigration refuses a listed migration whose file is gone, and names the repair', async ($, on) => {
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: 'supabase/migrations/20261105153912_audiences.sql' }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${ROOT}/supabase/migrations/20261105153912_audiences.sql does not exist`)
  expect(r.text).toContain('newVersion')
})

test('addMigration with newVersion gives a listed migration a new version, carries its SQL and lists the new path only', async ($, on) => {
  const old = 'supabase/migrations/20261105153912_audiences.sql'
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: old }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  w.files.set(`${ROOT}/${old}`, 'create table t();\n')
  w.s.now = Date.UTC(2026, 10, 5, 16, 30, 0)
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences', newVersion: true })
  expect(r.isError).toBe(false)
  const fresh = 'supabase/migrations/20261105163000_audiences.sql'
  expect(w.files.get(`${ROOT}/${fresh}`)).toBe('create table t();\n')
  expect(r.text).toContain(`${ROOT}/${fresh}`)
  expect(r.text).toContain(`delete ${ROOT}/${old}`)
  const body = w.files.get(bodyFile(w))!
  expect(body).toContain(fresh)
  expect(body).not.toContain(old)
})

test('addMigration gives a version after the newest migration file, when that file is dated after the clock', async ($, on) => {
  const old = 'supabase/migrations/20261105153912_audiences.sql'
  const w = engine(on, { wf: { state: 'smoke', migrations: [{ name: 'audiences', path: old }] } })
  w.files.set(`${ROOT}/supabase/config.toml`, '')
  w.files.set(`${ROOT}/${old}`, 'create table t();\n')
  w.files.set(`${ROOT}/supabase/migrations/20261109235959_future_dated.sql`, 'select 1;\n')
  w.s.now = Date.UTC(2026, 10, 9, 12, 39, 18)
  await start($, w)
  const r = await tool($, 'addMigration', { name: 'audiences', newVersion: true })
  expect(r.isError).toBe(false)
  expect(w.files.get(`${ROOT}/supabase/migrations/20261110000000_audiences.sql`)).toBe('create table t();\n')
  const added = await tool($, 'addMigration', { name: 'other_one' })
  expect(added.isError).toBe(false)
  expect(w.files.has(`${ROOT}/supabase/migrations/20261110000001_other_one.sql`)).toBe(true)
})

test('the answer of a code review reaches the PR record, while the agent is on another issue', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  w.files.set(RECORD, JSON.stringify({ version: 2, resources: {}, workflows: { 7: seven({ state: 'developed' }), 31: flow({ issue: 31, state: 'developing', ...mine() }) }, prs: { 12: flow({ pr: 12, issues: [7, 31], state: 'reviewing', hooks: { review: { firedAt: 1, agentId: 'rev-1' } } }) } }))
    await start($, w)
    await tool($, 'started', { issue: 31 })
    await $.turn.complete({ agentId: 'rev-1', answer: 'No findings.' } as never)
    expect((w.prRecord(12)!.hooks!.review as { answer?: string }).answer).toContain('No findings')
})

test('finishedPlan keeps the text outside the plans, and each closing reference in any form', async ($, on) => {
  const w = engine(on, { wf: { state: 'planning' }, pr: pull({ body: 'Plan incoming.\n\nA note from the human.\n\nCloses: #31\nCloses owner/repo#32\nFixes https://github.com/o/r/issues/33\n' }) })
  w.files.set('/tmp/plan.md', 'The plan.\nTest entry point: the tool.\n')
    await start($, w)
    expect((await tool($, 'finishedPlan', { markdown_file: '/tmp/plan.md' })).isError).toBe(false)
    const body = w.files.get(bodyFile(w))!
    expect(body).toContain('A note from the human.')
    expect(body).toContain('Closes: #31')
    expect(body).toContain('Closes owner/repo#32')
    expect(body).toContain('issues/33')
    expect(body).not.toContain('Plan incoming.')
})
