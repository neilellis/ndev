// Workflow tests: The idle reads of GitHub: the PR, its checks and the person typing. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { until } from './until'
import { ROOT, fireIdle, SHA, pull, CHECKS, engine, start, tool, command, turnEnds, idle, poll, RUNNING, hookCall } from './workflow-harness'

// ---- the idle heartbeat ----
test('idle with a clean PR: one REST read, a compaction and the next step', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.gh[0]).toContain('pr-read 12')
  expect(w.ready).toEqual([])
  expect(w.compacts.length).toBe(1)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).not.toContain('Fix these first')
})

test('idle with a merge conflict tells the agent', async ($, on) => {
  const w = engine(on, { pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).toContain('PR #12 has merge conflicts')
  expect(w.prompts[0]).toContain('ndev:resolving-merge-conflicts')
})

test('idle with a failed check names it', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).toContain('failed checks')
  expect(w.prompts[0]).toContain('unit tests (failure)')
})

test('idle ignores a cancelled run that a newer run of the same check replaced', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'blocked' }, checks: CHECKS(
    { name: 'checks', conclusion: 'cancelled', started_at: '2026-01-01T10:00:00Z' },
    { name: 'checks', status: 'in_progress', conclusion: null, started_at: '2026-01-01T10:00:02Z' }) })
  await start($, w)
  await idle(w)
  expect(w.prompts.join('\n')).not.toContain('failed checks')
})

test('a clean PR needs no read of its checks; only another state costs that', async ($, on) => {
  const w = engine(on)
  await start($, w)
  await idle(w)
  expect(w.gh.some(c => c.includes('commit-checks'))).toBe(false)
})

test('a pending check is not a failure', async ($, on) => {
  const w = engine(on, { pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'ci', status: 'in_progress', conclusion: null }) })
  await start($, w)
  await idle(w)
  expect(w.prompts[0]).not.toContain('Fix these first')
})

test('a read of GitHub that fails is said, not read as a clean PR, and the reminder still goes', async ($, on) => {
  const w = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: false })
  w.s.ghFails = 'HTTP 403: API rate limit exceeded'
  fireIdle(w)
  await until('the PR #12 refusal and reminder', () => w.toasts.some(text => text.includes('PR #12 was not read')) && w.prompts.length === 1, () => ({ toasts: w.toasts, prompts: w.prompts }))
  expect(w.toasts.join()).toContain('PR #12 was not read')
  expect(w.toasts.join()).toContain('rate limit')
  expect(w.prompts.length).toBe(1)
})

// #679 in fcc-proto: another writer saved the PR record while the idle check read GitHub, and the idle
// check's own save then failed with "set-workflow exited 5 ... at revision 6, and this writer expected 5".
test('an idle check that loses the save to another writer tries again at the next tick, and reports no bug', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 1
  await idle(w)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  expect(w.prompts).toHaveLength(0)
  await poll(w, 61_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.toasts.join()).not.toContain('exited 5')
})

test('an idle check that loses its save on each tick says so, with the error and the repair', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.staleSaves = 99
  await idle(w)
  await poll(w, 61_000)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  await poll(w, 61_000)
  expect(w.toasts.join()).toContain('the idle check failed')
  expect(w.toasts.join()).toContain('exited 5')
  expect(w.toasts.join()).toContain('on 3 ticks in a row')
  expect(w.prompts).toHaveLength(0)
})

test('idle under a draft in the prompt box makes no GitHub call', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.draft = 'typing'
  await idle(w)
  expect(w.gh).toEqual([])
  expect(w.prompts).toEqual([])
})

test('a PR that waits for the human stays silent while clean', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
  expect(w.state()?.state).toBe('done')
})

test('a conflict under a finished PR reopens the work', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('revising')
  expect(w.prompts[0]).toContain('merge conflicts')
})

test('status in done reads the PR: a conflict is named with its repair, and the PR is not called ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  const r = await tool($, 'status', { pr: 12 })
  expect(r.text).toContain('PR #12 has merge conflicts')
  expect(r.text).toContain('ndev:resolving-merge-conflicts')
  expect(r.text).toContain('(dirty)')
  expect(r.text).toContain('checkpoint')
  expect(r.text).not.toContain('ready for a human')
  expect(w.state()?.state).toBe('done')
})

test('status in done says that GitHub is still computing, and does not call the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: null, mergeable_state: 'unknown' } })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('GitHub has not finished computing whether PR #12 can merge')
  expect(r.text).not.toContain('ready for a human')
})

test('status in done that cannot read the PR says so, and does not call the PR ready', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  w.s.prReadsFor = { 12: ['HTTP 502 from GitHub'] }
  const r = await tool($, 'status')
  expect(r.text).toContain('PR #12 was not read')
  expect(r.text).toContain('HTTP 502')
  expect(r.text).not.toContain('ready for a human')
})

test('status in done calls a clean PR ready only after it reads it', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  expect((await tool($, 'status')).text).toContain('ready for a human to merge')
  w.s.pr = pull({ state: 'closed', merged: true, mergeable: null, mergeable_state: 'unknown' })
  const merged = await tool($, 'status')
  expect(merged.text).toContain('PR #12 is merged')
  expect(merged.text).not.toContain('ready for a human')
})

test('/flow status in done reads no PR, so it does not call the PR ready, and names the tool that reads it', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' } })
  await start($, w)
  const out = await command($, 'status')
  expect(out).not.toContain('ready for a human')
  expect(out).toContain('call status')
})

test('a conflict fix on a finished PR that is still open commits through checkpoint and goes back to the checks', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  w.s.dirty = ['M  CLAUDE.md']
  const r = await tool($, 'checkpoint', { message: 'Merge main', files: ['CLAUDE.md'] })
  expect(r.isError).toBe(false)
  expect(w.commits.length).toBe(1)
  expect(w.pushes.length).toBe(1)
  expect(w.state()?.state).toBe('ci')
})

for (const [name, pr, said] of [['merged', { state: 'closed', merged: true }, 'merged'], ['closed', { state: 'closed', merged: false }, 'closed with no merge']] as const) {
  test(`checkpoint on a finished PR that is ${name} commits nothing and says why`, async ($, on) => {
    const w = engine(on, { wf: { state: 'done' }, pr })
    await start($, w)
    w.s.dirty = [' M a.ts']
    const r = await tool($, 'checkpoint', { message: 'late', files: ['a.ts'] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(`PR #12 is ${said}`)
    expect(r.text).toContain('issue_only')
    expect(w.commits.length).toBe(0)
    expect(w.state()?.state).toBe('done')
  })
}

test('checkpoint on finished work with no PR is still refused', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', direct: true, prs: [] } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'late', files: ['a.ts'] })
  expect(r.isError).toBe(true)
  expect(w.commits.length).toBe(0)
  expect(w.state()?.state).toBe('done')
})

test('a merged PR ends the watch: no more GitHub calls', async ($, on) => {
  const w = engine(on, { wf: { state: 'done' }, pr: { state: 'closed', merged: true } })
  await start($, w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  await idle(w)
  await idle(w)
  expect(w.gh.length).toBe(1)
  expect(w.prompts).toEqual([])
})

test('a PR closed with no merge during the work reaches the human', async ($, on) => {
  const w = engine(on, { pr: { state: 'closed', merged: false } })
  await start($, w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('closed with no merge')
})

test('the same conflict after a second idle period reaches the human', async ($, on) => {
  const w = engine(on, { pr: { mergeable: false, mergeable_state: 'dirty' } })
  await start($, w)
  await idle(w)
  await idle(w)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('merge conflicts')
})

test('in ci the agent is told not to wait, and the turn end gets no reminder', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  const r = await tool($, 'status')
  expect(r.text).toContain('Do not run a wait helper')
  expect(r.text).not.toContain('Run ndev wait checks')
  await turnEnds($)
  expect(w.prompts).toEqual([])
})

test('pending checks make no prompt, and one check period costs two GitHub calls', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.gh.length).toBe(2)
  expect(w.prompts).toEqual([])
  expect(w.compacts).toEqual([])
})

test('a timer fire inside the check period makes no GitHub call', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  const calls = w.gh.length
  await poll(w, 60_000)
  expect(w.gh.length).toBe(calls)
})

test('a failed check reaches the agent as soon as it is read, with no compaction', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('unit tests (failure)')
  expect(w.prompts[0]).toContain('checkpoint')
  expect(w.compacts).toEqual([])
})

test('a read of the checks that loses its save to another writer reads again at the next tick', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.staleSaves = 1
  await poll(w)
  expect(w.toasts.join()).not.toContain('the idle check failed')
  expect(w.prompts).toHaveLength(0)
  await poll(w, 61_000)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('unit tests')
})

test('a merge conflict reaches the agent while the checks still run', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable: false, mergeable_state: 'dirty' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('PR #12 has merge conflicts')
})

test('green checks tell the agent to call finishedChecks', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w)
  expect(w.prompts).toEqual([])
  w.s.checks = CHECKS({ name: 'unit tests', conclusion: 'success' })
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('call finishedChecks')
})

test('the same red checks with no progress reach the human, and do not prompt for ever', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, pr: { mergeable_state: 'unstable' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  for (let i = 0; i < 4; i++) await poll(w)
  expect(w.prompts.length).toBe(3)
  expect(w.state()?.state).toBe('blocked')
  expect(w.state()?.blocked?.message).toContain('unit tests (failure)')
})

test('a failed read of GitHub is named, and is not taken for green', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  w.s.ghFails = 'commit-checks'
  await poll(w)
  expect(w.prompts).toEqual([])
  expect(w.toasts.join('\n')).toContain('checks')
})

test('checks stuck for an hour reach the agent, and then the human', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: RUNNING })
  await start($, w)
  await poll(w, 61 * 60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('unit tests')
  expect(w.prompts[0]).toContain('60 minutes')
  await poll(w, 61 * 60_000)
  expect(w.state()?.state).toBe('blocked')
})

test('a person typing holds the read and the prompt', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' }, checks: CHECKS({ name: 'unit tests', conclusion: 'failure' }) })
  await start($, w)
  w.s.draft = 'half a thought'
  await poll(w)
  expect(w.gh).toEqual([])
  expect(w.prompts).toEqual([])
})

for (const command of ['ndev wait checks 12', 'ndev wait checks 12 --period 120', 'ndev wait --json checks 12', 'ndev --json wait --period 120 checks 12', 'ndev wait checks --timeout 1200 12', 'gh pr checks 12 --watch', 'gh run watch 99']) {
  test(`in ci the agent's own wait is refused: ${command}`, async ($, on) => {
    const w = engine(on, { wf: { state: 'ci' } })
    await start($, w)
    const r = await hookCall($, 'Bash', { command })
    expect(JSON.stringify(r)).toContain('The workflow watches the checks')
  })
}

test('a one-off read of the checks is not a wait, and stays allowed', async ($, on) => {
  const w = engine(on, { wf: { state: 'ci' } })
  await start($, w)
  const r = await hookCall($, 'Bash', { command: 'gh pr checks 12' })
  expect(JSON.stringify(r)).not.toContain('The workflow watches the checks')
})

for (const [name, wf] of [['developing', { state: 'developing' }], ['a workflow turned off', { state: 'ci', off: { at: 1, reason: 'r' } }]] as const) {
  test(`with ${name}, a wait helper is allowed`, async ($, on) => {
    const w = engine(on, { wf })
    await start($, w)
    const r = await hookCall($, 'Bash', { command: 'ndev wait checks 12' })
    expect(JSON.stringify(r)).not.toContain('The workflow watches the checks')
  })
}

test('checks pending at done: the workflow watches them too, and says when to call done again', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } } }, checks: RUNNING })
  await start($, w)
  const r = await tool($, 'done', { message: 'm', remembered: 'nothing: small' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Do not run a wait helper')
  await turnEnds($)
  expect(w.prompts).toEqual([])
  expect(JSON.stringify(await hookCall($, 'Bash', { command: 'ndev wait checks 12' }))).toContain('The workflow watches the checks')
  w.s.checks = CHECKS({ name: 'unit tests', conclusion: 'success' })
  await poll(w)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).toContain('call done')
})

test('a new workflow needs a short name, and the refusal comes before any claim and names the issue title', async ($, on) => {
  const w = engine(on, { wf: null, main: true })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('shortName')
  expect(r.text).toContain('"T"')
  expect(w.state()).toBeUndefined()
  expect(w.steps.join()).not.toContain('worktree_claim')
})
