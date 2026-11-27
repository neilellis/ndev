// Workflow tests: The record of a wait: other writers, a dead session, status and /flow off. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, RECORD, CONFIG, LEGACY_CONFIG, flow, held, engine, settle, start, tool, command, turnEnds, idle, seven, unblock, expectBackIn, noIssue, talk } from './workflow-harness'

test('a wait ends well when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.s.staleSaves = 1
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('a wait starts well when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let answers = [{ exitCode: 0, stdout: 'S' }, { exitCode: 1 }]
  w.s.probe = () => answers.shift() ?? { exitCode: 1 }
  w.s.staleSaves = 1
  const r = await tool($, 'waitForProcessEnd', { pid: 4242 })
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
  expect(w.state()?.state).toBe('developing')
})

test('a wait that raises its alert survives another writer getting in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.sleepAdvances = true
  let n = 0
  w.s.probe = () => {
    n += 1
    // The alert is saved after the check that passes half the attempts.
    if (n === 2) w.s.staleSaves = 1
    return n >= 3 ? { exitCode: 1 } : { exitCode: 0, stdout: 'S' }
  }
  const r = await tool($, 'waitForProcessEnd', { pid: 4242, attempts: 3 })
  expect(r.text).not.toContain('exited 5')
  expect(r.isError).toBe(false)
})

test('a wait that cannot go back says so and names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.s.staleSaves = 99
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('exited 5')
  expect(r.text).toContain('/unblock')
})

test('a wait tool refuses bad numbers and a helper, and changes nothing', async ($, on) => {
  const w = engine(on)
  await start($, w)
  for (const [name, args] of [
    ['waitFor', {}],
    ['waitFor', { shell_command: 'true', period: 0 }],
    ['waitFor', { shell_command: 'true', attempts: -1 }],
    ['waitFor', { shell_command: 'true', timeout: 'soon' }],
    ['waitForURL', { url: 'file:///etc/passwd' }],
    ['waitForProcessEnd', { pid: 1.5 }],
    ['waitForSeconds', { secs: 0 }],
    ['waitForSubAgent', {}],
  ] as const) {
    const r = await tool($, name, args)
    expect(r.isError).toBe(true)
    expect(w.state()?.state).toBe('developing')
  }
  const helper = await tool($, 'waitForSeconds', { secs: 1, agentId: 'h1' })
  expect(helper.isError).toBe(true)
  expect(helper.text).toContain('only the main agent')
})

test('started on a record left in "wait" by a dead session goes back to the earlier state', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 }, owner: { session: 'dead', at: -3_600_000 } } })
  await start($, w)
  await tool($, 'started', { issue: 7, takeOver: true })
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.waiting).toBeUndefined()
})

test('a wait whose check throws goes back to the earlier state', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // One read of the record fails during the wait, and the reads after it work.
  let isBroken = false
  w.s.failRead = (path: string) => {
    if (!isBroken || !path.includes('.neil-dev.')) return false
    isBroken = false
    return true
  }
  w.s.probe = () => {
    isBroken = true
    return { exitCode: 1 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('waitFor for')
  await expectBackIn($, w, 'developing')
})

test('an interrupt that the host goes on from without the hook still ends the wait at the end of the turn', async ($, on) => {
  const w = engine(on)
  await start($, w)
  // The host lets a hook linger for 5 s after an interrupt, so this hook never gets its own say.
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  expect(w.state()?.state).toBe('wait')
  await turnEnds($, 'aborted')
  await expectBackIn($, w, 'developing')
  // A later wait is legal again, and the lingering hook that wakes at last changes nothing.
  w.s.sleepAdvances = true
  release()
  await call
  await expectBackIn($, w, 'developing')
  w.s.probe = () => ({ exitCode: 0 })
  expect((await tool($, 'waitFor', { shell_command: 'check' })).isError).toBe(false)
})

test('a normal end of a turn ends a wait of this session that no wait tool holds', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 } } })
  await start($, w)
  await turnEnds($)
  await expectBackIn($, w, 'ci')
})

test('the end of a session ends its wait, and withdraws its notice', async ($, on) => {
  const alert = { group: 'g1', pid: 42 }
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0, alert } } })
  await start($, w)
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await settle()
  expect(w.state()?.state).toBe('ci')
  expect(w.state()?.waiting).toBeUndefined()
  expect(w.alerts.join('\n')).toContain('withdraw')
})

test('status names a wait with no holder in this session, and started takes the state back and withdraws its notice', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: '`check` to exit 0', at: 0, alert: { group: 'g1', pid: 42 } } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).not.toContain('A wait tool holds')
  expect(said).toContain('No wait tool runs')
  expect(said).toContain('waitFor')
  expect(said).toContain('started')
  expect(w.state()?.state).toBe('wait') // status changes nothing.
  expect(w.alerts).toEqual([])
  await tool($, 'started', { issue: 7 })
  expect(w.alerts).toEqual(['withdraw'])
  await expectBackIn($, w, 'ci')
})

test('status says that a wait whose owner died has no holder, and started takes the state back', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 }, owner: { session: 'dead', at: -3_600_000 } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).not.toContain('A wait tool holds')
  expect(said).toContain('No wait tool runs')
  expect(said).toContain('Call started with issue 7')
  await tool($, 'started', { issue: 7 })
  await expectBackIn($, w, 'ci')
})

test('status leaves a wait of another live session as it is, and names that session', async ($, on) => {
  const w = engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'theirs', tool: 'waitFor', what: 'theirs', at: 0 }, owner: { session: 'other', at: 0 } } })
  await start($, w)
  const said = (await tool($, 'status')).text
  expect(said).toContain('the session other')
  expect(said).toContain('takeOver true')
  expect(said).not.toContain('A wait tool holds')
  expect(said).not.toContain('No wait tool runs')
  await turnEnds($, 'aborted')
  expect(w.state()?.state).toBe('wait')
})

test('status says that a running wait holds the agent', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => ({ exitCode: 1 })
  let release!: () => void
  w.s.sleepHold = new Promise<void>(resolve => { release = resolve })
  const call = tool($, 'waitFor', { shell_command: 'false', period: 30 })
  await settle()
  const said = (await tool($, 'status')).text
  expect(said).toContain('A wait tool holds')
  expect(said).not.toContain('No wait tool runs')
  await unblock($, 'go on')
  release()
  await call
})

test('a wait finds its record when the record moves files mid-wait', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const issueFile = `${ROOT}/.neil-dev.issue-7.json`
  w.s.probe = () => {
    // The old keys of the worktree file and the issue file are the two places a record can be.
    const held = JSON.parse(w.files.get(issueFile)!) as { workflow: unknown }
    w.files.set(RECORD, JSON.stringify({ workflows: { 7: held.workflow } }))
    w.files.delete(issueFile)
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('is gone')
  await expectBackIn($, w, 'developing')
})

test('a wait outlasts a record that is away for a moment, and goes on', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const issueFile = `${ROOT}/.neil-dev.issue-7.json`
  w.s.probe = () => {
    const body = w.files.get(issueFile)!
    w.files.delete(issueFile)
    // The record comes back while the wait sleeps before its next read.
    w.s.sleepHold = { then: (done: () => void) => { w.files.set(issueFile, body); w.s.sleepHold = undefined; done() } } as unknown as Promise<void>
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(false)
  expect(r.text).not.toContain('is gone')
  await expectBackIn($, w, 'developing')
})

test('a wait follows its own record when the agent goes to another issue mid-wait', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  let finish!: (v: { exitCode: number }) => void
  w.s.probe = () => new Promise(resolve => { finish = resolve })
  const call = tool($, 'waitFor', { issue: 7, shell_command: 'check' })
  await settle()
  expect(w.state(7)?.state).toBe('wait')
  await tool($, 'started', { issue: 8 })
  expect(w.state(8)?.owner?.session).toBe('s1')
  finish({ exitCode: 0 })
  const r = await call
  expect(r.text).not.toContain('A human moved')
  expect(r.text).toContain('ended after 1 checks')
  expect(w.state(7)?.state).toBe('developing')
})

test('an interrupt ends a wait whose record this agent left for another issue', async ($, on) => {
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  let finish!: (v: { exitCode: number }) => void
  w.s.probe = () => new Promise(resolve => { finish = resolve }) // The host goes on without this hook.
  const call = tool($, 'waitFor', { issue: 7, shell_command: 'check' })
  await settle()
  await tool($, 'started', { issue: 8 })
  expect(w.state(7)?.owner).toBeUndefined()
  await turnEnds($, 'aborted')
  expect(w.state(7)?.state).toBe('developing')
  expect(w.state(7)?.waiting).toBeUndefined()
  finish({ exitCode: 1 })
  await call
  expect(w.state(7)?.state).toBe('developing')
})

test('the end of a turn ends a stopped wait on a PR record that no issue shows', async ($, on) => {
  const waiting = { id: 'old', tool: 'waitFor', what: 'old', at: 0 }
  const seven = flow({ state: 'developing', prs: [13] })
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-7.json`]: JSON.stringify({ version: 1, issue: 7, workflow: seven, prs: { 13: flow({ pr: 13, issues: [7], state: 'wait', previous: 'developing', waiting }) } }) } })
  await start($, w)
  await turnEnds($)
  expect(w.prRecord(13)?.state).toBe('developing')
  expect(w.prRecord(13)?.waiting).toBeUndefined()
})

test('/flow status tells the truth about a wait that nothing holds', async ($, on) => {
  engine(on, { wf: { state: 'wait', previous: 'ci', waiting: { id: 'old', tool: 'waitFor', what: 'old', at: 0 } } })
  await start($)
  const out = await command($, 'status')
  expect(out).not.toContain('A wait tool holds')
  expect(out).toContain('No wait tool runs')
  expect(out).toContain('started')
})

test('status names /unblock only for the record that /unblock reads', async ($, on) => {
  const waiting = { id: 'old', tool: 'waitFor', what: 'old', at: 0 }
  const w = engine(on, { files: { [`${ROOT}/.neil-dev.issue-8.json`]: JSON.stringify({ version: 1, issue: 8, workflow: flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined, state: 'wait', previous: 'ci', waiting }) }) } })
  await start($, w)
  await tool($, 'started', { issue: 7 })
  const other = (await tool($, 'status', { issue: 8 })).text
  expect(other).toContain('No wait tool runs')
  expect(other).toContain('started with issue 8')
  expect(other).not.toContain('/unblock')
})

test('a failed read at the end of a turn does not claim that a wait is stuck', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.files.set(`${ROOT}/.neil-dev.issue-9.json`, '{ not json')
  await turnEnds($)
  const said = w.toasts.join('\n')
  expect(said).toContain('.neil-dev.issue-9.json')
  expect(said).not.toContain('the state stays "wait"')
  w.files.delete(`${ROOT}/.neil-dev.issue-9.json`)
})

test('a wait whose record does not come back says what it read and names the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.probe = () => {
    w.files.delete(`${ROOT}/.neil-dev.issue-7.json`)
    w.files.delete(RECORD)
    return { exitCode: 0 }
  }
  const r = await tool($, 'waitFor', { shell_command: 'check' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('issue #7')
  expect(r.text).toContain(ROOT)
  expect(r.text).toContain('.neil-dev.worktree.json')
  expect(r.text).toContain('call started with issue 7')
  expect(r.text).not.toContain('The state stays "wait"')
})

test('/flow goto goes to any state and refuses an unknown one', async ($, on) => {
  const w = engine(on)
  await start($, w)
  expect(await command($, 'goto nowhere')).toContain('needs one of')
  expect(w.state()?.state).toBe('developing')
  await command($, 'goto finishing shipped by hand')
  expect(w.state()?.state).toBe('finishing')
})

test('/flow off stops the tools and the reminders; on starts them again', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await command($, 'off doing this by hand')
  const r = await tool($, 'checkpoint', { message: 'x', files: ['a'] })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/flow on')
  await turnEnds($)
  await idle(w)
  expect(w.prompts).toEqual([])
  w.gh.length = 0
  await idle(w)
  expect(w.gh).toEqual([])
  await command($, 'on')
  expect(w.state()?.off).toBeUndefined()
  expect(w.prompts.length).toBe(1)
})

// Regression: /flow off answered "set-workflow exited 5 ... at revision 41, and this writer expected 40"
// and changed nothing, when the agent's own tool saved the record between the command's read and its write.
test('/flow off reads the record again and turns the workflow off when another writer gets in first', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 1
  const text = await command($, 'off doing this by hand')
  expect(text).not.toContain('exited 5')
  expect(w.state()?.off).toMatchObject({ reason: 'doing this by hand' })
})

test('/flow off names its retries and the repair when another writer changes the record each time', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 99
  const text = await command($, 'off by hand')
  expect(text).toContain('exited 5')
  expect(text).toContain('/flow off read the record again 3 times')
  expect(text).toContain('Repair:')
  expect(w.state()?.off).toBeUndefined()
})

// Regression: /flow off found no record of this agent, so it turned the workflow off for the session and said
// "no reminder comes". A later tool call made this session the owner of an issue, and the turn-end reminder came back.
test('/flow off for the session stops the reminders, also for a record that this session holds later', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  expect(await command($, 'off')).toContain('off for this session')
  w.files.set(RECORD, held(flow()))
  await turnEnds($)
  await idle(w)
  expect(w.prompts).toEqual([])
})

test('/flow off for the session names the records in the worktree, and their tools that move the state refuse', async ($, on) => {
  const w = engine(on, { wf: null, files: { [RECORD]: held(flow({ owner: undefined }), flow({ issue: 8, branch: 'issue-8', prs: [13], owner: undefined })) } })
  await start($, w)
  const said = await command($, 'off')
  expect(said).toContain('off for this session')
  expect(said).toContain('issue #7 in the state "developing"')
  expect(said).toContain('issue #8 in the state "developing"')
  const refused = await tool($, 'blocked', { issue: 7, message: 'stuck' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('turned the workflow off for this session')
  expect(refused.text).toContain('/flow on')
  expect(w.state()?.state).toBe('developing')
  expect(w.state()?.owner).toBeUndefined()
  const read = await tool($, 'status', { issue: 7 })
  expect(read.isError).toBe(false)
  expect(read.text).toContain('developing')
})

test('/flow off for the session leaves the tools that keep the state, such as addMigration', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await command($, 'off')
  w.files.set(RECORD, held(flow()))
  const r = await tool($, 'addMigration', { issue: 7, name: 'add_table' })
  expect(r.text).not.toContain('turned the workflow off for this session')
})

test('/flow off project writes .ndev.json and stops the reminders', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await command($, 'off project')
  expect((JSON.parse(w.files.get(CONFIG) ?? '{}') as { workflow?: boolean }).workflow).toBe(false)
  await turnEnds($)
  expect(w.prompts).toEqual([])
  await command($, 'on project')
  expect((JSON.parse(w.files.get(CONFIG) ?? '{}') as { workflow?: boolean }).workflow).toBe(true)
})

test('/flow off project moves a tracked .neil-dev.json to .ndev.json with git and writes the key there', async ($, on) => {
  const w = engine(on)
  w.files.set(LEGACY_CONFIG, w.files.get(CONFIG)!)
  w.files.delete(CONFIG)
  await start($, w)
  await command($, 'off project')
  expect(w.files.has(LEGACY_CONFIG)).toBe(false)
  expect((JSON.parse(w.files.get(CONFIG) ?? '{}') as { workflow?: boolean; mode?: string })).toMatchObject({ workflow: false, mode: 'light' })
})

// ---- the limit on GitHub calls ----
test('the whole flow reaches GitHub only through gh.sh', async ($, on) => {
  const w = engine(on, { wf: null, pr: { draft: true } })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  await tool($, 'finishedInterview', { issue: 7 })
  await tool($, 'finishedDevelopment', { prs: [12], message: 'Add', files: ['a.ts'] })
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'clean', deadcode: 'clean' })
  expect(w.gh.length).toBeGreaterThan(0)
  expect(w.gh.filter(c => !c.includes('/scripts/github/gh.sh '))).toEqual([])
  expect(w.ready.length).toBe(1)
})

test('an interactive session with no issue asks for the issue, a new issue or no workflow', async ($, on) => {
  const w = noIssue(on)
  await talk($)
  expect(w.issueAsks).toHaveLength(1)
  expect(w.issueAsks[0]!.options).toEqual(['Use an existing issue', 'Create a new issue', 'Work without the workflow'])
})
