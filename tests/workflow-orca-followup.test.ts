// Workflow tests: Orca workspaces, blocked, and followUp. The shared harness is in tests/workflow-harness.ts.
import { expect, test } from './sdk-testing'
import { ROOT, SHA, ok, flow, engine, start, tool, command, idle, RUNNING, arg, inOrca, workerStarts, onDeveloping, CLAIMED, AGENT, startFollowUp } from './workflow-harness'

test('started refuses a short name that is not lower-case words, or that repeats the issue number', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  for (const bad of ['Add Sub', 'add_sub', '-add', '7-add-sub', 'a'.repeat(41)]) {
    const r = await tool($, 'started', { issue: 7, shortName: bad })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('shortName')
  }
  expect(w.state()).toBeUndefined()
})

test('the short name stays in the record, and a resume does not need it again', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect((w.state() as { shortName?: string })?.shortName).toBe('add-sub')
  const again = await tool($, 'started', { issue: 7 })
  expect(again.isError).toBe(false)
  expect((w.state() as { shortName?: string })?.shortName).toBe('add-sub')
})

test('a record from before short names resumes, and the answer asks for one', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing' } })
  await start($, w)
  const r = await tool($, 'started', { issue: 7 })
  expect(r.isError).toBe(false)
  expect(r.text).toContain('shortName')
})

test('started names the Orca workspace <issue>-<short name> and sets its status, by the folder of the worktree', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  const all = w.orcaCalls.flat().join(' ')
  expect(all).toContain('--display-name 7-add-sub')
  expect(all).toContain('--workspace-status in-progress')
  expect(all).toContain('--issue 7')
  expect(all).toContain('--pr 12')
  for (const c of w.orcaCalls) expect(arg(c, '--worktree')).toBe(`path:${ROOT}`)
  expect(w.orcaCalls.map(c => arg(c, '--comment')).join()).toContain('developing')
})

test('outside Orca, the workflow makes no Orca call', async ($, on) => {
  const w = engine(on, { wf: null })
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(w.orcaCalls).toEqual([])
})

test('a change of state sends only what changed, and a save with no change sends nothing', async ($, on) => {
  const w = engine(on, { wf: { state: 'reviewing', evidence: {} }, pr: { draft: true } })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  w.orcaCalls.length = 0
  await tool($, 'started', { issue: 7 })
  expect(w.orcaCalls).toEqual([])
  await tool($, 'finishedReview', { remembered: 'nothing: small', review: 'passed', deadcode: 'skipped: none' })
  expect(w.state()?.state).toBe('ci')
  expect(w.orcaCalls.length).toBe(1)
  const c = w.orcaCalls[0]!
  expect(arg(c, '--comment')).toContain('ci')
  expect(c).not.toContain('--display-name')
  expect(c).not.toContain('--workspace-status')
})

test('blocked flags the workspace and keeps its status, and unblocked clears the flag', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  await start($, w)
  await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  w.orcaCalls.length = 0
  await tool($, 'blocked', { message: 'needs a key' })
  expect(arg(w.orcaCalls[0], '--comment')).toBe('Blocked: needs a key')
  expect(w.orcaCalls[0]).toContain('--unread')
  expect(w.orcaCalls[0]).not.toContain('--workspace-status')
  w.orcaCalls.length = 0
  await tool($, 'unblocked', { message: 'key added' })
  expect(w.orcaCalls[0]).toContain('--read')
  expect(arg(w.orcaCalls[0], '--comment')).toContain('developing')
})

test('done moves the workspace to in-review and flags it, with the message of the agent', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } }, shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  const r = await tool($, 'done', { message: 'finished the sub function', remembered: 'nothing: no lesson' })
  expect(r.isError).toBe(false)
  const c = w.orcaCalls.at(-1)!
  expect(arg(c, '--workspace-status')).toBe('in-review')
  expect(c).toContain('--unread')
  expect(arg(c, '--comment')).toContain('finished the sub function')
})

test('the heartbeat that sees the PR merged after done moves the workspace to completed', async ($, on) => {
  const w = engine(on, { wf: { state: 'done', evidence: {}, shortName: 'add-sub' }, pr: { state: 'closed', merged: true } })
  inOrca(w)
  await start($, w)
  await idle(w)
  expect(w.state()?.prsClosed).toBe(true)
  expect(arg(w.orcaCalls.at(-1), '--workspace-status')).toBe('completed')
})

test('a failed Orca call does not stop the tool, shows a toast with its output, and is sent again at the next save', async ($, on) => {
  const w = engine(on, { wf: null })
  inOrca(w)
  w.s.orcaFails = 'orca is not running'
  await start($, w)
  const r = await tool($, 'started', { issue: 7, shortName: 'add-sub' })
  expect(r.isError).toBe(false)
  expect(w.toasts.join()).toContain('orca is not running')
  expect(w.toasts.join()).toContain('#7')
  w.s.orcaFails = ''
  w.orcaCalls.length = 0
  await tool($, 'started', { issue: 7 })
  // The workflow has PR #12 now, so the workspace takes the PR's number.
  expect(w.orcaCalls.flat().join(' ')).toContain('--display-name 12-add-sub')
})

test('a project that commits to its base branch keeps the name of its main checkout', async ($, on) => {
  const w = engine(on, { wf: { direct: true, state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await start($, w)
  await tool($, 'blocked', { message: 'needs a key' })
  expect(w.orcaCalls.flat()).not.toContain('--display-name')
})

test('a worktree follow-up files one issue and starts one worker in a new workspace named <issue>-<short name>', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'worktree', message: 'Tidy: the old Config loader\nbody' })
  expect(w.gh.filter(c => c.includes('issue-new')).length).toBe(1)
  const started = workerStarts(w)
  expect(started.length).toBe(1)
  expect(arg(started[0], '--worktree')).toBe('new-top-level')
  expect(arg(started[0], '--name')).toBe('31-tidy-the-old-config-loader')
  expect(started[0]).toContain('--keep-open')
  expect(arg(started[0], '--spec')).toContain('shortName "tidy-the-old-config-loader"')
  expect(arg(started[0], '--spec')).toContain('body')
  expect(w.gh.some(c => c.includes('subissues link 7 31'))).toBe(true)
  expect(r.text).toContain('run_1')
})

test('the old mode name orca_workspace is refused, and the refusal names worktree', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'orca_workspace', message: 'Tidy\nbody' })
  expect(r.text).toContain('worktree')
  expect(r.text).toContain('Refused')
  expect(w.gh.filter(c => c.includes('issue-new'))).toEqual([])
  expect(workerStarts(w)).toEqual([])
})

test('a worktree follow-up with issues files nothing and starts one worker that carries them all on one PR', async ($, on) => {
  const w = await onDeveloping($, on)
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [200, 166], message: 'Retire the runner\nThe brief' })
  expect(r.text).not.toContain('Refused')
  expect(w.gh.filter(c => c.includes('issue-new'))).toEqual([])
  const started = workerStarts(w)
  expect(started.length).toBe(1)
  expect(arg(started[0], '--name')).toBe('166-retire-the-runner')
  const spec = arg(started[0], '--spec')!
  expect(spec).toContain('The brief')
  expect(spec).toContain('issue 166')
  expect(spec).toContain('#200')
  expect(spec).toContain('same worktree and PR')
  expect(w.gh.some(c => c.includes('subissues link 7 166'))).toBe(true)
  expect(w.gh.some(c => c.includes('subissues link 7 200'))).toBe(true)
  expect(r.text).toContain('/issues/166')
  expect(r.text).toContain('/issues/200')
})

test('issues with a closed or unreadable issue are refused by number, and nothing starts', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.issueReadsFor = { 200: [{ state: 'closed', title: 'Old' }], 201: ['Could not resolve to an issue'] }
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166, 200, 201], message: 'Stage\nbrief' })
  expect(r.text).toContain('Refused')
  expect(r.text).toContain('#200 is closed')
  expect(r.text).toContain('#201')
  expect(r.text).toContain('Could not resolve')
  expect(workerStarts(w)).toEqual([])
  expect(w.gh.some(c => c.includes('subissues link'))).toBe(false)
})

test('bad issues are refused before any read: another mode, an empty list, a non-number and the calling issue', async ($, on) => {
  const w = await onDeveloping($, on)
  const reads = () => w.gh.filter(c => c.includes('issue-read 166')).length
  const before = reads()
  const refused = async (args: Record<string, unknown>, says: string) => {
    const r = await tool($, 'followUp', { message: 'Stage\nbrief', ...args })
    expect(r.text).toContain('Refused')
    expect(r.text).toContain(says)
  }
  await refused({ mode: 'issue_only', issues: [166] }, 'worktree')
  await refused({ mode: 'worktree', issues: [] }, 'issues')
  await refused({ mode: 'worktree', issues: ['abc'] }, 'abc')
  await refused({ mode: 'worktree', issues: [166, 7] }, '#7')
  expect(reads()).toBe(before)
  expect(workerStarts(w)).toEqual([])
})

test('the same worktree call again starts no second worker, and an issue with a worker is not started by another call', async ($, on) => {
  const w = await onDeveloping($, on)
  await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  const again = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(again.text).not.toContain('Refused')
  expect(again.text).toContain('ctx_1')
  expect(workerStarts(w).length).toBe(1)
  const other = await tool($, 'followUp', { mode: 'worktree', issues: [166, 200], message: 'Another\nbrief' })
  expect(other.text).toContain('Refused')
  expect(other.text).toContain('#166')
  expect(workerStarts(w).length).toBe(1)
})

test('a sub-issue link that fails is said with its repair, and the worker still counts as started', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.linkFails = 'Issue may not contain duplicate sub-issues'
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\\nbrief' })
  expect(r.text).toContain('#166 is not a sub-issue of #7')
  expect(r.text).toContain('duplicate sub-issues')
  expect(r.text).toContain('subissues link 7 166')
  expect(r.text).toContain('ctx_1')
})

test('a worker that does not start is refused with what Orca said, by its receipt and not its exit code, and a retry starts it', async ($, on) => {
  const w = await onDeveloping($, on)
  w.s.workerReceipt = { ok: true, result: { state: 'failed', lastError: 'agent_prompt_blocked', failedStage: 'launch', recovery: 'Answer the prompt' } }
  const r = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(r.text).toContain('agent_prompt_blocked')
  expect(r.text).toContain('Answer the prompt')
  expect(r.text).toContain('#166')
  expect(w.gh.some(c => c.includes('subissues link'))).toBe(false)
  w.s.workerReceipt = undefined
  const retry = await tool($, 'followUp', { mode: 'worktree', issues: [166], message: 'Stage\nbrief' })
  expect(retry.text).not.toContain('Refused')
  expect(workerStarts(w).length).toBe(2)
})

test('a followUp subagent commits and pushes in its own worktree through checkpoint, with the checks', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  expect(w.spawns[0]!.cwd).toBe(CLAIMED)
  expect(w.spawns[0]!.prompt).toContain('mcp__ndev__checkpoint')
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.text).not.toContain('Refused')
  expect(r.isError).toBe(false)
  expect(w.s.commitDirs).toEqual([CLAIMED])
  expect(w.pushes).toHaveLength(1)
  expect(w.steps.join()).toContain('fast-checks.sh')
  expect(w.steps.join()).toContain('pre-commit-check.sh')
  expect(w.steps.join()).toContain('pre-push-check.sh')
})

test('a raw commit by a followUp subagent is refused and names its issue, its worktree and the tool', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  const r = await $.tool.call({ tool: 'Bash', command: `git -C ${CLAIMED} commit -m x`, agentId: 'agent-31' } as never) as { deny?: string }
  expect(r.deny).toContain('#31')
  expect(r.deny).toContain(CLAIMED)
  expect(r.deny).toContain('mcp__ndev__checkpoint')
})

test('a followUp subagent adds its change types to its own record', async ($, on) => {
  const w = engine(on, { names: ['server/a.py'] })
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  expect((await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], changeTypes: ['tests'], worktree: CLAIMED })).isError).toBe(false)
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.changeTypes).toEqual(['tests', 'backend'])
  expect(w.state()?.changeTypes).toBeUndefined()
  expect((await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], changeTypes: ['frontend'], worktree: CLAIMED })).text).toContain('web, backend')
})

test('a followUp subagent in a worktree with no check scripts is refused, is told the repair, and commits nothing', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.scripts = false
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.isError).toBe(true)
  expect(r.text).toContain(`${CLAIMED}`)
  expect(r.text).toContain('scripts/ndev/workflow/fast-checks.sh')
  expect(r.text).toContain('fast-checks-template.sh')
  expect(w.s.commitDirs).toEqual([])
})

test('the record of the main workflow stays on its issue, and its Orca workspace does not take the follow-up', async ($, on) => {
  const w = engine(on, { wf: { state: 'developing', shortName: 'add-sub' } })
  inOrca(w)
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], ...AGENT })
  expect(w.state()!.issue).toBe(7)
  expect(w.state()!.state).toBe('developing')
  expect(JSON.parse(w.files.get(`${CLAIMED}/.neil-dev.issue-31.json`)!).workflow.issue).toBe(31)
  expect(JSON.stringify(w.orcaCalls)).not.toContain('"31"')
})

test('a followUp retry after a refused spawn reuses the worktree and says so', async ($, on) => {
  const w = engine(on)
  await start($, w)
  w.s.spawnDeny = 'no agents now'
  const first = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy\nbody' })
  expect(first.isError).toBe(true)
  expect(first.text).toContain('no agents now')
  w.s.spawnDeny = ''
  const again = await tool($, 'followUp', { mode: 'subagent', message: 'Tidy\nbody' })
  expect(again.isError).toBe(false)
  expect(w.spawns.at(-1)!.cwd).toBe(CLAIMED)
})

test('checkpoint refuses a worktree that followUp did not start, and names those it did', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], agentId: 'agent-31', worktree: '/elsewhere' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('/elsewhere')
  expect(r.text).toContain(CLAIMED)
  expect(w.s.commitDirs).toEqual([])
})

// The session can lose its link to the record that holds the followUp entry (a lost hooks worker, a
// restart). The agent's own record, which only followUp writes, still says that followUp started it.
test('a followUp agent commits through checkpoint when the session no longer sees the followUp entry: its own record says followUp started it', async ($, on) => {
  const w = engine(on, { files: { [`${CLAIMED}/.neil-dev.issue-31.json`]: JSON.stringify({ version: 1, issue: 31, workflow: flow({ issue: 31, root: CLAIMED, prs: [], owner: undefined, followUpOf: 7 }) }) } })
  await start($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 31, message: 'm', files: ['a.ts'], ...AGENT })
  expect(r.text).not.toContain('Refused')
  expect(r.isError).toBe(false)
  expect(w.s.commitDirs).toEqual([CLAIMED])
})

test('checkpoint still refuses a worktree whose record followUp did not write, and says where it looked', async ($, on) => {
  const elsewhere = '/claimed/issue-9'
  const w = engine(on, { files: { [`${elsewhere}/.neil-dev.issue-9.json`]: JSON.stringify({ version: 1, issue: 9, workflow: flow({ issue: 9, root: elsewhere, prs: [], owner: undefined }) }) } })
  await startFollowUp($, w)
  w.s.dirty = [' M a.ts']
  const r = await tool($, 'checkpoint', { issue: 9, message: 'm', files: ['a.ts'], agentId: 'agent-9', worktree: elsewhere })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('did not start an agent')
  expect(r.text).toContain(`${elsewhere}/.neil-dev.issue-9.json`)
  expect(r.text).toContain(ROOT)
  expect(r.text).toContain(CLAIMED)
  expect(w.s.commitDirs).toEqual([])
})

test('the worktree of a followUp agent is on the record, so another session can read it after a restart', async ($, on) => {
  const w = engine(on)
  await startFollowUp($, w)
  expect(w.state()?.followUps?.[0]?.worktree).toBe(CLAIMED)
})

test('checks pending at done: the commit that done waits for is on the record, so a new session watches it', async ($, on) => {
  const w = engine(on, { wf: { state: 'finishing', evidence: { checks: { sha: SHA, text: 'green' } } }, checks: RUNNING })
  await start($, w)
  await tool($, 'done', { message: 'm', remembered: 'nothing: small' })
  expect(w.state()?.doneWaitsFor).toBe(SHA)
})

test('a helper that followUp did not start still cannot call checkpoint', async ($, on) => {
  const w = engine(on)
  await start($, w)
  const r = await tool($, 'checkpoint', { message: 'm', files: ['a.ts'], agentId: 'helper-1' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('only the main agent')
})
